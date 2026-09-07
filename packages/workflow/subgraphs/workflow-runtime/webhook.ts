// Config parsing, signature verification and payload shaping for core#webhook,
// all over the RAW bytes: a parse/stringify round trip breaks every signature.
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";

export const WEBHOOK_BLOCK = "core#webhook";

// Spec path (plan/08 §7.2). The token is an opaque per-instance value, never
// the workflow id: the URL is a bearer capability handed to a third party.
export const WEBHOOK_PATH_PREFIX = "/workflows/hooks/";

export const WEBHOOK_TRIGGER_KIND = "webhook";

const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export const DEFAULT_TOLERANCE_SECONDS = 300;
export const DEFAULT_DEDUPE_TTL_SECONDS = 300;
export const DEFAULT_RESPONSE_STATUS = 202;
export const DEFAULT_SYNC_RESPONSE_STATUS = 200;

// What providers actually send: a shared token in a header, a bare hex HMAC,
// GitHub's "sha256=" prefix, and Stripe's timestamped scheme.
export type WebhookScheme =
  | "none"
  | "token"
  | "hmac-sha256"
  | "github"
  | "stripe";

const SCHEMES = new Set<WebhookScheme>([
  "none",
  "token",
  "hmac-sha256",
  "github",
  "stripe",
]);

// Header each scheme reads when the author does not name one.
const DEFAULT_HEADER: Record<WebhookScheme, string> = {
  none: "",
  token: "x-webhook-token",
  "hmac-sha256": "x-signature",
  github: "x-hub-signature-256",
  stripe: "stripe-signature",
};

const SIGNED_SCHEMES = new Set<WebhookScheme>([
  "token",
  "hmac-sha256",
  "github",
  "stripe",
]);

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
] as const;

export interface WebhookConfig {
  // Uppercase; undefined accepts every method.
  methods?: string[];
  scheme: WebhookScheme;
  // Lowercase header the signature/token is read from; "" when scheme is none.
  header: string;
  // secret://v1: ref resolved through the secret store at delivery time.
  secretRef?: string;
  // Replay window for schemes carrying a timestamp (stripe).
  toleranceSeconds: number;
  // async answers before the run; sync waits for it and reports the outcome.
  responseMode: "async" | "sync";
  responseStatus: number;
  // A query param or body field echoed back verbatim instead of starting a
  // run; Activepieces spends onHandshake on the same provider round.
  challengeField?: string;
  // Body field holding the provider's event id. Present, it is the
  // authoritative dedup key for redeliveries (plan/08 §7.2).
  dedupeField?: string;
  dedupeTtlSeconds: number;
}

function asRecord(config: unknown): Record<string, unknown> {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  if (typeof config === "string") {
    try {
      return asRecord(JSON.parse(config));
    } catch {
      return {};
    }
  }
  return {};
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

// "ANY" and "" both mean every method, which is how the editor spells it.
function parseMethods(value: unknown): string[] | undefined {
  const list =
    typeof value === "string"
      ? value === "" || value.toUpperCase() === "ANY"
        ? []
        : [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
  if (list.length === 0) return undefined;
  const methods = list.map((method) => method.trim().toUpperCase());
  for (const method of methods) {
    if (!(HTTP_METHODS as readonly string[]).includes(method)) {
      throw new Error(
        `${WEBHOOK_BLOCK}: "${method}" is not one of ${HTTP_METHODS.join(", ")}`,
      );
    }
  }
  return methods;
}

// Config: { methods?, scheme?, header?, secretRef?, toleranceSeconds?,
// responseMode?, responseStatus?, challengeField? }.
export function parseWebhookConfig(config: unknown): WebhookConfig {
  const record = asRecord(config);
  const rawScheme = nonEmptyString(record.scheme) ?? "none";
  if (!SCHEMES.has(rawScheme as WebhookScheme)) {
    throw new Error(
      `${WEBHOOK_BLOCK}: "scheme" must be one of ${[...SCHEMES].join(", ")}`,
    );
  }
  const scheme = rawScheme as WebhookScheme;
  const secretRef = nonEmptyString(record.secretRef);
  if (SIGNED_SCHEMES.has(scheme) && !secretRef) {
    throw new Error(
      `${WEBHOOK_BLOCK}: the "${scheme}" scheme needs a "secretRef"`,
    );
  }
  const responseMode =
    record.responseMode === "sync" ? ("sync" as const) : ("async" as const);
  const status =
    toNumber(record.responseStatus) ??
    (responseMode === "sync"
      ? DEFAULT_SYNC_RESPONSE_STATUS
      : DEFAULT_RESPONSE_STATUS);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error(
      `${WEBHOOK_BLOCK}: "responseStatus" must be an integer between 200 and 599`,
    );
  }
  const tolerance =
    toNumber(record.toleranceSeconds) ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error(
      `${WEBHOOK_BLOCK}: "toleranceSeconds" must be a positive number`,
    );
  }
  const dedupeTtl =
    toNumber(record.dedupeTtlSeconds) ?? DEFAULT_DEDUPE_TTL_SECONDS;
  if (!Number.isFinite(dedupeTtl) || dedupeTtl <= 0) {
    throw new Error(
      `${WEBHOOK_BLOCK}: "dedupeTtlSeconds" must be a positive number`,
    );
  }
  return {
    methods: parseMethods(record.methods),
    scheme,
    header: (
      nonEmptyString(record.header) ?? DEFAULT_HEADER[scheme]
    ).toLowerCase(),
    secretRef,
    toleranceSeconds: tolerance,
    responseMode,
    responseStatus: status,
    challengeField: nonEmptyString(record.challengeField),
    dedupeField: nonEmptyString(record.dedupeField),
    dedupeTtlSeconds: dedupeTtl,
  };
}

