import type { UmhCredentials } from "./auth-value";
import {
  categoryForStatus,
  describeFloorError,
  UmhApiError,
} from "./errors";
import type {
  FloorLine,
  FloorMachine,
  FloorOperation,
  FloorOrder,
} from "./types";

export type HttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: HttpVerb;
  // Relative to `<base>/api/`, e.g. "orders/abc123".
  path: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  // The health probe lives at the root, not under /api/.
  absolutePath?: boolean;
}

export interface UmhResponse<T> {
  status: number;
  data: T;
}

export interface UmhClientOptions {
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function appendQuery(url: URL, query: Record<string, QueryValue>): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.append(key, String(value));
  }
}

// The floor answers a collection with `null` rather than `[]` when it holds
// nothing — the normal state at boot with the ERP in manual mode, which is how
// the Powerhouse demo runs it. Every list goes through here so no caller has
// to remember that.
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export class UmhClient {
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(
    readonly credentials: UmhCredentials,
    options: UmhClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  url(
    path: string,
    query?: Record<string, QueryValue>,
    absolutePath = false,
  ): URL {
    const clean = path.replace(/^\/+/, "");
    const url = new URL(
      absolutePath
        ? `${this.credentials.baseUrl}/${clean}`
        : `${this.credentials.baseUrl}/api/${clean}`,
    );
    if (query) appendQuery(url, query);
    return url;
  }

  async request<T = unknown>(options: RequestOptions): Promise<UmhResponse<T>> {
    const url = this.url(options.path, options.query, options.absolutePath);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    // AbortSignal.timeout would be shorter, but an explicit controller is what
    // makes `signal.aborted` readable in the catch — the difference between
    // "took too long" and "refused the connection", which are different
    // problems for whoever is looking at the run.
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: options.method ?? "GET",
        headers,
        body,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted;
      throw new UmhApiError(
        aborted
          ? `The UMH floor API did not answer ${url.pathname} in time`
          : `Could not reach the UMH floor API at ${this.credentials.baseUrl}: ${message}`,
        { category: aborted ? "timeout" : "network", retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }

    const data = await this.readBody(response);
    if (response.status >= 400) {
      const described = describeFloorError(data);
      const category = categoryForStatus(response.status);
      throw new UmhApiError(
        described
          ? `UMH floor API ${response.status} on ${url.pathname}: ${described}`
          : `UMH floor API answered ${response.status} on ${url.pathname}`,
        {
          status: response.status,
          category,
          // Only a server-side fault is worth another attempt; a 400 would
          // fail identically however many times it is replayed.
          retryable: category === "server" || category === "rate_limit",
          detail: data,
        },
      );
    }
    return { status: response.status, data: data as T };
  }

  private async readBody(response: Response): Promise<unknown> {
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (text === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // An HTML error page from a proxy in front of the floor lands here.
      return text;
    }
  }

  // ---- the endpoints the piece is built on -------------------------------
  // Verified against dh2k/machine-simulator-2:v1.1.0; see README.md for the
  // full inventory and the shapes each one answers with.

  async health(): Promise<{ status?: string }> {
    // `| undefined` is not defensive typing: an empty body reads as undefined
    // (see readBody), and a proxy in front of the floor is the usual source of
    // a 200 with nothing in it.
    const response = await this.request<{ status?: string } | undefined>({
      path: "health",
      absolutePath: true,
      timeoutMs: 10_000,
    });
    return response.data ?? {};
  }

  async simulation(): Promise<{
    line_count?: number;
    machine_count?: number;
    random_factor?: number;
    time_scale?: number;
  }> {
    const response = await this.request<Record<string, number> | undefined>({
      path: "simulation",
    });
    return response.data ?? {};
  }

  async listOrders(): Promise<FloorOrder[]> {
    const response = await this.request<FloorOrder[] | null>({
      path: "orders",
    });
    return asArray<FloorOrder>(response.data);
  }

  async getOrder(id: string): Promise<FloorOrder> {
    const response = await this.request<FloorOrder>({
      path: `orders/${encodeURIComponent(id)}`,
    });
    return response.data;
  }

  async createOrder(input: {
    product_id: string;
    line_instance_id: string;
    planned_qty: number;
    priority?: number;
  }): Promise<FloorOrder> {
    const response = await this.request<FloorOrder>({
      method: "POST",
      path: "orders",
      json: input,
    });
    return response.data;
  }

  async setOrderStatus(id: string, status: string): Promise<FloorOrder> {
    const response = await this.request<FloorOrder>({
      method: "PUT",
      path: `orders/${encodeURIComponent(id)}/status`,
      json: { status },
    });
    return response.data;
  }

  async cancelOrder(id: string): Promise<{ status?: string }> {
    const response = await this.request<{ status?: string } | undefined>({
      method: "DELETE",
      path: `orders/${encodeURIComponent(id)}`,
    });
    return response.data ?? {};
  }

  async listOperations(orderId: string): Promise<FloorOperation[]> {
    const response = await this.request<FloorOperation[] | null>({
      path: `orders/${encodeURIComponent(orderId)}/operations`,
    });
    return asArray<FloorOperation>(response.data);
  }

  async listLines(): Promise<FloorLine[]> {
    const response = await this.request<FloorLine[] | null>({ path: "lines" });
    return asArray<FloorLine>(response.data);
  }

  async listMachines(): Promise<FloorMachine[]> {
    const response = await this.request<FloorMachine[] | null>({
      path: "machines",
    });
    return asArray<FloorMachine>(response.data);
  }
}
