import { createAction, Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";
import { orderActuals } from "../common/oee";
import { lifecycleOf } from "../common/types";
import {
  actualsFields,
  lifecycleField,
  orderFields,
} from "../common/output-schemas";

export const getOrderActuals = createAction({
  auth: umhAuth,
  name: "get_order_actuals",
  displayName: "Get order actuals",
  description:
    "Reads one order's counts and the OEE of the line running it — the evidence a run record is built from.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: {
    fields: [
      ...actualsFields,
      lifecycleField,
      { key: "order", label: "Order (raw)", children: orderFields },
    ],
  },
  props: {
    order_id: Property.ShortText({
      displayName: "Order ID",
      description: "The floor's UUID for the run",
      required: true,
    }),
    include_oee: Property.Checkbox({
      displayName: "Include OEE",
      description:
        "Reads the line's machine counters as well. Left off, availability, performance and OEE report null — not measured.",
      required: false,
      defaultValue: true,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    const { order_id, include_oee } = context.propsValue;
    const order = await client.getOrder(order_id);
    // Two requests, and the second one is the expensive one on a big floor;
    // a caller that only needs counts should not pay for it.
    const machines = include_oee === false ? undefined : await client.listMachines();
    return {
      ...orderActuals(order, machines, new Date().toISOString()),
      lifecycle: lifecycleOf(order.status),
      order,
    };
  },
});
