// The Renown-authenticated face of a webhook trigger. The reactor's own
// `/webhooks/:token` family is public by construction: the token in the path is

// the whole credential, and `authorization` is redacted before a package's
// `onRequest` sees the delivery. An endpoint that has to know *who* is calling

// is therefore served from this package's own HTTP scope, where
// `auth: "renown-optional"` has already put the bearer through the reactor's

// AuthService — the same verification every authenticated route gets, not a
// second one. The token still addresses the endpoint: no longer the whole

// credential, but still what keeps the document id out of the URL, and the same
// token the path-token face uses, so switching method orphans no sender.
import type {
  IWebhookEndpoints,
  RouteContext,
  RouteMethod,
  WebhookReply,
  WebhookRequest,
  WebhookVerification,
} from "@powerhousedao/reactor-api";
import {
  parseWebhookBody,
  redactHeaders,
  verifyWebhook,
} from "@powerhousedao/reactor-api";
import { childLogger } from "document-model";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAddressAllowed, type WebhookConfig } from "./webhook.js";

const logger = childLogger(["workflow", "renown-webhook"]);

/** Mirrors the reactor's own `/webhooks/:token`, one scope further in. */
export const RENOWN_WEBHOOK_PATH = "webhooks/:token";

/** The reactor's own per-delivery cap, so both faces refuse the same body. */
export const RENOWN_MAX_BODY_BYTES = 1_048_576;

export const RENOWN_WEBHOOK_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "PATCH",
  "POST",
  "PUT",
] as const satisfies readonly RouteMethod[];

export interface RenownRefusal {
  status: number;
  message: string;
  /** Why, for the operator's log. Never sent to the caller. */
  reason: string;
}

export interface RenownAccessRecord extends Pick<
  WebhookConfig,
  "auth" | "allowedAddresses" | "methods"
> {
  // The author's signature scheme, secret already resolved. Applied here too:
  // choosing Renown must not quietly discard a control the author configured.
  verify?: WebhookVerification;
}

export type RenownAccess = RenownAccessRecord | undefined;

// Whether this host resolves bearer identities at all. "off" means a Renown
// endpoint can admit nobody, which is the operator's problem, not the caller's.
export type IdentityResolution = "unknown" | "on" | "off";

// Whether a delivery is allowed through, and what to answer when it is not.
// The statuses follow the reactor's own webhook route rather than inventing a

// scale: an unknown, unarmed or path-token endpoint answers 404, so a prober
// cannot tell a live Renown endpoint from one that was never minted. Past that

// the caller has proved it holds the token, so it is told what to fix — 401 for
// an identity this reactor could not verify, 403 for one that is not on the

// list. The method gate comes last, so a caller that proved nothing cannot
// enumerate the methods an armed endpoint accepts.
export function decideRenownDelivery(params: {
  access: RenownAccess;
  method: string;
  address: string | undefined;
  /** `ctx.authEnabled`: false means the host verifies no bearer at all. */
  identityResolved: boolean;
}): RenownRefusal | undefined {
  const { access, method, address, identityResolved } = params;
  if (!access || access.auth !== "renown") {
    return {
      status: 404,
      message: "Unknown endpoint",
      reason: "no Renown-authenticated endpoint is armed for this token",
    };
  }
  if (!identityResolved) {
    // Not the caller's fault and not fixable by them, so not a 4xx: this host
    // verifies no bearer, so it can admit nobody to a Renown endpoint.
    return {
      status: 503,
      message: "Endpoint temporarily unavailable",
      reason:
        "this reactor resolves no bearer identity, so a Renown endpoint can admit nobody; enable the reactor's auth or its resolveIdentity option",
    };
  }
  if (!address) {
    return {
      status: 401,
      message: "Renown authentication required",
      reason: "the request carried no bearer this reactor could verify",
    };
  }
  if (!isAddressAllowed(access.allowedAddresses, address)) {
    return {
      status: 403,
      message: "This identity is not allowed to deliver to this endpoint",
      reason: `${address} is not on the trigger's allow-list`,
    };
  }
  if (access.methods && !access.methods.includes(method.toUpperCase())) {
    return {
      status: 405,
      message: "Method not allowed",
      reason: `the endpoint does not accept ${method.toUpperCase()}`,
    };
  }
  return undefined;
}

/** What the route needs from the runtime service, kept narrow so the service
 * grows one small accessor rather than handing this its whole self. */
