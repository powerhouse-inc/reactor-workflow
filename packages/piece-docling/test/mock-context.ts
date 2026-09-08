// Hand-built ActionContext (spike S6a pattern): the members the piece reads
// are real; everything else throws named, so any undocumented dependency
// fails loudly in tests instead of in production.
type Stub = { (...args: never[]): never };

function throwingStub(name: string): Stub {
  // A rest-param arrow cannot be the first call argument (the parser reads the
  // leading `...` as a spread), so the expression is hoisted to a const.
  const fn = (..._args: unknown[]): never => {
    throw new Error(`unsupported context member: ${name}`);
  };
  return Object.assign(fn, {});
}

export interface MockActionContext {
  executionType: "BEGIN";
  propsValue: Record<string, unknown>;
  auth: unknown;
  store: {
    put: (k: string, v: unknown) => Promise<unknown>;
    get: (k: string) => Promise<unknown>;
    delete: (k: string) => Promise<void>;
  };
  connections: Stub;
  tags: Stub;
  server: Stub;
  files: Stub;
  output: Stub;
  agent: { tools: unknown[] };
  run: {
    id: string;
    stop: Stub;
    pause: Stub;
    respond: Stub;
  };
  project: {
    id: string;
    externalId: () => Promise<string>;
  };
  flows: {
    list: Stub;
    current: { id: string; version: { id: string } };
  };
  step: { name: string };
  generateResumeUrl: Stub;
}

export function makeActionContext(propsValue: Record<string, unknown>, auth?: unknown): MockActionContext {
  // Dynamic keys at runtime, so Map (not a static Record) per store semantics.
  const store = new Map<string, unknown>();
  return {
    executionType: "BEGIN",
    propsValue,
    auth,
    store: {
      put: async (k: string, v: unknown) => v,
      get: async (k: string) => store.get(k) ?? null,
      delete: async (k: string) => {
        store.delete(k);
      },
    },
    connections: throwingStub("connections"),
    tags: throwingStub("tags"),
    server: throwingStub("server"),
    files: throwingStub("files"),
    output: throwingStub("output"),
    agent: { tools: [] as unknown[] },
    run: {
      id: "test-run",
      stop: throwingStub("run.stop"),
      pause: throwingStub("run.pause"),
      respond: throwingStub("run.respond"),
    },
    project: {
      id: "test-project",
      externalId: async () => "test-project",
    },
    flows: {
      list: throwingStub("flows.list"),
      current: { id: "test-flow", version: { id: "v1" } },
    },
    step: { name: "test-step" },
    generateResumeUrl: throwingStub("generateResumeUrl"),
  };
}
