import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StagedFile } from "../context/files.js";
import type {
  RecordedListener,
  RecordedSchedule,
} from "../context/trigger.js";
import type {
  CheckConnectionRequest,
  DescribePieceRequest,
  HostCallHandlers,
  HostCallMessage,
  HostCallResponse,
  ResolveOptionsRequest,
  RunActionRequest,
  SerializedPieceError,
  TriggerHookRequest,
  WorkerResponse,
} from "./protocol.js";

type WorkerRequestType =
  | "run"
  | "resolve-options"
  | "trigger-hook"
  | "check-connection"
  | "describe";

type WorkerRequest =
  | RunActionRequest
  | ResolveOptionsRequest
  | TriggerHookRequest
  | CheckConnectionRequest
  | DescribePieceRequest;

export class PieceWorkerError extends Error {
  readonly serialized: SerializedPieceError;

  constructor(serialized: SerializedPieceError) {
    super(`${serialized.name}: ${serialized.message}`);
    this.name = "PieceWorkerError";
    this.serialized = serialized;
  }
}

export class PieceWorkerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Piece action timed out after ${timeoutMs}ms; worker was replaced`);
    this.name = "PieceWorkerTimeoutError";
  }
}

export class PieceWorkerExitError extends Error {
  constructor(code: number | null, signal: string | null) {
    super(`Piece worker exited unexpectedly (code=${code}, signal=${signal})`);
    this.name = "PieceWorkerExitError";
  }
}

export interface PieceWorkerResult {
  output: unknown;
  touched: string[];
  tlsPoisoned: boolean;
  // run only: files the piece wrote through ctx.files, staged on disk for the
  // host to ingest before the output is journalled.
  files?: StagedFile[];
  // trigger-hook only: final store contents plus captured context calls.
  storeState?: Record<string, unknown>;
  schedules?: RecordedSchedule[];
  listeners?: RecordedListener[];
}

export interface PieceWorkerOptions {
  // Absolute path to the compiled worker entry; defaults to dist/worker-entry.js.
  entryPath?: string;
  defaultTimeoutMs?: number;
}

function defaultEntryPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not locate package root");
    dir = parent;
  }
  const entry = path.join(dir, "dist", "worker-entry.js");
  if (!existsSync(entry)) {
    throw new Error(`Worker entry not built at ${entry} — run pnpm build`);
  }
  return entry;
}

// Executes piece actions in a child process. Side-effects (TLS env poisoning,
// crashes) stay in the child; a timed-out or crashed worker is replaced.
export class PieceWorker {
  private readonly entryPath: string;
  private readonly defaultTimeoutMs: number;
  private child: ChildProcess | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(options: PieceWorkerOptions = {}) {
    this.entryPath = options.entryPath ?? defaultEntryPath();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  // Runs are serialized per worker; a pool composes multiple workers later.
  runAction(
    request: RunActionRequest,
    options: { timeoutMs?: number; hostCalls?: HostCallHandlers } = {},
  ): Promise<PieceWorkerResult> {
    return this.enqueue("run", request, options.timeoutMs, options.hostCalls);
  }

  // Design-time DROPDOWN options() / DYNAMIC props() resolution.
  resolveOptions(
    request: ResolveOptionsRequest,
    options: { timeoutMs?: number } = {},
  ): Promise<PieceWorkerResult> {
    return this.enqueue("resolve-options", request, options.timeoutMs);
  }

  // A piece's app.checkConnection over resolved credentials; the output is a
  // CheckConnectionOutcome.
  checkConnection(
    request: CheckConnectionRequest,
    options: { timeoutMs?: number } = {},
  ): Promise<PieceWorkerResult> {
    return this.enqueue("check-connection", request, options.timeoutMs);
  }

  // The piece's design-time descriptor; the output is a ConnectorDescriptor.
  describePiece(
    request: DescribePieceRequest,
    options: { timeoutMs?: number } = {},
  ): Promise<PieceWorkerResult> {
    return this.enqueue("describe", request, options.timeoutMs);
  }

  // One trigger lifecycle hook; the caller owns storeState persistence.
  runTriggerHook(
    request: TriggerHookRequest,
    options: { timeoutMs?: number } = {},
  ): Promise<PieceWorkerResult> {
    return this.enqueue("trigger-hook", request, options.timeoutMs);
  }

  private enqueue(
    type: WorkerRequestType,
    request: WorkerRequest,
    timeoutMs?: number,
    hostCalls?: HostCallHandlers,
  ): Promise<PieceWorkerResult> {
    const run = this.queue.then(() =>
      this.execute(type, request, timeoutMs ?? this.defaultTimeoutMs, hostCalls),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.child?.kill("SIGKILL");
    this.child = undefined;
  }

  private spawn(): ChildProcess {
    if (this.child) return this.child;
    // Empty env: the child gets no host secrets and no inherited TLS overrides.
    this.child = fork(this.entryPath, [], {
      env: {},
      execArgv: [],
      serialization: "advanced",
      // Piece stdout/stderr are dropped for now; log capture arrives with journaling.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child.once("exit", () => {
      this.child = undefined;
    });
    return this.child;
  }

  private execute(
    type: WorkerRequestType,
    request: WorkerRequest,
    timeoutMs: number,
    hostCalls?: HostCallHandlers,
  ): Promise<PieceWorkerResult> {
    const child = this.spawn();
    const id = this.nextId++;

    return new Promise<PieceWorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        child.kill("SIGKILL");
        this.child = undefined;
        reject(new PieceWorkerTimeoutError(timeoutMs));
      }, timeoutMs);

      const onMessage = (response: WorkerResponse | HostCallMessage) => {
        // Ids come from two counters; dispatch on type before comparing them.
        if (response.type === "host-call") return;
        if (response.id !== id) return;
        cleanup();
        if (response.type === "result") {
          resolve({
            output: response.output,
            touched: response.touched,
            tlsPoisoned: response.tlsPoisoned,
            files: response.files,
            storeState: response.storeState,
            schedules: response.schedules,
            listeners: response.listeners,
          });
        } else {
          reject(new PieceWorkerError(response.error));
        }
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new PieceWorkerExitError(code, signal));
      };

      // Served outside the request queue: the queue is held by this very
      // request, so routing a call through it would deadlock the step.
      const onHostCall = (message: WorkerResponse | HostCallMessage) => {
        if (message.type !== "host-call") return;
        void this.serveHostCall(child, message, hostCalls);
      };

      const cleanup = () => {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("message", onHostCall);
        child.off("exit", onExit);
      };

      child.on("message", onMessage);
      child.on("message", onHostCall);
      child.on("exit", onExit);
      child.send({ id, type, request });
    });
  }

  // Answers one call from the child. The handler set belongs to the request in
  // flight, so a call arriving after the step returned is refused, not served.
  private async serveHostCall(
    child: ChildProcess,
    message: HostCallMessage,
    handlers: HostCallHandlers | undefined,
  ): Promise<void> {
    let response: HostCallResponse;
    try {
      const handler = handlers?.[message.method];
      if (!handler) {
        throw new Error(`No host handler for "${message.method}"`);
      }
      response = {
        id: message.id,
        type: "host-result",
        value: await handler(message.payload),
      };
    } catch (error) {
      response = {
        id: message.id,
        type: "host-result",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // A worker killed on timeout takes its pending calls with it.
    if (child.connected) child.send(response);
  }
}
