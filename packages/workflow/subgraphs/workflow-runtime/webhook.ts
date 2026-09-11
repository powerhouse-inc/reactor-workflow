// Config parsing for core#webhook: the editor-facing shape of the trigger block.
// Verification, redaction and payload mechanics belong to the reactor's service.
import type {
  WebhookField,
  WebhookHashAlgorithm,
  WebhookSignatureEncoding,
} from "@powerhousedao/reactor-api";

export const WEBHOOK_BLOCK = "core#webhook";

export const WEBHOOK_TRIGGER_KIND = "webhook";

export const DEFAULT_TOLERANCE_SECONDS = 300;
export const DEFAULT_DEDUPE_TTL_SECONDS = 300;
export const DEFAULT_RESPONSE_STATUS = 202;
export const DEFAULT_SYNC_RESPONSE_STATUS = 200;

// Signature layout named by wire format, not by sender; hash and encoding are
// separate, so no name carries them. Mirrors the reactor's own WebhookScheme.
export type WebhookScheme =
  | "none"
  | "token"
  | "hmac"
  | "hmac-prefixed"
  | "hmac-timestamped";

const ALGORITHMS = new Set<WebhookHashAlgorithm>(["sha1", "sha256", "sha512"]);
const ENCODINGS = new Set<WebhookSignatureEncoding>(["hex", "base64"]);

// A signed scheme with no secret is a configuration error, not a runtime one.
const SIGNED_SCHEMES = new Set<WebhookScheme>([
  "token",
  "hmac",
  "hmac-prefixed",
  "hmac-timestamped",
]);

const SCHEMES = new Set<WebhookScheme>([
  "none",
  "token",
  "hmac",
  "hmac-prefixed",
  "hmac-timestamped",
]);

// The header each format is most often carried in; the author can override it.
const DEFAULT_HEADER: Record<WebhookScheme, string> = {
  none: "",
  token: "x-webhook-token",
  hmac: "x-signature",
  "hmac-prefixed": "x-hub-signature-256",
  "hmac-timestamped": "stripe-signature",
};

/** How a delivery proves it is allowed in. */
export const WEBHOOK_AUTH_METHODS = ["path", "renown"] as const;

export type WebhookAuthMethod = (typeof WEBHOOK_AUTH_METHODS)[number];

const AUTH_METHODS = new Set<WebhookAuthMethod>(WEBHOOK_AUTH_METHODS);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

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
  // Who the endpoint answers to. "path" is the minted token in the URL and
  // nothing more, which is what every webhook trigger had before this existed.

  // "renown" additionally requires a bearer the reactor can verify, whose
  // signer is on `allowedAddresses`.
  auth: WebhookAuthMethod;
  // Lowercased signer addresses allowed to deliver under "renown". Empty is a
  // closed endpoint, never an open one: an author adds identities deliberately.
  allowedAddresses: string[];
  // `powerhouse/reactor-group` document ids whose members may deliver. Held as
  // references, not as a copy of the members: see group-members.ts.
  allowedGroups: string[];
  scheme: WebhookScheme;
  // Lowercase header the signature/token is read from; "" when scheme is none.
  header: string;
  // secret://v1: ref resolved through the secret store at delivery time.
  secretRef?: string;
  // Replay window for the timestamped scheme.
  toleranceSeconds: number;
  // Digest options a sender picks independently of the layout; undefined leaves
  // the reactor's defaults (sha256, hex, algorithm-derived label) in place.
  algorithm?: WebhookHashAlgorithm;
  encoding?: WebhookSignatureEncoding;
  // "" is a real value: a prefixed layout carrying no label at all. Only
  // undefined means "the algorithm's own label".
  prefix?: string;
  // async answers before the run; sync waits for it and reports the outcome.
  responseMode: "async" | "sync";
  responseStatus: number;
  // A field echoed back verbatim instead of starting a run; Activepieces
  // spends onHandshake on the same provider round.
  challengeField?: WebhookField;
  // Where the provider's own event id is. Present, it is the authoritative
  // dedup key for redeliveries (plan/08 §7.2).
  dedupeField?: WebhookField;
  dedupeTtlSeconds: number;
}

/** Lowercased for comparison: a verified credential and a pasted address differ
 * only in EIP-55 case, and a case-sensitive list would silently miss its owner. */
export function normalizeAddress(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : undefined;
  return text && ADDRESS.test(text) ? text.toLowerCase() : undefined;
}

/** Whether a verified signer may deliver. An empty list allows nobody — an
 * endpoint nobody was added to is closed rather than open to everyone. */
