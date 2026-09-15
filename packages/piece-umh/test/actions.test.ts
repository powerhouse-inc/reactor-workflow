import { afterEach, describe, expect, it } from "vitest";
import { cancelOrder } from "../src/lib/actions/cancel-order";
import { createOrder } from "../src/lib/actions/create-order";
import { getOrderActuals } from "../src/lib/actions/get-order-actuals";
import { listMachines } from "../src/lib/actions/list-machines";
import { listOrders } from "../src/lib/actions/list-orders";
import { UmhApiError } from "../src/lib/common/errors";
import { contextFor, failure } from "./helpers";
import { machine, order, startMockUmh, type MockUmh } from "./mock-umh";

let mock: MockUmh | undefined;

afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

// `run` is typed against the Activepieces context; the tests build the members
// the action actually reads. The bundle-conformance test covers the real one.
type Runner = { run: (context: unknown) => Promise<unknown> };

describe("list orders", () => {
  it("filters by line, part and status, since the floor API takes no parameters", async () => {
    mock = await startMockUmh({
      orders: [
        order({ id: "a", line_instance_id: "automotive-welding-1", status: "IN_PROGRESS" }),
        order({ id: "b", line_instance_id: "window-frame-1", status: "IN_PROGRESS" }),
        order({ id: "c", line_instance_id: "automotive-welding-1", status: "CLOSED" }),
        order({ id: "d", line_instance_id: "automotive-welding-1", product_id: "WIN-LRG-B" }),
      ],
    });

    const result = (await (listOrders as unknown as Runner).run(
      contextFor(mock.baseUrl, {
        line_instance_id: "automotive-welding-1",
        product_id: "FRAME-WELD-A",
        status: ["IN_PROGRESS"],
      }),
    )) as { count: number; orders: { id: string }[] };

    expect(result.orders.map((entry) => entry.id)).toEqual(["a"]);
    expect(result.count).toBe(1);
  });

  it("returns the newest orders first and caps what it keeps", async () => {
    mock = await startMockUmh({
      orders: [
        order({ id: "older", created_at: "2026-09-01T00:00:00.000Z" }),
        order({ id: "newest", created_at: "2026-09-14T00:00:00.000Z" }),
        order({ id: "middle", created_at: "2026-09-07T00:00:00.000Z" }),
      ],
    });

    const result = (await (listOrders as unknown as Runner).run(
      contextFor(mock.baseUrl, { limit: 2 }),
    )) as { orders: { id: string }[] };

    expect(result.orders.map((entry) => entry.id)).toEqual(["newest", "middle"]);
  });

  it("carries the normalised lifecycle beside the floor's own spelling", async () => {
    mock = await startMockUmh({ orders: [order({ status: "CLOSED" })] });

    const result = (await (listOrders as unknown as Runner).run(
      contextFor(mock.baseUrl, {}),
    )) as { orders: { status: string; lifecycle: string }[] };

    expect(result.orders[0]).toMatchObject({
      status: "CLOSED",
      lifecycle: "COMPLETED",
    });
  });
});

describe("get order actuals", () => {
  it("reads the machines and reports the line's OEE", async () => {
    mock = await startMockUmh({
      orders: [order({ good_qty: 90, scrap_qty: 10 })],
      machines: [machine({ run_time_sec: 900, down_time_sec: 100, cycle_count: 90 })],
    });

    const result = (await (getOrderActuals as unknown as Runner).run(
      contextFor(mock.baseUrl, { order_id: "order-1", include_oee: true }),
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      orderId: "order-1",
      quantityCompleted: 90,
      quantityScrap: 10,
      qualityPct: 90,
      oeePct: 72.9,
      bottleneckMachine: "robot-welder-1",
      lifecycle: "RUNNING",
    });
  });

  it("does not read the machines when the OEE was not asked for", async () => {
    mock = await startMockUmh({
      orders: [order({ good_qty: 5 })],
      machines: [machine()],
    });

    const result = (await (getOrderActuals as unknown as Runner).run(
      contextFor(mock.baseUrl, { order_id: "order-1", include_oee: false }),
    )) as Record<string, unknown>;

    expect(result.oeePct).toBeNull();
    expect(mock.requests.map((entry) => entry.path)).not.toContain("/api/machines");
  });
});

describe("create order", () => {
  it("creates the order and returns the id the floor assigned", async () => {
    mock = await startMockUmh({ orders: [] });

    const result = (await (createOrder as unknown as Runner).run(
      contextFor(mock.baseUrl, {
        line_instance_id: "automotive-welding-1",
        product_id: "FRAME-WELD-A",
        planned_qty: 30,
        priority: 80,
      }),
    )) as { id: string; lifecycle: string };

    expect(result.id).toBe("order-1");
    expect(result.lifecycle).toBe("PENDING");
    expect(mock.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/orders",
      body: {
        product_id: "FRAME-WELD-A",
        line_instance_id: "automotive-welding-1",
        planned_qty: 30,
        priority: 80,
      },
    });
  });

  it("rejects a fractional quantity here, where the field has a name", async () => {
    mock = await startMockUmh({ orders: [] });

    const error = await failure(
      (createOrder as unknown as Runner).run(
        contextFor(mock.baseUrl, {
          line_instance_id: "automotive-welding-1",
          product_id: "FRAME-WELD-A",
          planned_qty: 2.5,
        }),
      ),
    );

    expect(error).toBeInstanceOf(UmhApiError);
    expect(error.message).toContain("whole number of pieces");
    // The floor was never asked: a 400 saying "invalid request body" would not
    // have told anyone which field was wrong.
    expect(mock.requests).toHaveLength(0);
  });

  it("omits priority entirely when none was given, leaving the floor to assign one", async () => {
    mock = await startMockUmh({ orders: [] });

    await (createOrder as unknown as Runner).run(
      contextFor(mock.baseUrl, {
        line_instance_id: "automotive-welding-1",
        product_id: "FRAME-WELD-A",
        planned_qty: 10,
      }),
    );

    expect(mock.requests.at(-1)?.body).not.toHaveProperty("priority");
  });
});

describe("cancel order", () => {
  it("echoes the order id back beside the floor's bare status", async () => {
    mock = await startMockUmh({ orders: [order({ id: "order-1" })] });

    const result = (await (cancelOrder as unknown as Runner).run(
      contextFor(mock.baseUrl, { order_id: "order-1" }),
    )) as Record<string, unknown>;

    expect(result).toEqual({ status: "cancelled", orderId: "order-1" });
  });
});

describe("list machines", () => {
  it("keeps only the machines on the line that was asked for", async () => {
    mock = await startMockUmh({
      machines: [
        machine({ id: "ours" }),
        machine({ id: "theirs", line_instance_id: "window-frame-1" }),
      ],
    });

    const result = (await (listMachines as unknown as Runner).run(
      contextFor(mock.baseUrl, { line_instance_id: "automotive-welding-1" }),
    )) as { count: number; machines: { id: string }[] };

    expect(result.machines.map((entry) => entry.id)).toEqual(["ours"]);
  });
});
