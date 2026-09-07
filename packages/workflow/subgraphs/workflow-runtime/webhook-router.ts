// Mounts the /workflows/hooks/:token endpoint on the reactor's HTTP server.
// SubgraphArgs carries no adapter, so the handles come off the graphql manager.
import type { BaseSubgraph } from "@powerhousedao/reactor-api";
import { childLogger } from "document-model";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  resolveWebhookBaseUrl,
  tokenFromPath,
  WEBHOOK_PATH_PREFIX,
} from "./webhook.js";

const logger = childLogger(["workflow", "webhook-router"]);

// A signed body of any realistic size fits; past this the socket is cut
// rather than buffered, since the HMAC needs the whole payload in memory.
const DEFAULT_MAX_BODY_BYTES = 1_048_576;

// A sync-mode run holds the socket. Past this the provider gets a 504 and the
// run continues on its own; providers time out far sooner than this anyway.
const DELIVERY_TIMEOUT_MS = 30_000;

export interface WebhookRequest {
  token: string;
  method: string;
  path: string;
  queryParams: Record<string, string>;
  // Lowercased names; repeated headers joined with ", " as Node reports them.
  headers: Record<string, string>;
  raw: Buffer;
  // False on the adapter fallback, where body-parser already consumed the
  // stream: signature schemes over raw bytes cannot be honoured there.
  rawExact: boolean;
}

export interface WebhookReply {
  status: number;
  body?: string;
  contentType?: string;
}

export type WebhookDeliver = (request: WebhookRequest) => Promise<WebhookReply>;

export interface WebhookMount {
  transport: "server" | "adapter" | "none";
  baseUrl: string;
  // Whether the mounted transport yields byte-exact bodies.
  rawExact: boolean;
}

// The reachable-through-privates handles. Typed structurally and read
// defensively: none of this is part of reactor-api's published surface.
interface ReactorHandles {
  httpServer?: Server;
  httpAdapter?: {
    mountNodeRoute?: (
      method: "DELETE" | "GET" | "HEAD" | "POST" | "PUT",
      path: string,
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
        body?: unknown,
      ) => void | Promise<void>,
    ) => void;
  };
  port?: number;
}

function reactorHandles(subgraph: BaseSubgraph): ReactorHandles {
  const manager = subgraph.graphqlManager as unknown as
    | Record<string, unknown>
    | undefined;
  if (!manager) return {};
  return {
    httpServer: manager.httpServer as Server | undefined,
    httpAdapter: manager.httpAdapter as ReactorHandles["httpAdapter"],
    port: typeof manager.port === "number" ? manager.port : undefined,
  };
}

function headerRecord(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value;
  }
  return headers;
}

function readBody(
  message: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    message.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        message.destroy();
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    message.on("end", () => resolve(Buffer.concat(chunks)));
    message.on("error", reject);
  });
}

function reply(
  response: ServerResponse,
  result: WebhookReply,
  headOnly: boolean,
): void {
  if (response.writableEnded) return;
  response.statusCode = result.status;
  if (result.body !== undefined && !headOnly) {
    response.setHeader(
      "content-type",
      result.contentType ?? "application/json; charset=utf-8",
    );
    response.end(result.body);
    return;
  }
  response.end();
}

function maxBodyBytes(): number {
  const configured = Number(process.env.WORKFLOW_WEBHOOK_MAX_BODY_BYTES);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_BODY_BYTES;
}

function withTimeout(work: Promise<WebhookReply>): Promise<WebhookReply> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ status: 504 }),
      DELIVERY_TIMEOUT_MS,
    );
    timer.unref();
    work.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        logger.error("Webhook delivery failed", error);
        resolve({ status: 500 });
      },
    );
  });
}