export function isAddressAllowed(
  allowed: readonly string[],
  address: string | undefined,
): boolean {
  const normalized = normalizeAddress(address);
  return normalized !== undefined && allowed.includes(normalized);
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

// Where a provider put a value: a bare name is a query param or top-level body field.
// `header:`/`body:` prefixes exist because senders disagree; object form is accepted too.
function parseWebhookField(value: unknown): WebhookField | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const header = nonEmptyString(record.header);
    if (header) return { header: header.toLowerCase() };
    const body = nonEmptyString(record.body);
    if (body) return { body };
    throw new Error(
      `${WEBHOOK_BLOCK}: a field source must name either "header" or "body"`,
    );
  }
  const text = nonEmptyString(value);
  if (!text) return undefined;
  // Only these two prefixes are a source. Any other colon is part of the name,
  // so a provider that uses one in a field name still resolves.
  const match = /^(header|body)\s*:\s*(\S.*)$/i.exec(text);
  if (!match) return text;
  const source = match[1].toLowerCase();
  const name = match[2].trim();
  return source === "header" ? { header: name.toLowerCase() } : { body: name };
}

// A named choice, rejected loudly: an unknown hash would otherwise reach the
// reactor and fail every delivery with nothing pointing at the config.
function parseEnum<T extends string>(
  value: unknown,
  allowed: Set<T>,
  field: string,
): T | undefined {
  const text = nonEmptyString(value)?.toLowerCase();
  if (!text) return undefined;
  if (!allowed.has(text as T)) {
    throw new Error(
      `${WEBHOOK_BLOCK}: "${field}" must be one of ${[...allowed].join(", ")}`,
    );
  }
  return text as T;
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

// Rejected loudly rather than dropped: an address that silently vanished from
// the list would read, in the editor, as access that was never granted.
function parseAllowedAddresses(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const allowed = new Set<string>();
  for (const entry of list) {
    const address = normalizeAddress(entry);
    if (!address) {
      throw new Error(
        `${WEBHOOK_BLOCK}: "${String(entry)}" is not a 0x-prefixed 20-byte address`,
      );
    }
    allowed.add(address);
  }
  return [...allowed];
}

// A document id, not an address: validated only for shape, since whether the
// group exists is a delivery-time question and a deleted one grants nobody.
function parseAllowedGroups(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  const groups = new Set<string>();
  for (const entry of list) {
    const id = nonEmptyString(entry);
    if (!id || /\s/.test(id)) {
      throw new Error(
        `${WEBHOOK_BLOCK}: "${String(entry)}" is not a group document id`,
      );
    }
    groups.add(id);
  }
  return [...groups];
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
  const auth = parseEnum(record.auth, AUTH_METHODS, "auth") ?? "path";
  const challengeField = parseWebhookField(record.challengeField);
  const dedupeField = parseWebhookField(record.dedupeField);
  // The Renown face is this package's own route, so the reactor's challenge
  // round and redelivery dedupe are not applied to it. Refusing the

  // combination is the only honest answer: dropping a handshake in silence
  // breaks registration with the sender, and dropping dedupe double-fires.
  if (auth === "renown") {
    const unsupported = [
      challengeField ? "challengeField" : undefined,
      dedupeField ? "dedupeField" : undefined,
    ].filter((field): field is string => field !== undefined);
    if (unsupported.length > 0) {
      throw new Error(
        `${WEBHOOK_BLOCK}: the "renown" auth method cannot honour ${unsupported.join(" or ")}; clear it, or keep the endpoint on the "path" method`,
      );
    }
  }
  return {
    methods: parseMethods(record.methods),
    auth,
    allowedAddresses: parseAllowedAddresses(record.allowedAddresses),
    allowedGroups: parseAllowedGroups(record.allowedGroups),
    scheme,
    header: (
      nonEmptyString(record.header) ?? DEFAULT_HEADER[scheme]
    ).toLowerCase(),
    secretRef,
    toleranceSeconds: tolerance,
    responseMode,
    responseStatus: status,
    algorithm: parseEnum(record.algorithm, ALGORITHMS, "algorithm"),
    encoding: parseEnum(record.encoding, ENCODINGS, "encoding"),
    prefix: typeof record.prefix === "string" ? record.prefix : undefined,
    challengeField,
    dedupeField,
    dedupeTtlSeconds: dedupeTtl,
  };
}

/** The trigger payload, shaped like Activepieces' catch-webhook contract so
 * authored expressions and adapted pieces agree on where a request's parts are. */
export interface WebhookPayload {
  method: string;
  path: string;
  headers: Record<string, string>;
  queryParams: Record<string, string>;
  body: unknown;
}
