import { createAction, Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";
import { statusProp } from "../common/pickers";
import { lifecycleOf } from "../common/types";
import { lifecycleField, orderFields } from "../common/output-schemas";

export const setOrderStatus = createAction({
  auth: umhAuth,
  name: "set_order_status",
  displayName: "Set order status",
  description:
    "Moves an order to a status by hand — releasing it, or closing it early.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: { fields: [...orderFields, lifecycleField] },
  props: {
    order_id: Property.ShortText({
      displayName: "Order ID",
      required: true,
    }),
    status: statusProp("Status", true),
  },
  async run(context) {
    const { order_id, status } = context.propsValue;
    const order = await clientForContext(context).setOrderStatus(
      order_id,
      status,
    );
    return { ...order, lifecycle: lifecycleOf(order.status) };
  },
});
