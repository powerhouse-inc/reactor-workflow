import { createAction, Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";
import { UmhApiError } from "../common/errors";
import { lineProp, partProp } from "../common/pickers";
import { lifecycleOf } from "../common/types";
import { lifecycleField, orderFields } from "../common/output-schemas";

export const createOrder = createAction({
  auth: umhAuth,
  name: "create_order",
  displayName: "Create order",
  description:
    "Creates a production order on the floor and returns it, including the id the floor assigned.",
  audience: "both",
  // Deliberately not idempotent: two runs make two orders, and the floor has
  // no natural key to collapse them on. A workflow that can re-run must guard
  // this step itself.
  aiMetadata: { idempotent: false },
  outputSchema: { fields: [...orderFields, lifecycleField] },
  props: {
    line_instance_id: lineProp("The line that will run the order", true),
    product_id: partProp("The part to build, from the line's recipes", true),
    planned_qty: Property.Number({
      displayName: "Quantity",
      description: "How many pieces the floor should build",
      required: true,
    }),
    priority: Property.Number({
      displayName: "Priority",
      description:
        "Higher runs sooner. Left empty, the floor assigns its own.",
      required: false,
    }),
  },
  async run(context) {
    const { line_instance_id, product_id, planned_qty, priority } =
      context.propsValue;
    // The floor answers 400 for a non-integer quantity, and a fractional one is
    // a mistake rather than a rounding question — say so here, where the field
    // is named, instead of relaying "invalid request body".
    if (!Number.isInteger(planned_qty) || planned_qty <= 0) {
      throw new UmhApiError(
        `Quantity must be a whole number of pieces, got ${String(planned_qty)}`,
        { category: "validation" },
      );
    }
    if (priority !== undefined && !Number.isInteger(priority)) {
      throw new UmhApiError(
        `Priority must be a whole number, got ${String(priority)}`,
        { category: "validation" },
      );
    }
    const order = await clientForContext(context).createOrder({
      product_id,
      line_instance_id,
      planned_qty,
      ...(typeof priority === "number" ? { priority } : {}),
    });
    return { ...order, lifecycle: lifecycleOf(order.status) };
  },
});
