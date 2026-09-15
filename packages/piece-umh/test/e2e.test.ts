// The live suite: the piece against the real floor, not a mock of it.
//
//   docker compose -f test/e2e-compose.yml up -d
//   UMH_E2E_URL=http://localhost:18081 pnpm vitest run test/e2e.test.ts
//
// Skipped without UMH_E2E_URL, so a normal `pnpm test` never needs Docker.
// What it is here to catch is the half the mock cannot: the floor's real field
// names, its real status transitions, and whether an order actually moves.
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/lib/actions/create-order";
import { getOrderActuals } from "../src/lib/actions/get-order-actuals";
import { listLines } from "../src/lib/actions/list-lines";
import { checkUmhConnection } from "../src/lib/auth";
import { orderProgressed } from "../src/lib/triggers/order-triggers";
import { authFor, contextFor, MemoryStore } from "./helpers";

const baseUrl = process.env.UMH_E2E_URL;

type Runner = { run: (context: unknown) => Promise<unknown> };
type Hooks = {
  onEnable: (context: unknown) => Promise<void>;
  run: (context: unknown) => Promise<unknown[]>;
};

// The floor produces in real time. A two-piece order clears in well under this
// on the stock profile; the budget is generous so a slow CI host reports a
// failure that is real rather than one that is impatient.
const PROGRESS_BUDGET_MS = 180_000;
const POLL_EVERY_MS = 3_000;

async function waitFor<T>(
  attempt: () => Promise<T | undefined>,
  budgetMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await attempt();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
}

describe.skipIf(!baseUrl)("the piece against a live floor", () => {
  it("reports the size of the floor on the connection", async () => {
    const identity = (await checkUmhConnection({
      auth: authFor(baseUrl!),
    })) as { name: string; lineCount: number | null };

    expect(identity.lineCount).toBeGreaterThan(0);
    expect(identity.name).toMatch(/lines, .* machines @ /);
  });

  it("creates an order and watches the trigger follow it to completion", async () => {
    const lines = (await (listLines as unknown as Runner).run(
      contextFor(baseUrl!, {}),
    )) as { lines: { instance_id: string; recipes?: { product_id: string }[] }[] };
    // Any line that publishes a recipe can run one: the suite must not hard-code
    // a line name, because the profile decides which lines exist.
    const line = lines.lines.find((entry) => (entry.recipes ?? []).length > 0);
    expect(line, "the floor published no line with a recipe").toBeDefined();
    const part = line!.recipes![0].product_id;

    const store = new MemoryStore();
    const triggerContext = contextFor(
      baseUrl!,
      { line_instance_id: line!.instance_id },
      store,
    );
    // Enable first: everything already on the floor becomes "already seen", so
    // what the poll reports afterwards is this order and nothing else.
    await (orderProgressed as unknown as Hooks).onEnable(triggerContext);

    const created = (await (createOrder as unknown as Runner).run(
      contextFor(baseUrl!, {
        line_instance_id: line!.instance_id,
        product_id: part,
        planned_qty: 2,
      }),
    )) as { id: string; lifecycle: string };
    expect(created.id).toMatch(/[0-9a-f-]{8,}/);
    expect(created.lifecycle).toBe("PENDING");

    // The floor's MES dispatches on its own interval, then the machines run.
    const progressed = await waitFor(async () => {
      const items = (await (orderProgressed as unknown as Hooks).run(
        triggerContext,
      )) as { orderId: string; quantityCompleted: number; lifecycle: string }[];
      return items.find((item) => item.orderId === created.id);
    }, PROGRESS_BUDGET_MS);

    expect(progressed, "the floor never moved the order").toBeDefined();
    expect(progressed!.lifecycle).not.toBe("PENDING");

    const actuals = (await (getOrderActuals as unknown as Runner).run(
      contextFor(baseUrl!, { order_id: created.id, include_oee: true }),
    )) as Record<string, number | null | string>;

    expect(actuals.orderId).toBe(created.id);
    // The OEE factors come from the line's machines; on a floor that is
    // genuinely running, at least one machine is measurable.
    expect(actuals.availabilityPct).not.toBeNull();
    expect(Number(actuals.availabilityPct)).toBeGreaterThan(0);
    expect(Number(actuals.availabilityPct)).toBeLessThanOrEqual(100);
  }, PROGRESS_BUDGET_MS + 60_000);
});
