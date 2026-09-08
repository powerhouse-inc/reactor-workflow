import type { MockPaperless } from "./mock-paperless";

// The context members these actions actually read: propsValue, auth, store and
// files. Building one by hand keeps the action tests independent of the
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

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

export interface WrittenFile {
  fileName: string;
  data: Buffer;
}

// Stands in for the host's AttachmentBridge: records what the piece wrote and
// hands back a reference, exactly as ctx.files.write does.
export class RecordingFiles {
  readonly written: WrittenFile[] = [];

  write(file: { fileName: string; data: Buffer }): Promise<string> {
    this.written.push(file);
    return Promise.resolve(`apfile://${this.written.length}`);
  }
}

export interface RunOptions {
  auth?: unknown;
  props?: Record<string, unknown>;
  store?: MemoryStore;
  files?: RecordingFiles;
}

interface RunnableAction {
  // The real ActionContext is generic over the piece's auth and prop shapes.
  // Tests hand the action only the members it reads, so the parameter type is
  // deliberately loose here rather than reconstructed.
  run: (context: any) => Promise<unknown>;
}

export function authFor(mock: MockPaperless, token = "test-token"): unknown {
  return {
    type: "CUSTOM_AUTH",
    props: { base_url: mock.baseUrl, token },
  };
}

export function runAction(
  action: RunnableAction,
  options: RunOptions = {},
): Promise<unknown> {
  return action.run({
    auth: options.auth,
    propsValue: options.props ?? {},
    store: options.store ?? new MemoryStore(),
    files: options.files ?? new RecordingFiles(),
    run: { id: "test-run" },
    step: { name: "test-step" },
  });
}

// Polls a condition instead of sleeping a guessed interval: the first request
// of a run pays undici's cold start, which a fixed delay tends to lose to.
export async function waitFor<T>(
  probe: () => T | undefined,
  { timeoutMs = 2000, everyMs = 5 }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
