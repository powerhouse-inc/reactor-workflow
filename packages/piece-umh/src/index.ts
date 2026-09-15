import { PieceCategory } from "@activepieces/shared";
import { createPiece } from "@activepieces/pieces-framework";
import { checkUmhConnection, umhAuth } from "./lib/auth";
import { cancelOrder } from "./lib/actions/cancel-order";
import { createOrder } from "./lib/actions/create-order";
import { customApiCall } from "./lib/actions/custom-api-call";
import { getOrder } from "./lib/actions/get-order";
import { getOrderActuals } from "./lib/actions/get-order-actuals";
import { listLines } from "./lib/actions/list-lines";
import { listMachines } from "./lib/actions/list-machines";
import { listOrders } from "./lib/actions/list-orders";
import { setOrderStatus } from "./lib/actions/set-order-status";
import { UMH_LOGO } from "./lib/logo";
import {
  newOrder,
  orderClosed,
  orderProgressed,
} from "./lib/triggers/order-triggers";

export const umh = createPiece({
  displayName: "UMH Factory Floor",
  description:
    "Read a United Manufacturing Hub factory floor: production orders, machine counters and derived OEE, plus creating, releasing and closing orders.",
  logoUrl: UMH_LOGO,
  authors: ["powerhouse-inc"],
  categories: [PieceCategory.BUSINESS_INTELLIGENCE],
  minimumSupportedRelease: "0.30.0",
  auth: umhAuth,
  actions: [
    listOrders,
    getOrder,
    getOrderActuals,
    createOrder,
    setOrderStatus,
    cancelOrder,
    listLines,
    listMachines,
    customApiCall,
  ],
  triggers: [orderProgressed, orderClosed, newOrder],
});

// The reactor's checkConnection mutation calls `piece.checkConnection(ctx)` if
// the piece declares one, and records its label on the connection document.
// Not part of the Activepieces surface (real AP never calls it), and the host
// tolerates its absence — declaring it is what gives the connection a status
// and an account label.
(
  umh as unknown as {
    checkConnection: (context: { auth?: unknown }) => Promise<unknown>;
  }
).checkConnection = checkUmhConnection;

export { umhAuth };
export default umh;
