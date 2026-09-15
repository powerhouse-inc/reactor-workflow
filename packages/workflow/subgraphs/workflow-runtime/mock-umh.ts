// A stand-in for the floor API, with the details that actually bite: a
// collection answers `null` when empty, an unknown order is a 404 carrying
// {"error": ...}, and the counters only move when a test says so.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FloorLine, FloorMachine, FloorOrder } from "../src/lib/common/types";

export interface MockState {
  orders: FloorOrder[] | null;
  machines: FloorMachine[] | null;
  lines: FloorLine[] | null;
  health: { status: string };
  simulation: Record<string, number>;
}

export interface MockRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface MockUmh {
  readonly baseUrl: string;
  readonly state: MockState;
  readonly requests: MockRequest[];
  /** Fails the next N requests to this path with the given status. */
  failNext(path: string, status: number, body?: unknown): void;
  close(): Promise<void>;
}

export function order(overrides: Partial<FloorOrder> = {}): FloorOrder {
  return {
    id: "order-1",
    product_id: "FRAME-WELD-A",
    line_instance_id: "automotive-welding-1",
    line_template: "automotive-welding",
    status: "IN_PROGRESS",
    planned_qty: 30,
    good_qty: 0,
    scrap_qty: 0,
    priority: 50,
    created_at: "2026-09-15T08:00:00.000Z",
    started_at: "2026-09-15T08:00:30.000Z",
    closed_at: null,
    ...overrides,
  };
}

export function machine(overrides: Partial<FloorMachine> = {}): FloorMachine {
  return {
    id: "robot-welder-1",
    line_instance_id: "automotive-welding-1",
    type: "robot-welder",
    state: "RUNNING",
    cycle_count: 100,
    good_count: 98,
    scrap_count: 2,
    run_time_sec: 900,
    down_time_sec: 100,
    tags: { cycle_time_ms: 9000 },
    ...overrides,
  };
}

export async function startMockUmh(
  initial: Partial<MockState> = {},
): Promise<MockUmh> {
  const state: MockState = {
    orders: initial.orders ?? [],
    machines: initial.machines ?? [],
    lines: initial.lines ?? [
      {
        instance_id: "automotive-welding-1",
        template_name: "automotive-welding",
        domain: "automotive",
        machine_ids: ["robot-welder-1"],
        recipes: [{ product_id: "FRAME-WELD-A", description: "Welded frame" }],
      },
    ],
    health: initial.health ?? { status: "ok" },
    simulation: initial.simulation ?? {
      line_count: 1,
      machine_count: 1,
      random_factor: 0.1,
      time_scale: 1,
    },
  };
  const requests: MockRequest[] = [];
  const failures = new Map<string, { status: number; body?: unknown }[]>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? undefined : (JSON.parse(raw) as unknown);
      requests.push({ method: req.method ?? "GET", path, body });

      const queued = failures.get(path);
      const failure = queued?.shift();
      if (failure) {
        respond(failure.status, failure.body ?? { error: "forced failure" });
        return;
      }

      const orderMatch = /^\/api\/orders\/([^/]+)$/.exec(path);
      const statusMatch = /^\/api\/orders\/([^/]+)\/status$/.exec(path);

      if (path === "/health") return respond(200, state.health);
      if (path === "/api/simulation") return respond(200, state.simulation);
      if (path === "/api/lines") return respond(200, state.lines);
      if (path === "/api/machines") return respond(200, state.machines);
      if (path === "/api/orders" && req.method === "GET") {
        return respond(200, state.orders);
      }
      if (path === "/api/orders" && req.method === "POST") {
        const input = body as Record<string, unknown>;
        const created = order({
          id: `order-${(state.orders?.length ?? 0) + 1}`,
          product_id: String(input.product_id),
          line_instance_id: String(input.line_instance_id),
          planned_qty: Number(input.planned_qty),
          status: "CREATED",
          started_at: null,
        });
        state.orders = [...(state.orders ?? []), created];
        return respond(201, created);
      }
      if (statusMatch && req.method === "PUT") {
        const found = findOrder(statusMatch[1]);
        if (!found) return respond(404, { error: "order not found" });
        found.status = String((body as Record<string, unknown>).status);
        return respond(200, found);
      }
      if (orderMatch && req.method === "GET") {
        const found = findOrder(orderMatch[1]);
        return found
          ? respond(200, found)
          : respond(404, { error: "order not found" });
      }
      if (orderMatch && req.method === "DELETE") {
        const found = findOrder(orderMatch[1]);
        if (!found) return respond(404, { error: "order not found" });
        found.status = "CANCELLED";
        return respond(200, { status: "cancelled" });
      }
      respond(404, { error: "no such route" });

      function respond(status: number, payload: unknown): void {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      }
    });
  });

  function findOrder(id: string): FloorOrder | undefined {
    return (state.orders ?? []).find((entry) => entry.id === id);
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    requests,
    failNext(path, status, body) {
      const queued = failures.get(path) ?? [];
      queued.push({ status, body });
      failures.set(path, queued);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
