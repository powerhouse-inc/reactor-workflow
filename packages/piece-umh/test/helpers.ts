// The context members these actions and triggers actually read: auth,
// propsValue and store. Building one by hand keeps the tests independent of the
// Activepieces runtime, which the bundle-conformance test covers separately.
export class MemoryStore {
  readonly entries = new Map<string, unknown>();

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  put(key: string, value: unknown): Promise<unknown> {
    this.entries.set(key, value);
    return Promise.resolve(value);
  }
}

export function authFor(baseUrl: string): unknown {
  // The shape the reactor hands piece code (engine/connections.ts
  // shapeAuthValue), not the flat one Activepieces passes to `validate`.
  return { type: "CUSTOM_AUTH", props: { base_url: baseUrl } };
}

export interface RunnableLike<P> {
  run(context: P): Promise<unknown>;
}

export function contextFor(
  baseUrl: string,
  propsValue: Record<string, unknown> = {},
  store: MemoryStore = new MemoryStore(),
): { auth: unknown; propsValue: Record<string, unknown>; store: MemoryStore } {
  return { auth: authFor(baseUrl), propsValue, store };
}

// Awaits a call that must fail and hands back the error it threw. Written as a
// helper because `promise.catch(e => e as UmhApiError)` types the result as the
// union of the error and the success value, which every assertion then has to
// narrow again.
export async function failure<T>(promise: Promise<T>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected the call to fail, but it succeeded");
}
