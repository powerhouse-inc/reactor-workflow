import { createAction, Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";

export const cancelOrder = createAction({
  auth: umhAuth,
  name: "cancel_order",
  displayName: "Cancel order",
  description:
    "Cancels an order on the floor. The order keeps its counts and its id; only its status changes.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: {
    fields: [
      { key: "status", label: "Result", description: 'e.g. "cancelled"' },
      { key: "orderId", label: "Order ID" },
    ],
  },
  props: {
    order_id: Property.ShortText({
      displayName: "Order ID",
      required: true,
    }),
  },
  async run(context) {
    const { order_id } = context.propsValue;
    const result = await clientForContext(context).cancelOrder(order_id);
    // The floor answers {"status":"cancelled"} and nothing else; echoing the id
    // back saves the next step from carrying it separately.
    return { ...result, orderId: order_id };
  },
});
