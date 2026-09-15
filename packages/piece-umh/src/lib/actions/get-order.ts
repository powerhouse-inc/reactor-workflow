import { createAction, Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";
import { lifecycleOf } from "../common/types";
import { lifecycleField, orderFields } from "../common/output-schemas";

export const getOrder = createAction({
  auth: umhAuth,
  name: "get_order",
  displayName: "Get order",
  description: "Fetches one production order by its floor id.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: { fields: [...orderFields, lifecycleField] },
  props: {
    order_id: Property.ShortText({
      displayName: "Order ID",
      description:
        "The floor's UUID, e.g. {{trigger.payload.orderId}} or a ledger's bound order id",
      required: true,
    }),
  },
  async run(context) {
    const order = await clientForContext(context).getOrder(
      context.propsValue.order_id,
    );
    return { ...order, lifecycle: lifecycleOf(order.status) };
  },
});
