// The poller's behaviour, which is the whole point of the piece: one run per
// order per change, nothing replayed, nothing invented.
import { afterEach, describe, expect, it } from "vitest";
import {
  newOrder,
  orderClosed,
  orderProgressed,
} from "../src/lib/triggers/order-triggers";
import { contextFor, MemoryStore } from "./helpers";
import { machine, order, startMockUmh, type MockUmh } from "./mock-umh";

let mock: MockUmh | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

// The hooks are typed against the Activepieces trigger context; the tests build
// the members they actually read. The bundle-conformance test covers the real
// one.
type Hooks = {
  onEnable: (context: unknown) => Promise<void>;
  onDisable: (context: unknown) => Promise<void>;
  run: (context: unknown) => Promise<unknown[]>;
  test: (context: unknown) => Promise<unknown[]>;
};

const progressed = orderProgressed as unknown as Hooks;
const closed = orderClosed as unknown as Hooks;
const created = newOrder as unknown as Hooks;

interface Item {
  orderId: string;
  quantityCompleted: number;
  qualityPct: number | null;
  oeePct: number | null;
  lifecycle: string;
  statusRaw: string;
  changed: { good: boolean; scrap: boolean; status: boolean };
  previous: { good_qty: number } | null;
  _dedupe_key: string;
}

describe("order progressed", () => {
  it("does not replay the floor's history when the workflow is enabled", async () => {
    // Enabling a workflow against a floor with thousands of finished orders
    // must not write thousands of runs.
    mock = await startMockUmh({
      orders: [order({ id: "a", good_qty: 5 }), order({ id: "b", good_qty: 9 })],
    });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, {}, store);

    await progressed.onEnable(context);
    const items = await progressed.run(context);

    expect(items).toEqual([]);
  });

  it("fires once when the counts move, and not again until they move again", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a", good_qty: 5 })] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await progressed.onEnable(context);

    mock.state.orders = [order({ id: "a", good_qty: 8, scrap_qty: 1 })];
    const first = (await progressed.run(context)) as Item[];
    const second = (await progressed.run(context)) as Item[];

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      orderId: "a",
      quantityCompleted: 8,
      changed: { good: true, scrap: true, status: false },
      previous: { good_qty: 5 },
    });
    expect(second).toEqual([]);
  });

  it("fires on a status change even when nothing was produced", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a", status: "CREATED", good_qty: 0 })] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await progressed.onEnable(context);

    mock.state.orders = [order({ id: "a", status: "IN_PROGRESS", good_qty: 0 })];
    const items = (await progressed.run(context)) as Item[];

    expect(items).toHaveLength(1);
    expect(items[0].changed).toMatchObject({ status: true, good: false });
  });

  it("stays quiet about an order created since the last poll that has produced nothing", async () => {
    // A freshly created order carries no evidence; firing on it would put an
    // empty reading at the head of every trail.
    mock = await startMockUmh({ orders: [] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await progressed.onEnable(context);

    mock.state.orders = [order({ id: "new", status: "CREATED", good_qty: 0, scrap_qty: 0 })];

    expect(await progressed.run(context)).toEqual([]);
  });

  it("does report an order created since the last poll that is already running", async () => {
    mock = await startMockUmh({ orders: [] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await progressed.onEnable(context);

    mock.state.orders = [order({ id: "new", status: "IN_PROGRESS", good_qty: 3 })];
    const items = (await progressed.run(context)) as Item[];

    expect(items).toHaveLength(1);
    expect(items[0].previous).toBeNull();
  });

  it("keys the dedupe on the reading, so the host suppresses a re-poll but not a real change", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a", good_qty: 1 })] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await progressed.onEnable(context);

    mock.state.orders = [order({ id: "a", good_qty: 2 })];
    const [first] = (await progressed.run(context)) as Item[];
    mock.state.orders = [order({ id: "a", good_qty: 3 })];
    const [second] = (await progressed.run(context)) as Item[];

    expect(first._dedupe_key).toBe("a:2:0:IN_PROGRESS");
    expect(second._dedupe_key).toBe("a:3:0:IN_PROGRESS");
  });

  it("reads the machines once per poll, not once per changed order", async () => {
    mock = await startMockUmh({
      orders: [order({ id: "a", good_qty: 1 }), order({ id: "b", good_qty: 1 })],
      machines: [machine({ run_time_sec: 900, down_time_sec: 100, cycle_count: 90 })],
    });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, {}, store);
    await progressed.onEnable(context);

    mock.state.orders = [
      order({ id: "a", good_qty: 9, scrap_qty: 1 }),
      order({ id: "b", good_qty: 8, scrap_qty: 2 }),
    ];
    mock.requests.length = 0;
    const items = (await progressed.run(context)) as Item[];

    expect(items).toHaveLength(2);
    expect(
      mock.requests.filter((entry) => entry.path === "/api/machines"),
    ).toHaveLength(1);
    expect(items[0].oeePct).not.toBeNull();
  });

  it("costs one request on an idle floor", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a" })], machines: [machine()] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, {}, store);
    await progressed.onEnable(context);
    mock.requests.length = 0;

    await progressed.run(context);

    expect(mock.requests.map((entry) => entry.path)).toEqual(["/api/orders"]);
  });

  it("still fires when the machine counters cannot be read, with OEE unmeasured", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a", good_qty: 1 })], machines: [machine()] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, {}, store);
    await progressed.onEnable(context);

    mock.state.orders = [order({ id: "a", good_qty: 4 })];
    mock.failNext("/api/machines", 500);
    const items = (await progressed.run(context)) as Item[];

    expect(items).toHaveLength(1);
    expect(items[0].quantityCompleted).toBe(4);
    expect(items[0].oeePct).toBeNull();
  });

  it("ignores orders on another line when a line filter is set", async () => {
    mock = await startMockUmh({
      orders: [order({ id: "ours", good_qty: 1 }), order({ id: "theirs", line_instance_id: "window-frame-1", good_qty: 1 })],
    });
    const store = new MemoryStore();
    const context = contextFor(
      mock.baseUrl,
      { line_instance_id: "automotive-welding-1", include_oee: false },
      store,
    );
    await progressed.onEnable(context);

    mock.state.orders = [
      order({ id: "ours", good_qty: 5 }),
      order({ id: "theirs", line_instance_id: "window-frame-1", good_qty: 5 }),
    ];
    const items = (await progressed.run(context)) as Item[];

    expect(items.map((item) => item.orderId)).toEqual(["ours"]);
  });
});

