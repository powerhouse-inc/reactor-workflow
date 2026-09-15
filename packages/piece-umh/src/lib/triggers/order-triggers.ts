import {
  createTrigger,
  Property,
  TriggerStrategy,
} from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import type { UmhClient } from "../common/client";
import { clientFor, type StoreLike } from "../common/context";
import { orderActuals } from "../common/oee";
import { lineProp } from "../common/pickers";
import { orderEventFields } from "../common/output-schemas";
import { lifecycleOf, type FloorMachine, type FloorOrder } from "../common/types";

// One cursor per workflow: the host serves ctx.store at FLOW scope, so two
// workflows watching the same floor keep their own reading of it.
const CURSOR_KEY = "umh:order-cursor";

// The floor keeps every order it has ever run — thousands of them in the
// upstream demo, where a fake ERP mints one every 30 seconds. The cursor is
// rebuilt from each poll rather than accumulated, so it is bounded by what the
// floor currently reports; this cap bounds it again for a floor that reports
// far more than a workflow can be watching. Past it, the newest orders win,
// because an order nobody has looked at in thousands of orders' time is not the
// one a ledger is bound to.
const MAX_TRACKED_ORDERS = 2_000;

/** What the previous poll saw of one order. */
interface Reading {
  good_qty: number;
  scrap_qty: number;
  status: string;
}

interface Cursor {
  seen: Record<string, Reading>;
}

