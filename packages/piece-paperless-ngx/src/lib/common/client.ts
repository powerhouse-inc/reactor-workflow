import type { PaperlessCredentials } from "./auth-value";
import { describeDrfError, PaperlessApiError } from "./errors";

// paperless-ngx versions its API through the Accept header. The field shapes
// we depend on differ between 9 and 10 (`related_document_ids` vs
// `related_document`, and a paginated vs. plain tasks list), so the version is
// pinned per connection — but pinned to what the *server* supports, not to a
// constant. Observed ceilings: 2.14.x -> 7, 2.18.x -> 9, 3.x -> 10.
export const PREFERRED_API_VERSION = 10;
export const MINIMUM_API_VERSION = 9;

export type HttpVerb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// Remembers the negotiated version between action runs. Backed by ctx.store,
// so the 406-and-retry below happens once per connection rather than per run.
export interface VersionCache {
  get(): Promise<number | undefined>;
  set(version: number): Promise<void>;
}

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | (string | number)[];

export interface RequestOptions {
  method?: HttpVerb;
  // Relative to `<base>/api/`, e.g. "documents/12/".
  path: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  responseType?: "json" | "text" | "binary";
  // The negotiation probe: send no version header so the server answers with
  // its own default, which is its maximum.
  omitVersion?: boolean;
  timeoutMs?: number;
}

export interface PaperlessResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface UiSettings {
  username: string;
  isSuperuser: boolean;
  permissions: string[];
  serverVersion?: string;
  apiVersion?: number;
}

export interface PaperlessClientOptions {
  fetchImpl?: typeof fetch;
  versionCache?: VersionCache;
  // Pre-negotiated version; skips discovery entirely.
  apiVersion?: number;
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function appendQuery(url: URL, query: Record<string, QueryValue>): void {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      // Paperless takes repeated params for multi-valued fields (tags on
      // upload, for one); a comma-joined list is a different filter.
      for (const entry of value) url.searchParams.append(key, String(entry));
      continue;
    }
    url.searchParams.append(key, String(value));
  }
}

export class PaperlessClient {
  private readonly fetchImpl: typeof fetch;
  private readonly versionCache?: VersionCache;
  private readonly defaultTimeoutMs: number;
  // Set once the server confirmed a version (either from the cache or from a
  // negotiation probe). While undefined we are guessing PREFERRED.
  private negotiated?: number;

