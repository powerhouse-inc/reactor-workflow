import { readAuth } from "./auth-value";
import { UmhClient } from "./client";

// The subset of Activepieces' Store the piece uses. Declared structurally so
// actions and triggers stay testable without building a whole context.
export interface StoreLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
}

export interface UmhRunContext {
  auth?: unknown;
  propsValue?: Record<string, unknown>;
  store?: StoreLike;
}

export function clientFor(auth: unknown): UmhClient {
  return new UmhClient(readAuth(auth));
}

export function clientForContext(context: UmhRunContext): UmhClient {
  return clientFor(context.auth);
}