// The provider's event id, when the author named the field holding it. Only
// top-level string/number fields qualify; anything else is not an id.
export function dedupeKeyFor(
  config: WebhookConfig,
  payload: WebhookPayload,
): string | undefined {
  const field = config.dedupeField;
  if (!field || !payload.body || typeof payload.body !== "object") {
    return undefined;
  }
  const value = (payload.body as Record<string, unknown>)[field];
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

// The header a scheme reads by default, for the editor's placeholder text.
export function defaultHeaderFor(scheme: WebhookScheme): string {
  return DEFAULT_HEADER[scheme];
}

export function newEndpointToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function isEndpointToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

// "/workflows/hooks/<token>" -> token. Undefined for anything else, extra
// path segments included: the endpoint has no sub-routes.
export function tokenFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(WEBHOOK_PATH_PREFIX)) return undefined;
  const rest = pathname.slice(WEBHOOK_PATH_PREFIX.length);
  return isEndpointToken(rest) ? rest : undefined;
}

export function webhookUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${WEBHOOK_PATH_PREFIX}${token}`;
}

// Where this reactor is reachable from outside. Mirrors reactor-api's own
// convention for the supergraph URL, so a Heroku deploy needs no extra config.
export function resolveWebhookBaseUrl(
  port?: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = nonEmptyString(env.WORKFLOW_WEBHOOK_BASE_URL);
  if (configured) return configured.replace(/\/+$/, "");
  const heroku = nonEmptyString(env.HEROKU_APP_DEFAULT_DOMAIN_NAME);
  if (heroku) return `https://${heroku}`;
  return `http://localhost:${port ?? nonEmptyString(env.PORT) ?? 4001}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const OK: VerifyResult = { ok: true };

// Constant-time over equal-length inputs. A length mismatch is already a
// rejection, so the early return leaks nothing a caller could not measure.
function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function hmacHex(secret: string, payload: BinaryLike): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

// Stripe's header: "t=<unix>,v1=<hex>[,v1=<hex>…]". Any v1 may match, which
// is how their key rotation works.
function parseStripeHeader(value: string): {
  timestamp?: number;
  signatures: string[];
} {
  const signatures: string[] = [];
  let timestamp: number | undefined;
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const item = part.slice(separator + 1).trim();
    if (key === "t") timestamp = Number(item);
    else if (key === "v1") signatures.push(item.toLowerCase());
  }
  return { timestamp, signatures };
}

// Verifies a request against the configured scheme; `raw` must be the exact
// bytes received. The reason is for the log only: callers answer a fixed 401.
export function verifyWebhookRequest(options: {
  config: WebhookConfig;
  headers: Record<string, string>;
  raw: Buffer;
  secret?: string;
  now?: Date;
}): VerifyResult {
  const { config, headers, raw } = options;
  if (config.scheme === "none") return OK;
  if (!options.secret) return { ok: false, reason: "signing secret missing" };
  // Absent and empty are one case: the index type hides the former.
  const presented: string | undefined = headers[config.header];
  if (!presented) {
    return { ok: false, reason: `header "${config.header}" absent` };
  }
  const secret = options.secret;

  switch (config.scheme) {
    case "token":
      return secureEquals(presented, secret)
        ? OK
        : { ok: false, reason: "token mismatch" };
    case "hmac-sha256":
      return secureEquals(presented.trim().toLowerCase(), hmacHex(secret, raw))
        ? OK
        : { ok: false, reason: "hmac mismatch" };
    case "github": {
      const expected = `sha256=${hmacHex(secret, raw)}`;
      return secureEquals(presented.trim().toLowerCase(), expected)
        ? OK
        : { ok: false, reason: "hmac mismatch" };
    }
    case "stripe": {
      const { timestamp, signatures } = parseStripeHeader(presented);
      if (timestamp === undefined || !Number.isFinite(timestamp)) {
        return { ok: false, reason: "no timestamp in the signature header" };
      }
      if (signatures.length === 0) {
        return { ok: false, reason: "no v1 signature in the header" };
      }
      const nowMs = (options.now ?? new Date()).getTime();
      if (Math.abs(nowMs / 1000 - timestamp) > config.toleranceSeconds) {
        return { ok: false, reason: "timestamp outside the replay window" };
      }
      const expected = hmacHex(
        secret,
        Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), raw]),
      );
      // Every candidate is compared, so rotation does not change the timing.
      let matched = false;
      for (const signature of signatures) {
        if (secureEquals(signature, expected)) matched = true;
      }
      return matched ? OK : { ok: false, reason: "hmac mismatch" };
    }
    default:
      return { ok: false, reason: "unsupported scheme" };
  }
}

export function methodAllowed(config: WebhookConfig, method: string): boolean {
  return !config.methods || config.methods.includes(method.toUpperCase());
}

// Headers that would put a credential in the run journal. The configured
// signature header joins them: it is an HMAC of the body under a live secret.
const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-webhook-token",
  "x-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "stripe-signature",
]);

export const REDACTED = "[redacted]";

export function redactHeaders(
  headers: Record<string, string>,
  extra?: string,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    redacted[key] =
      REDACTED_HEADERS.has(key) || (extra && key === extra.toLowerCase())
        ? REDACTED
        : value;
  }
  return redacted;
}

export interface WebhookPayload {
  method: string;
  path: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  body: unknown;
}

// JSON and form bodies become objects; anything else stays decoded text, so a
// verified XML or CSV payload is still reachable downstream.
export function parseWebhookBody(raw: Buffer, contentType?: string): unknown {
  if (raw.length === 0) return undefined;
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const text = raw.toString("utf8");
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A malformed body is still evidence; hand the text through.
      return text;
    }
  }
  if (type === "application/x-www-form-urlencoded") {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

// The trigger payload, shaped like Activepieces' catch-webhook contract so
// authored expressions and adapted pieces agree on where a request's parts are.
export function buildWebhookPayload(request: {
  method: string;
  path: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  raw: Buffer;
  signatureHeader?: string;
}): WebhookPayload {
  return {
    method: request.method.toUpperCase(),
    path: request.path,
    headers: redactHeaders(request.headers, request.signatureHeader),
    queryParams: request.queryParams,
    body: parseWebhookBody(request.raw, request.headers["content-type"]),
  };
}

// A provider's endpoint-verification round: echo the named value, start no
// run. Query first, then a top-level body field, as providers send it.
export function challengeResponse(
  config: WebhookConfig,
  payload: WebhookPayload,
): string | undefined {
  const field = config.challengeField;
  if (!field) return undefined;
  const fromQuery = payload.queryParams[field];
  if (typeof fromQuery === "string" && fromQuery !== "") return fromQuery;
  if (payload.body && typeof payload.body === "object") {
    const value = (payload.body as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

// Per-endpoint token bucket (plan/08 §7.2): refills continuously, so a burst
// up to `capacity` passes and the sustained rate is `perMinute`.
export class WebhookRateLimiter {
  private readonly buckets = new Map<
    string,
    { tokens: number; updatedAt: number }
  >();
  private readonly ratePerMs: number;

  constructor(
    private readonly perMinute = 120,
    private readonly capacity = Math.max(perMinute, 10),
    private readonly maxKeys = 4096,
  ) {
    this.ratePerMs = this.perMinute / 60_000;
  }

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      // Unbounded growth would make the limiter itself the flood target.
      if (this.buckets.size >= this.maxKeys) this.buckets.clear();
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return true;
    }
    const refilled = Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.updatedAt) * this.ratePerMs,
    );
    bucket.updatedAt = now;
    if (refilled < 1) {
      bucket.tokens = refilled;
      return false;
    }
    bucket.tokens = refilled - 1;
    return true;
  }
}
