// One error type for every failure the client can produce. The reactor
// serializes a piece error by copying its own enumerable keys across IPC
// (worker/entry.ts `serializeError`), so `status`, `category` and `retryable`
// are plain fields rather than accessors — that is what makes them readable
// by the host's failure classifier.

export type PaperlessErrorCategory =
  | "validation"
  | "credential"
  | "permission"
  | "not_found"
  | "api_version"
  | "rate_limit"
  | "server"
  | "network"
  | "config"
  | "timeout";

export class PaperlessApiError extends Error {
  readonly status?: number;
  readonly category: PaperlessErrorCategory;
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(
    message: string,
    options: {
      status?: number;
      category: PaperlessErrorCategory;
      retryable?: boolean;
      detail?: unknown;
    },
  ) {
    super(message);
    this.name = "PaperlessApiError";
    this.status = options.status;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}

// Pulls something a user can act on out of a DRF error body, which is any of:
// {"detail": "..."} | {"field": ["msg", ...]} | ["msg"] | "msg".
export function describeDrfError(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim() !== "") return body.trim();
  if (Array.isArray(body)) {
    const parts = body.map((entry) => describeDrfError(entry)).filter(Boolean);
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.detail === "string") return record.detail;
  const parts: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    const described = describeDrfError(value);
    if (described) parts.push(`${field}: ${described}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}
