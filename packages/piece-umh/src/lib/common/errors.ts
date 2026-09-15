// One error type for every failure the client can produce. The reactor
// serializes a piece error by copying its own enumerable keys across IPC
// (worker/entry.ts `serializeError`), so `status`, `category` and `retryable`
// are plain fields rather than accessors — that is what makes them readable by
// the host's failure classifier.

export type UmhErrorCategory =
  | "validation"
  | "credential"
  | "permission"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "server"
  | "network"
  | "config"
  | "timeout";

export class UmhApiError extends Error {
  readonly status?: number;
  readonly category: UmhErrorCategory;
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      category: UmhErrorCategory;
      retryable?: boolean;
      detail?: unknown;
    },
  ) {
    super(message);
    this.name = "UmhApiError";
    this.status = options.status;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}

// The floor API answers an error as {"error":"invalid request body"} — a
// single field, unlike DRF's several shapes. A body that is not that is still
// worth surfacing, because an unexpected one usually means a proxy answered
// rather than the simulator.
export function describeFloorError(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim() !== "") return body.trim();
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

// Status -> category, in the terms an operator can act on. 409 has its own
// category because the floor rejects a second close of the same order that
// way, and a workflow that hits it wants to carry on rather than fail.
export function categoryForStatus(status: number): UmhErrorCategory {
  if (status === 400 || status === 422) return "validation";
  if (status === 401) return "credential";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  return "server";
}