  constructor(
    readonly credentials: PaperlessCredentials,
    options: PaperlessClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.versionCache = options.versionCache;
    this.negotiated = options.apiVersion;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // The version actually in use, negotiating first if that has not happened.
  async apiVersion(): Promise<number> {
    if (this.negotiated !== undefined) return this.negotiated;
    const cached = await this.versionCache?.get();
    if (cached !== undefined) {
      this.negotiated = cached;
      return cached;
    }
    return PREFERRED_API_VERSION;
  }

  url(path: string, query?: Record<string, QueryValue>): URL {
    const clean = path.replace(/^\/+/, "");
    const url = new URL(`${this.credentials.baseUrl}/api/${clean}`);
    if (query) appendQuery(url, query);
    return url;
  }

  async request<T = unknown>(
    options: RequestOptions,
  ): Promise<PaperlessResponse<T>> {
    const attempt = await this.send<T>(options);
    if (attempt.status !== 406 || options.omitVersion) {
      return this.finish<T>(attempt, options);
    }
    // 406 means the pinned version is not in the server's ALLOWED_VERSIONS.
    // Discover what it does support, remember it, and replay the request once.
    const version = await this.negotiate();
    const replay = await this.send<T>(options, version);
    return this.finish<T>(replay, options);
  }

  // Reads the server's own default version off any authenticated response,
  // then pins the highest version we both understand.
  private async negotiate(): Promise<number> {
    const probe = await this.send<unknown>({
      path: "ui_settings/",
      omitVersion: true,
    });
    // Throws with the mapped error when even the unversioned probe fails.
    if (probe.status >= 400) this.finish(probe, { path: "ui_settings/" });
    const advertised = Number(probe.headers.get("x-api-version"));
    const serverMax = Number.isFinite(advertised) ? advertised : 0;
    if (serverMax < MINIMUM_API_VERSION) {
      const server = probe.headers.get("x-version") ?? "unknown";
      throw new PaperlessApiError(
        `This paperless-ngx server speaks API version ${serverMax || "?"} at most; ` +
          `the piece needs ${MINIMUM_API_VERSION} or newer (server version ${server}, ` +
          `which means paperless-ngx 2.18 or later)`,
        { status: 406, category: "api_version" },
      );
    }
    const pinned = Math.min(PREFERRED_API_VERSION, serverMax);
    this.negotiated = pinned;
    await this.versionCache?.set(pinned);
    return pinned;
  }

  private async send<T>(
    options: RequestOptions,
    versionOverride?: number,
  ): Promise<PaperlessResponse<T>> {
    const url = this.url(options.path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Token ${this.credentials.token}`,
      ...options.headers,
    };
    if (!options.omitVersion) {
      const version = versionOverride ?? (await this.apiVersion());
      headers.Accept = `application/json; version=${version}`;
    } else {
      headers.Accept = "application/json";
    }
    let body = options.body;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }
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
      throw new PaperlessApiError(
        aborted
          ? `paperless-ngx did not answer ${url.pathname} in time`
          : `Could not reach paperless-ngx at ${this.credentials.baseUrl}: ${message}`,
        { category: aborted ? "timeout" : "network", retryable: true },
      );
    } finally {
      clearTimeout(timeout);
    }
    return {
      status: response.status,
      headers: response.headers,
      data: (await this.readBody(response, options.responseType)) as T,
    };
  }

  private async readBody(
    response: Response,
    responseType: RequestOptions["responseType"],
  ): Promise<unknown> {
    if (response.status === 204) return undefined;
    if (responseType === "binary") {
      return Buffer.from(await response.arrayBuffer());
    }
    const text = await response.text();
    if (text === "") return undefined;
    if (responseType === "text") return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A non-JSON body on a 2xx means the base URL is not a paperless API.
      return text;
    }
  }

  private finish<T>(
    response: PaperlessResponse<T>,
    options: RequestOptions,
  ): PaperlessResponse<T> {
    if (response.status < 400) return response;
    throw this.toError(response, options);
  }

  private toError(
    response: PaperlessResponse<unknown>,
    options: RequestOptions,
  ): PaperlessApiError {
    const detail = describeDrfError(response.data);
    const where = `${options.method ?? "GET"} /api/${options.path.replace(/^\/+/, "")}`;
    switch (true) {
      case response.status === 400 || response.status === 422:
        return new PaperlessApiError(
          `paperless-ngx rejected ${where}: ${detail ?? "invalid request"}`,
          { status: response.status, category: "validation", detail: response.data },
        );
      case response.status === 401:
        return new PaperlessApiError(
          "paperless-ngx rejected the API token — mint a new one under My Profile",
          { status: 401, category: "credential", detail: response.data },
        );
      case response.status === 403:
        return new PaperlessApiError(
          `The API token lacks permission for ${where}${detail ? `: ${detail}` : ""}`,
          { status: 403, category: "permission", detail: response.data },
        );
      case response.status === 404:
        return new PaperlessApiError(
          `${where} was not found — check the id, or that ${this.credentials.baseUrl} is a paperless-ngx server`,
          { status: 404, category: "not_found", detail: response.data },
        );
      case response.status === 406:
        return new PaperlessApiError(
          `paperless-ngx does not support the requested API version${detail ? `: ${detail}` : ""}`,
          { status: 406, category: "api_version", detail: response.data },
        );
      case response.status === 429:
        return new PaperlessApiError(
          "paperless-ngx is rate limiting this connection",
          { status: 429, category: "rate_limit", retryable: true },
        );
      case response.status >= 500:
        return new PaperlessApiError(
          `paperless-ngx failed on ${where} (HTTP ${response.status})`,
          { status: response.status, category: "server", retryable: true, detail: response.data },
        );
      default:
        return new PaperlessApiError(
          `Unexpected HTTP ${response.status} from ${where}${detail ? `: ${detail}` : ""}`,
          { status: response.status, category: "server", detail: response.data },
        );
    }
  }

  // Identity, server version and the caller's permission list in one call.
  // `permissions` is what the trigger's registration preflight needs, and it
  // arrives here for free (UiSettingsView returns get_all_permissions() with
  // the app-label prefix stripped).
  async uiSettings(): Promise<UiSettings> {
    const response = await this.request<Record<string, unknown>>({
      path: "ui_settings/",
    });
    const body = response.data ?? {};
    const user = (body.user ?? {}) as Record<string, unknown>;
    const settings = (body.settings ?? {}) as Record<string, unknown>;
    const advertised = Number(response.headers.get("x-api-version"));
    return {
      username: typeof user.username === "string" ? user.username : "unknown",
      isSuperuser: user.is_superuser === true,
      permissions: Array.isArray(body.permissions)
        ? body.permissions.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      serverVersion:
        typeof settings.version === "string" ? settings.version : undefined,
      apiVersion: Number.isFinite(advertised) ? advertised : undefined,
    };
  }

  // Both list envelopes: v10 paginates every collection, while v9 returns
  // /api/tasks/ as a plain array (TasksViewSet.paginate_queryset returns None
  // below version 10).
  static resultsOf<T>(body: unknown): T[] {
    if (Array.isArray(body)) return body as T[];
    if (typeof body === "object" && body !== null) {
      const results = (body as { results?: unknown }).results;
      if (Array.isArray(results)) return results as T[];
    }
    return [];
  }

  async list<T>(
    path: string,
    query?: Record<string, QueryValue>,
  ): Promise<{ count: number; next: string | null; results: T[] }> {
    const response = await this.request<unknown>({ path, query });
    const results = PaperlessClient.resultsOf<T>(response.data);
    const envelope: { count?: unknown; next?: unknown } =
      typeof response.data === "object" &&
      response.data !== null &&
      !Array.isArray(response.data)
        ? (response.data as { count?: unknown; next?: unknown })
        : {};
    return {
      count: typeof envelope.count === "number" ? envelope.count : results.length,
      next: typeof envelope.next === "string" ? envelope.next : null,
      results,
    };
  }

  // Walks pages until `limit` items or the pages run out. Used by the trigger's
  // catch-up sweep and by object lookups.
  async listAll<T>(
    path: string,
    query: Record<string, QueryValue> = {},
    limit = 200,
  ): Promise<T[]> {
    const collected: T[] = [];
    let page = 1;
    for (;;) {
      const { results, next } = await this.list<T>(path, {
        ...query,
        page,
        page_size: Math.min(100, limit),
      });
      collected.push(...results);
      if (collected.length >= limit || next === null || results.length === 0) {
        return collected.slice(0, limit);
      }
      page += 1;
    }
  }
}
