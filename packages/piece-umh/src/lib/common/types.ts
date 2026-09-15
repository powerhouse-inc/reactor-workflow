// The floor API's own shapes, as observed on dh2k/machine-simulator-2:v1.1.0.

// Fields are optional where the API omits them rather than nulling them: an
// order carries no `closed_at` until it closes, and `started_at` only once the
// MES dispatches it. Everything a caller must not assume is typed accordingly.

/** `GET /api/orders`, `GET /api/orders/{id}`, and the `data` of order events. */
export interface FloorOrder {
  id: string;
  product_id: string;
  line_instance_id: string;
  line_template?: string;
  // CREATED | RELEASED | IN_PROGRESS | CLOSED | CANCELLED. Left as a string:
  // the floor is free to add one, and an unknown value must not break a read.
  status: string;
  planned_qty: number;
  good_qty: number;
  scrap_qty: number;
  priority?: number;
  created_at?: string;
  started_at?: string | null;
  closed_at?: string | null;
}

/** `GET /api/machines`. */
export interface FloorMachine {
  id: string;
  type?: string;
  role?: string;
  line_instance_id: string;
  // IDLE | RUNNING | MAINTENANCE | SETUP.
  state?: string;
  order_id?: string | null;
  operation_id?: string | null;
  cycle_count: number;
  good_count: number;
  scrap_count: number;
  // The machine's own clocks, which is what makes availability measurable
  // here — see `lineOee`.
  run_time_sec: number;
  down_time_sec: number;
  opcua_port?: number;
  tags?: Record<string, unknown>;
}

/** `GET /api/lines`. */
export interface FloorLine {
  instance_id: string;
  template_name?: string;
  domain?: string;
  machine_ids?: string[];
  recipes?: { product_id: string; description?: string }[];
}

/** `GET /api/orders/{id}/operations` — one row per machine stage. */
export interface FloorOperation {
  id: string;
  order_id: string;
  machine_id: string;
  stage?: number;
  status?: string;
  planned_cycle_time_ms?: number;
  good_qty?: number;
  scrap_qty?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

// What the floor's status vocabulary means, independent of its spelling.

// The floor says CREATED/RELEASED/IN_PROGRESS/CLOSED/CANCELLED; a consumer
// cares whether the work is waiting, running, done or abandoned. Mapping it
// here means a workflow never has to branch on five raw strings, and an
// unknown status degrades to UNKNOWN instead of being read as "done".
export type OrderLifecycle =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELLED"
  | "UNKNOWN";

export function lifecycleOf(status: string | null | undefined): OrderLifecycle {
  switch (status) {
    case "CREATED":
    case "RELEASED":
    case "PENDING":
    case "PLANNED":
    case "QUEUED":
      return "PENDING";
    case "IN_PROGRESS":
      return "RUNNING";
    case "CLOSED":
    case "COMPLETED":
      return "COMPLETED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "UNKNOWN";
  }
}
