import { createAction, Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";
import { lineProp } from "../common/pickers";
import { lifecycleOf, type FloorOrder } from "../common/types";
import { lifecycleField, orderFields } from "../common/output-schemas";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const listOrders = createAction({
  auth: umhAuth,
  name: "list_orders",
  displayName: "List orders",
  description:
    "Lists production orders on the floor, newest first, optionally filtered by line, part or status.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: {
    fields: [
      { key: "count", label: "Count", format: "number" as const },
      {
        key: "orders",
        label: "Orders",
        listItems: [...orderFields, lifecycleField],
      },
    ],
  },
  props: {
    line_instance_id: lineProp("Only orders dispatched to this line", false),
    product_id: Property.ShortText({
      displayName: "Part number",
      description: "Exact match, e.g. FRAME-WELD-A",
      required: false,
    }),
    status: Property.StaticMultiSelectDropdown({
      displayName: "Status",
      description: "Any status when left empty",
      required: false,
      options: {
        options: [
          { label: "Created", value: "CREATED" },
          { label: "Released", value: "RELEASED" },
          { label: "In progress", value: "IN_PROGRESS" },
          { label: "Closed", value: "CLOSED" },
          { label: "Cancelled", value: "CANCELLED" },
        ],
      },
    }),
    limit: Property.Number({
      displayName: "Max results",
      description: `Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}`,
      required: false,
    }),
  },
  async run(context) {
    const { line_instance_id, product_id, status, limit } = context.propsValue;
    // Every filter is applied here rather than in a query string: the floor's
    // /api/orders takes no parameters at all, so a filter that looked like it
    // reached the server would quietly do nothing.
    const wanted = new Set(Array.isArray(status) ? status : []);
    const capped = Math.min(
      Math.max(typeof limit === "number" ? limit : DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    const orders = await clientForContext(context).listOrders();
    const matched = orders
      .filter((order: FloorOrder) => {
        if (line_instance_id && order.line_instance_id !== line_instance_id) {
          return false;
        }
        if (product_id && order.product_id !== product_id) return false;
        if (wanted.size > 0 && !wanted.has(order.status)) return false;
        return true;
      })
      // The floor returns its own insertion order; a run list is read
      // newest-first, and `created_at` is the only field that survives a
      // restart. Missing timestamps sort last rather than crashing the compare.
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
      .slice(0, capped);
    return {
      count: matched.length,
      orders: matched.map((order) => ({
        ...order,
        lifecycle: lifecycleOf(order.status),
      })),
    };
  },
});