// One live handler per process, replaced on a hot reload so the server is
// wrapped exactly once however many times the subgraph is set up.
let current: WebhookDeliver | undefined;
const wrapped = new WeakSet<Server>();
const mountedAdapters = new WeakSet<object>();

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  url: URL,
  raw: Buffer | "too-large",
  rawExact: boolean,
): Promise<void> {
  const headOnly = (request.method ?? "GET").toUpperCase() === "HEAD";
  if (raw === "too-large") {
    reply(response, { status: 413 }, headOnly);
    return;
  }
  const deliver = current;
  if (!deliver) {
    reply(response, { status: 503 }, headOnly);
    return;
  }
  const result = await withTimeout(
    deliver({
      token,
      method: (request.method ?? "GET").toUpperCase(),
      path: url.pathname,
      queryParams: Object.fromEntries(url.searchParams),
      headers: headerRecord(request),
      raw,
      rawExact,
    }),
  );
  reply(response, result, headOnly);
}

// Server-level interception: the webhook path is answered before Express sees
// it, so the request stream is still unread and the bytes are exact.
function wrapServer(server: Server): boolean {
  const downstream = server.listeners("request") as ((
    req: IncomingMessage,
    res: ServerResponse,
  ) => void)[];
  if (downstream.length === 0) return false;
  server.removeAllListeners("request");
  server.on("request", (request: IncomingMessage, res: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) {
      for (const listener of downstream) listener.call(server, request, res);
      return;
    }
    const token = tokenFromPath(url.pathname);
    if (!token) {
      // A malformed token is refused exactly like an unknown one.
      reply(res, { status: 401 }, false);
      return;
    }
    readBody(request, maxBodyBytes()).then(
      (raw) => {
        serve(request, res, token, url, raw, true).catch((error: unknown) => {
          logger.error("Webhook handler failed", error);
          reply(res, { status: 500 }, false);
        });
      },
      (error: unknown) => {
        logger.warn("Webhook body read failed", error);
        reply(res, { status: 400 }, false);
      },
    );
  });
  wrapped.add(server);
  return true;
}

// Fallback when the server handle is unreachable. Express has already parsed
// the body here, so `rawExact` is false and HMAC schemes must refuse.
function mountOnAdapter(adapter: NonNullable<ReactorHandles["httpAdapter"]>) {
  const methods = ["POST", "GET", "PUT", "DELETE", "HEAD"] as const;
  for (const method of methods) {
    adapter.mountNodeRoute!(
      method,
      `${WEBHOOK_PATH_PREFIX}:token`,
      (request, res, body) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const token = tokenFromPath(url.pathname);
        if (!token) {
          reply(res, { status: 401 }, false);
          return;
        }
        const raw =
          body === undefined
            ? Buffer.alloc(0)
            : Buffer.from(
                typeof body === "string" ? body : JSON.stringify(body),
                "utf8",
              );
        serve(request, res, token, url, raw, false).catch((error: unknown) => {
          logger.error("Webhook handler failed", error);
          reply(res, { status: 500 }, false);
        });
      },
    );
  }
}

// Called from the subgraph's onSetup. Idempotent: a second call swaps the
// handler in place rather than stacking another interceptor.
export function mountWebhookRoutes(
  subgraph: BaseSubgraph,
  deliver: WebhookDeliver,
): WebhookMount {
  const handles = reactorHandles(subgraph);
  const baseUrl = resolveWebhookBaseUrl(handles.port);
  current = deliver;

  const server = handles.httpServer;
  if (server && (wrapped.has(server) || wrapServer(server))) {
    logger.info(
      `Webhook endpoints mounted at ${baseUrl}${WEBHOOK_PATH_PREFIX}<token>`,
    );
    return { transport: "server", baseUrl, rawExact: true };
  }
  const adapter = handles.httpAdapter;
  if (adapter?.mountNodeRoute) {
    if (!mountedAdapters.has(adapter)) {
      mountOnAdapter(adapter);
      mountedAdapters.add(adapter);
    }
    logger.warn(
      "Webhook endpoints mounted through the HTTP adapter: bodies are re-encoded, so signed schemes are refused",
    );
    return { transport: "adapter", baseUrl, rawExact: false };
  }
  current = undefined;
  logger.error(
    "No HTTP handle reachable from the subgraph; webhook triggers are disabled",
  );
  return { transport: "none", baseUrl, rawExact: false };
}

// Test seam: drops the process-wide handler and lets a fresh server be wrapped.
export function resetWebhookRoutes(): void {
  current = undefined;
}