describe("order closed", () => {
  it("fires on the transition and never again", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a", status: "IN_PROGRESS", good_qty: 29 })] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await closed.onEnable(context);

    mock.state.orders = [
      order({ id: "a", status: "CLOSED", good_qty: 30, closed_at: "2026-09-15T09:00:00.000Z" }),
    ];
    const first = (await closed.run(context)) as Item[];
    const second = (await closed.run(context)) as Item[];

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ lifecycle: "COMPLETED", statusRaw: "CLOSED" });
    expect(second).toEqual([]);
  });

  it("says nothing about an order that was already closed when the workflow was enabled", async () => {
    mock = await startMockUmh({
      orders: [order({ id: "a", status: "CLOSED", closed_at: "2026-09-01T00:00:00.000Z" })],
    });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);

    await closed.onEnable(context);

    expect(await closed.run(context)).toEqual([]);
  });

  it("treats a cancelled order as closed — the counts are final either way", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a", status: "IN_PROGRESS" })] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await closed.onEnable(context);

    mock.state.orders = [order({ id: "a", status: "CANCELLED" })];
    const items = (await closed.run(context)) as Item[];

    expect(items).toHaveLength(1);
    expect(items[0].lifecycle).toBe("CANCELLED");
  });
});

describe("new order", () => {
  it("fires for an order that was not there before, whatever its counts", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a" })] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await created.onEnable(context);

    mock.state.orders = [order({ id: "a" }), order({ id: "b", status: "CREATED", good_qty: 0 })];
    const items = (await created.run(context)) as Item[];

    expect(items.map((item) => item.orderId)).toEqual(["b"]);
  });
});

describe("test hook", () => {
  it("answers with recent orders without depending on a cursor", async () => {
    // The editor's "test trigger" runs with a store of its own, so it cannot
    // rely on a cursor a real poll would have written.
    mock = await startMockUmh({
      orders: [
        order({ id: "old", created_at: "2026-09-01T00:00:00.000Z" }),
        order({ id: "new", created_at: "2026-09-14T00:00:00.000Z" }),
      ],
    });
    const context = contextFor(mock.baseUrl, { include_oee: false }, new MemoryStore());

    const items = (await progressed.test(context)) as Item[];

    expect(items.map((item) => item.orderId)).toEqual(["new", "old"]);
  });
});

describe("disable", () => {
  it("clears the cursor so a re-enable starts from the floor as it is then", async () => {
    mock = await startMockUmh({ orders: [order({ id: "a", good_qty: 5 })] });
    const store = new MemoryStore();
    const context = contextFor(mock.baseUrl, { include_oee: false }, store);
    await progressed.onEnable(context);

    await progressed.onDisable(context);

    expect(store.entries.get("umh:order-cursor")).toEqual({ seen: {} });
  });
});