export interface RenownWebhookPort {
  /** The reactor's endpoint family; undefined on a host that has none. */
  endpoints: () => Promise<IWebhookEndpoints | undefined>;
  /** The armed access for a workflow, undefined when it is not armed. */
  accessFor: (workflowId: string) => Promise<RenownAccess>;
  /** The delivery path a path-token webhook takes, once it is allowed in. */
  deliver: (request: WebhookRequest) => Promise<WebhookReply>;
}

// Resolves a minted token back to the workflow that owns it. The store is the
// reactor's and exposes only a per-family listing, so the mapping is cached.

// Both hits and misses expire: a rotated or revoked token has to stop
// resolving, and a stream of invented tokens must not list the store once per

// request on a route anyone can reach.
export const TOKEN_TTL_MS = 60_000;
export const MISS_TTL_MS = 5_000;
const MISS_TABLE_LIMIT = 1_000;

export class TokenIndex {
  #byToken = new Map<string, string>();
  #readAt = -Infinity;
  #missUntil = new Map<string, number>();
  #refreshing?: Promise<void>;
  #refreshStartedAt = 0;
  readonly #now: () => number;

  constructor(
    private readonly port: RenownWebhookPort,
    now: () => number = Date.now,
  ) {
    this.#now = now;
  }

  async resolve(token: string): Promise<string | undefined> {
    const now = this.#now();
    const fresh = now - this.#readAt < TOKEN_TTL_MS;
    if (fresh) {
      const known = this.#byToken.get(token);
      if (known) return known;
      if ((this.#missUntil.get(token) ?? 0) > now) return undefined;
    }

    // A listing already in flight may predate this token's minting, so a miss
    // on one we merely joined is retried against a listing of our own.
    await this.#refreshSince(now);
    const resolved = this.#byToken.get(token);
    if (resolved === undefined) {
      this.#missUntil.set(token, this.#now() + MISS_TTL_MS);
      this.#pruneMisses();
    }
    return resolved;
  }

  async #refreshSince(since: number): Promise<void> {
    if (this.#refreshing && this.#refreshStartedAt >= since) {
      await this.#refreshing;
      return;
    }
    if (this.#refreshing) await this.#refreshing;
    await this.#refresh();
  }

  #refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshStartedAt = this.#now();
    this.#refreshing = this.#read().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #read(): Promise<void> {
    const endpoints = await this.port.endpoints();
    if (!endpoints) return;
    const rows = await endpoints.list();
    this.#byToken = new Map(rows.map((row) => [row.token, row.key]));
    this.#readAt = this.#now();
    this.#missUntil.clear();
  }

  /** Bounded: the miss table is reachable by anyone who can guess a URL, so a
   * flood must not grow it without limit. */
  #pruneMisses(): void {
    if (this.#missUntil.size < MISS_TABLE_LIMIT) return;
    const now = this.#now();
    for (const [token, until] of this.#missUntil) {
      if (until <= now) this.#missUntil.delete(token);
    }
    while (this.#missUntil.size >= MISS_TABLE_LIMIT) {
      const oldest = this.#missUntil.keys().next().value;
      if (oldest === undefined) break;
      this.#missUntil.delete(oldest);
    }
  }
}

export type NodeRouteContext = Omit<RouteContext, "rawBody" | "signal">;

/** The slice of `IHttpScope` this route needs, so a test can stand one up
 * without building a whole reactor. */
export interface RenownRouteScope {
  readonly baseUrl: string;
  nodeRoute: (spec: {
    method: RouteMethod[];
    path: string;
    auth: "renown-optional";
    handler: (
      req: IncomingMessage,
      res: ServerResponse,
      ctx: NodeRouteContext,
    ) => Promise<void>;
  }) => unknown;
}

/** Serves `<scope>/webhooks/:token` for triggers whose auth method is Renown. */
export class RenownWebhookRoute {
  readonly #port: RenownWebhookPort;
  readonly #tokens: TokenIndex;
  #baseUrl?: string;
  #identity: IdentityResolution = "unknown";
  #warnedNoIdentity = false;

  constructor(port: RenownWebhookPort, now: () => number = Date.now) {
    this.#port = port;
    this.#tokens = new TokenIndex(port, now);
  }

  /** The URL to hand a caller. Undefined until the route is registered, which
   * is what tells the editor this face is not being served at all. */
  urlFor(token: string): string | undefined {
    return this.#baseUrl ? `${this.#baseUrl}/webhooks/${token}` : undefined;
  }

  get registered(): boolean {
    return this.#baseUrl !== undefined;
  }

