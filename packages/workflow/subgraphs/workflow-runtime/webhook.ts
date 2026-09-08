// Config parsing for core#webhook. Verification, redaction and the payload
// mechanics belong to the reactor's webhook service; what is left here is the
// editor-facing shape of the trigger block.
export const WEBHOOK_BLOCK = "core#webhook";

export const WEBHOOK_TRIGGER_KIND = "webhook";

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

// A signed scheme with no secret is a configuration error, not a runtime one.
const SIGNED_SCHEMES = new Set<WebhookScheme>([
  "token",
  "hmac-sha256",
  "github",
  "stripe",
]);

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
/**
 * The trigger payload, shaped like Activepieces' catch-webhook contract so
 * authored expressions and adapted pieces agree on where a request's parts are.
 *
 * Everything that used to live below this line — token minting, the four
 * signature schemes, header redaction, body decoding, dedupe keys, the
 * challenge round and the rate limiter — is now the reactor's webhook service.
 * None of it was about workflows.
 */
export interface WebhookPayload {
  method: string;
  path: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  body: unknown;
}