function readingOf(order: FloorOrder): Reading {
  return {
    good_qty: order.good_qty,
    scrap_qty: order.scrap_qty,
    status: order.status,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A cursor that cannot be read is treated as absent rather than fatal: the poll
// then reports nothing new and reseeds, which loses one cycle of changes. The
// alternative — throwing — stops the trigger until someone clears the store.
function parseCursor(value: unknown): Cursor {
  if (!isRecord(value) || !isRecord(value.seen)) return { seen: {} };
  const seen: Record<string, Reading> = {};
  for (const [id, reading] of Object.entries(value.seen)) {
    if (!isRecord(reading)) continue;
    const { good_qty, scrap_qty, status } = reading;
    if (
      typeof good_qty === "number" &&
      typeof scrap_qty === "number" &&
      typeof status === "string"
    ) {
      seen[id] = { good_qty, scrap_qty, status };
    }
  }
  return { seen };
}

function cursorFrom(orders: FloorOrder[]): Cursor {
  const tracked =
    orders.length <= MAX_TRACKED_ORDERS
      ? orders
      : [...orders]
          .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
          .slice(0, MAX_TRACKED_ORDERS);
  const seen: Record<string, Reading> = {};
  for (const order of tracked) seen[order.id] = readingOf(order);
  return { seen };
}

interface Filters {
  line_instance_id?: unknown;
  product_id?: unknown;
}

function matches(order: FloorOrder, filters: Filters): boolean {
  const line = filters.line_instance_id;
  const part = filters.product_id;
  if (typeof line === "string" && line !== "" && order.line_instance_id !== line) {
    return false;
  }
  if (typeof part === "string" && part !== "" && order.product_id !== part) {
    return false;
  }
  return true;
}

async function loadOrders(
  client: UmhClient,
  filters: Filters,
): Promise<FloorOrder[]> {
  const orders = await client.listOrders();
  return orders.filter((order) => matches(order, filters));
}

// Machines are read once per poll, not once per order: a floor with four lines
// answers /api/machines in one request, and a busy poll would otherwise make
// one request per changed order for the same fourteen rows.
async function loadMachines(
  client: UmhClient,
  includeOee: unknown,
): Promise<FloorMachine[] | undefined> {
  if (includeOee === false) return undefined;
  // A machine-counter failure must not cost the whole poll: the counts and the
  // status are still worth firing on, and the OEE factors then read null — the
  // same "not measured" a line with no configured cycle time produces.
  return client.listMachines().catch(() => undefined);
}

function itemFor(
  order: FloorOrder,
  machines: FloorMachine[] | undefined,
  previous: Reading | undefined,
  capturedAt: string,
): Record<string, unknown> {
  const changed = {
    good: previous ? previous.good_qty !== order.good_qty : false,
    scrap: previous ? previous.scrap_qty !== order.scrap_qty : false,
    status: previous ? previous.status !== order.status : false,
  };
  return {
    ...orderActuals(order, machines, capturedAt),
    lifecycle: lifecycleOf(order.status),
    changed,
    previous: previous ?? null,
    order,
    // The host fires one run per item and suppresses a repeated key for 30s
    // (trigger-drivers.ts). Keyed by the reading, not the order, so a genuine
    // second change inside that window still runs and a re-poll of the same
    // numbers does not.
    _dedupe_key: `${order.id}:${order.good_qty}:${order.scrap_qty}:${order.status}`,
  };
}

const sharedProps = {
  line_instance_id: lineProp("Only orders on this line", false),
  product_id: Property.ShortText({
    displayName: "Part number",
    description: "Only orders for this part, e.g. FRAME-WELD-A",
    required: false,
  }),
  include_oee: Property.Checkbox({
    displayName: "Include OEE",
    description:
      "Reads the line's machine counters on each poll. Left off, availability, performance and OEE report null — not measured.",
    required: false,
    defaultValue: true,
  }),
};

interface PollContext {
  auth?: unknown;
  propsValue: Record<string, unknown>;
  store: StoreLike;
}

// Seeding on enable is what stops a workflow from replaying the floor's whole
// history the moment it is switched on: everything already running is recorded
// as already seen, and the first run fires on the next actual change.
async function seed(context: PollContext): Promise<void> {
  const client = clientFor(context.auth);
  const orders = await loadOrders(client, context.propsValue);
  await context.store.put(CURSOR_KEY, cursorFrom(orders));
}

async function clear(context: PollContext): Promise<void> {
  await context.store.put(CURSOR_KEY, { seen: {} });
}

// The shape every one of these triggers has: read the floor, compare with the
// cursor, keep what `select` calls interesting, write the cursor back.
async function poll(
  context: PollContext,
  select: (order: FloorOrder, previous: Reading | undefined) => boolean,
): Promise<unknown[]> {
  const client = clientFor(context.auth);
  const orders = await loadOrders(client, context.propsValue);
  const cursor = parseCursor(await context.store.get(CURSOR_KEY));
  const interesting = orders.filter((order) =>
    select(order, cursor.seen[order.id]),
  );
  // Only fetched when something is worth firing on, so an idle floor costs one
  // request per poll rather than two.
  const machines =
    interesting.length > 0
      ? await loadMachines(client, context.propsValue.include_oee)
      : undefined;
  const capturedAt = new Date().toISOString();
  const items = interesting.map((order) =>
    itemFor(order, machines, cursor.seen[order.id], capturedAt),
  );
  // Written after the items are built, never before: a failure between the two
  // must leave the change unreported rather than silently consumed.
  await context.store.put(CURSOR_KEY, cursorFrom(orders));
  return items;
}

// The editor's "test trigger" runs against the live floor with a store of its
// own (the host prefixes it), so it must not depend on a cursor that a real
// poll would have written. It answers with the most recent orders instead —
// enough to wire the next step's expressions against real field names.
async function sample(
  context: PollContext,
  limit: number,
): Promise<unknown[]> {
  const client = clientFor(context.auth);
  const orders = await loadOrders(client, context.propsValue);
  const recent = [...orders]
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, limit);
  const machines = await loadMachines(client, context.propsValue.include_oee);
  const capturedAt = new Date().toISOString();
  return recent.map((order) =>
    itemFor(order, machines, undefined, capturedAt),
  );
}

const SAMPLE_ORDER: FloorOrder = {
  id: "6aa32fa3-0b1e-4a1f-9a4e-1f0f1e2d3c4b",
  product_id: "FRAME-WELD-A",
  line_instance_id: "automotive-welding-1",
  line_template: "automotive-welding",
  status: "IN_PROGRESS",
  planned_qty: 30,
  good_qty: 12,
  scrap_qty: 1,
  priority: 53,
  created_at: "2026-09-15T08:44:03.428Z",
  started_at: "2026-09-15T08:44:33.456Z",
  closed_at: null,
};

const sampleData = itemFor(
  SAMPLE_ORDER,
  undefined,
  { good_qty: 9, scrap_qty: 1, status: "IN_PROGRESS" },
  "2026-09-15T08:45:03.000Z",
);

export const orderProgressed = createTrigger({
  auth: umhAuth,
  name: "order_progressed",
  displayName: "Order progressed",
  description:
    "Fires when a floor order's good count, scrap count or status changes — one run per order per change, not per poll.",
  type: TriggerStrategy.POLLING,
  props: sharedProps,
  sampleData,
  outputSchema: { fields: orderEventFields },
  async onEnable(context) {
    await seed(context as unknown as PollContext);
  },
  async onDisable(context) {
    await clear(context as unknown as PollContext);
  },
  async run(context) {
    return poll(context as unknown as PollContext, (order, previous) => {
      if (previous) {
        return (
          previous.good_qty !== order.good_qty ||
          previous.scrap_qty !== order.scrap_qty ||
          previous.status !== order.status
        );
      }
      // First sighting of an order created since the last poll. It is only
      // worth a run if there is something to report: a freshly created order
      // with nothing counted has produced no evidence, and firing on it would
      // put an empty reading at the head of every trail.
      return (
        order.good_qty > 0 ||
        order.scrap_qty > 0 ||
        lifecycleOf(order.status) !== "PENDING"
      );
    });
  },
  async test(context) {
    return sample(context as unknown as PollContext, 5);
  },
});

export const orderClosed = createTrigger({
  auth: umhAuth,
  name: "order_closed",
  displayName: "Order closed",
  description:
    "Fires once when the floor finishes or cancels an order — the moment its final counts are the final counts.",
  type: TriggerStrategy.POLLING,
  props: sharedProps,
  sampleData: {
    ...sampleData,
    statusRaw: "CLOSED",
    lifecycle: "COMPLETED",
  },
  outputSchema: { fields: orderEventFields },
  async onEnable(context) {
    await seed(context as unknown as PollContext);
  },
  async onDisable(context) {
    await clear(context as unknown as PollContext);
  },
  async run(context) {
    return poll(context as unknown as PollContext, (order, previous) => {
      const now = lifecycleOf(order.status);
      if (now !== "COMPLETED" && now !== "CANCELLED") return false;
      // Already terminal when the cursor last looked (including at enable
      // time), so this is not the transition — it is the same closed order
      // being re-read on every poll.
      if (!previous) return true;
      const before = lifecycleOf(previous.status);
      return before !== "COMPLETED" && before !== "CANCELLED";
    });
  },
  async test(context) {
    return sample(context as unknown as PollContext, 5);
  },
});

export const newOrder = createTrigger({
  auth: umhAuth,
  name: "new_order",
  displayName: "New order",
  description:
    "Fires when an order appears on the floor that was not there at the previous poll.",
  type: TriggerStrategy.POLLING,
  props: sharedProps,
  sampleData: {
    ...sampleData,
    statusRaw: "CREATED",
    lifecycle: "PENDING",
  },
  outputSchema: { fields: orderEventFields },
  async onEnable(context) {
    await seed(context as unknown as PollContext);
  },
  async onDisable(context) {
    await clear(context as unknown as PollContext);
  },
  async run(context) {
    return poll(
      context as unknown as PollContext,
      (_order, previous) => previous === undefined,
    );
  },
  async test(context) {
    return sample(context as unknown as PollContext, 5);
  },
});