  // What deliveries have revealed about the host's own auth. Nothing on the
  // subgraph surface carries it, so it is observed rather than queried.
  get identityResolution(): IdentityResolution {
    return this.#identity;
  }

  register(scope: RenownRouteScope): void {
    // A node route, not a fetch route: the fetch scope buffers no body for GET
    // or HEAD, and an HMAC is computed over the octets exactly as received.
    scope.nodeRoute({
      method: [...RENOWN_WEBHOOK_METHODS],
      path: RENOWN_WEBHOOK_PATH,
      // Not "renown": that refuses a tokenless caller only where the host
      // enforces authentication globally, and a trigger's allow-list is the

      // trigger's own policy. This resolves the identity and decides here, and
      // reports a host that resolves none rather than refusing in silence.
      auth: "renown-optional",
      handler: (req, res, ctx) => this.handle(req, res, ctx),
    });
    // Only once the scope accepted the route: a throw must leave this
    // unregistered, so the editor can say the face is not being served.
    this.#baseUrl = scope.baseUrl.replace(/\/+$/, "");
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: NodeRouteContext,
  ): Promise<void> {
    this.#observeIdentity(ctx.authEnabled);
    const token = ctx.params.token;
    if (!token) {
      writeRefusal(res, { status: 404, message: "Unknown endpoint" });
      return;
    }

    const workflowId = await this.#tokens.resolve(token);
    const access = workflowId
      ? await this.#port.accessFor(workflowId)
      : undefined;
    const method = (req.method ?? "POST").toUpperCase();
    const refusal = decideRenownDelivery({
      access,
      method,
      address: ctx.user?.address,
      identityResolved: ctx.authEnabled,
    });
    if (refusal) {
      this.#refuse(res, workflowId, refusal);
      return;
    }

    const raw = await readCappedBody(req, RENOWN_MAX_BODY_BYTES);
    if (raw === "too-large") {
      res.setHeader("connection", "close");
      res.once("finish", () => req.destroy());
      writeRefusal(res, { status: 413, message: "Payload too large" });
      return;
    }

    const headers = headerRecord(req);
    const verification = access?.verify;
    if (verification) {
      const result = verifyWebhook({ verification, headers, raw });
      if (!result.ok) {
        this.#refuse(res, workflowId, {
          status: 401,
          message: "Signature verification failed",
          reason: result.reason,
        });
        return;
      }
    }

    // A fixed base: only the query is read from it, so the request's own
    // origin never enters it and cannot be spoofed through it.
    const url = new URL(req.url ?? "/", "http://localhost");
    const reply = await this.#port.deliver({
      key: workflowId as string,
      method,
      path: url.pathname,
      queryParams: Object.fromEntries(url.searchParams),
      // The author's own signature header goes too: it carries a shared
      // secret, and the reactor's face redacts it for exactly that reason.
      headers: redactHeaders(headers, verification?.header),
      raw,
      body: parseWebhookBody(raw, headers["content-type"]),
    });

    res.statusCode = reply.status;
    if (reply.body !== undefined && method !== "HEAD") {
      res.setHeader("content-type", reply.contentType ?? "text/plain");
      res.end(reply.body);
    } else {
      res.end();
    }
  }

  /** Logged once, not per delivery: a host that resolves no identity refuses
   * every call, and one line an operator can find beats a flood. */
  #observeIdentity(authEnabled: boolean): void {
    this.#identity = authEnabled ? "on" : "off";
    if (authEnabled || this.#warnedNoIdentity) return;
    this.#warnedNoIdentity = true;
    logger.error(
      "This reactor resolves no bearer identity, so every Renown-authenticated webhook trigger refuses every delivery; enable the reactor's auth or its resolveIdentity option",
    );
  }

  #refuse(
    res: ServerResponse,
    workflowId: string | undefined,
    refusal: RenownRefusal,
  ): void {
    // The token is not logged: it still addresses the endpoint, and the
    // refusal is the record an operator has to be able to read back.
    logger.warn(
      "Rejected a Renown webhook delivery for @workflow: @reason",
      workflowId ?? "an unknown endpoint",
      refusal.reason,
    );
    writeRefusal(res, refusal);
  }
}

function writeRefusal(
  res: ServerResponse,
  refusal: { status: number; message: string },
): void {
  res.statusCode = refusal.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: refusal.message }));
}

function headerRecord(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value;
  }
  return headers;
}

// Reads the body byte for byte, refusing past the cap. Every method, as the
// reactor's own face does: a GET delivery is still a body a sender chose.
export function readCappedBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
