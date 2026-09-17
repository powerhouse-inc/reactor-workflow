import { readAuth } from "./auth-value";
import { PaperlessClient, type VersionCache } from "./client";

// The subset of Activepieces' Store the piece uses. Declared structurally so
// the actions stay testable without building a whole ActionContext.
export interface StoreLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
}

export interface PaperlessRunContext {
  auth?: unknown;
  propsValue?: Record<string, unknown>;
  store?: StoreLike;
}

function versionKey(baseUrl: string): string {
  // Per host: one flow may hold connections to two archives.
  try {
    return `paperless:api-version:${new URL(baseUrl).host}`;
  } catch {
    return "paperless:api-version";
  }
}

// Caches the negotiated API version in the piece store, so the 406-then-probe
// exchange happens once per connection instead of once per run.
function versionCacheFor(baseUrl: string, store?: StoreLike): VersionCache {
  const key = versionKey(baseUrl);
  return {
    async get() {
      if (!store) return undefined;
      const value = await store.get(key);
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
    },
    async set(version: number) {
      await store?.put(key, version);
    },
  };
}

export function clientFor(
  auth: unknown,
  store?: StoreLike,
): PaperlessClient {
  const credentials = readAuth(auth);
  return new PaperlessClient(credentials, {
    versionCache: versionCacheFor(credentials.baseUrl, store),
  });
}

export function clientForContext(context: PaperlessRunContext): PaperlessClient {
  return clientFor(context.auth, context.store);
}
