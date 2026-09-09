// Coordinator over the trigger_state row: it owns the binding registry, the
// lane, the clock, the worker and the timer; a driver owns what a kind does.
import {
  ensurePieceBundle,
  PieceWorker,
  type PieceWorkerResult,
  type TriggerHookRequest,
} from "@powerhousedao/reactor-connectors";
import { childLogger } from "document-model";
import type { TriggerStateRow, WorkflowRunStore } from "./store.js";
import {
  configHash,
  deliveryKindFor,
  parseStoreState,
  type PieceTriggerBinding,
  type TriggerBinding,
} from "./trigger-binding.js";
import type {
  EnableContext,
  TriggerDriver,
  TriggerDriverContext,
} from "./trigger-driver.js";
import {
  piecePollDriver,
  pieceWebhookDriver,
  scheduleDriver,
} from "./trigger-drivers.js";

const logger = childLogger(["workflow", "trigger-supervisor"]);

export type {
  PieceTriggerBinding,
  ScheduleTriggerBinding,
  TriggerBinding,
  TriggerDeliveryKind,
} from "./trigger-binding.js";
export {
  configHash,
  deliveryKindFor,
  intervalFromSchedules,
  pollIntervalFor,
  SCHEDULE_TRIGGER_KIND,
} from "./trigger-binding.js";

export interface TriggerSupervisorOptions {
  store: () => Promise<WorkflowRunStore | undefined>;
  resolveAuth: (connectionId: string | null | undefined) => Promise<unknown>;
  fire: (workflowId: string, payload: unknown, kind: string) => void;
  // The endpoint a WEBHOOK-strategy piece should register with its provider.
  // Absent for poll bindings, whose hooks must not receive a live URL.
  webhookUrlFor?: (workflowId: string) => Promise<string | undefined>;
  cacheDir: string;
  worker?: PieceWorker;
  tickMs?: number;
  defaultIntervalMs?: number;
  hookTimeoutMs?: number;
  // Clock override for tests; defaults to the wall clock.
  now?: () => Date;
}

export class TriggerSupervisor {
  private readonly bindings = new Map<string, TriggerBinding>();
  private readonly worker: PieceWorker;
  private readonly tickMs: number;
  private readonly defaultIntervalMs: number;
  private readonly hookTimeoutMs: number;
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  // Lifecycle ops serialize so enable/disable/poll never interleave per store.
  private ops: Promise<unknown> = Promise.resolve();
  private ticking = false;

  constructor(private readonly options: TriggerSupervisorOptions) {
    this.worker = options.worker ?? new PieceWorker();
    this.tickMs = options.tickMs ?? 15_000;
    this.defaultIntervalMs = options.defaultIntervalMs ?? 300_000;
    this.hookTimeoutMs = options.hookTimeoutMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error: unknown) => {
        logger.error("Trigger tick failed", error);
      });
    }, this.tickMs);
    this.timer.unref();
    logger.info(`Trigger supervisor started (tick ${this.tickMs}ms)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.options.worker) this.worker.dispose();
    logger.info("Trigger supervisor stopped");
  }

  // Serialized: registration churn and ticks share one lane.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.ops.then(task);
    this.ops = run.catch(() => undefined);
    return run;
  }

  // Successfully enabled workflows; identical re-registrations are no-ops.
  private readonly enabledOk = new Set<string>();

  private driverFor(binding: TriggerBinding): TriggerDriver {
    switch (deliveryKindFor(binding)) {
      case "schedule":
        return scheduleDriver;
      case "piece-poll":
        return piecePollDriver;
      case "piece-webhook":
        return pieceWebhookDriver;
    }
  }

  private driverContext(store: WorkflowRunStore): TriggerDriverContext {
    return {
      store,
      now: this.now,
      fire: this.options.fire,
      defaultIntervalMs: this.defaultIntervalMs,
      runHook: (binding, hook, storeState, hookOptions) =>
        this.hook(binding, hook, storeState, hookOptions),
      markUnhealthy: (workflowId) => this.enabledOk.delete(workflowId),
    };
  }

  upsert(binding: TriggerBinding): Promise<void> {
    const previous = this.bindings.get(binding.workflowId);
    if (
      previous &&
      this.enabledOk.has(binding.workflowId) &&
      JSON.stringify(previous) === JSON.stringify(binding)
    ) {
      return Promise.resolve();
    }
    this.bindings.set(binding.workflowId, binding);
    return this.enqueue(() => this.enable(binding));
  }

  remove(workflowId: string): Promise<void> {
    const binding = this.bindings.get(workflowId);
    this.bindings.delete(workflowId);
    this.enabledOk.delete(workflowId);
    return this.enqueue(() => this.disable(workflowId, binding));
  }

  // Design-time sample: the worker's "test" store prefix keeps cursors intact,
  // and no store state is persisted back.
  test(binding: PieceTriggerBinding): Promise<unknown> {
    return this.enqueue(async () => {
      const store = await this.options.store();
      const row = await store?.getTriggerState(binding.workflowId);
      const seed = row ? parseStoreState(row) : {};
      const result = await this.hook(binding, "test", seed);
      return result.output;
    });
  }

  // An inbound request for a WEBHOOK-strategy piece; shares the lane with
  // enable/disable so a delivery cannot race a re-registration.
  deliver(binding: PieceTriggerBinding, payload: unknown): Promise<number> {
    return this.enqueue(async () => {
      const store = await this.options.store();
      if (!store) throw new Error("Run journal is unavailable");
      return pieceWebhookDriver.deliver(
        binding,
        payload,
        this.driverContext(store),
      );
    });
  }

  // A poll binding gets an unroutable URL on purpose: nothing serves it, and
  // a live one would let a piece register an endpoint that never fires.
  private async webhookUrl(binding: PieceTriggerBinding): Promise<string> {
    if (binding.delivery !== "webhook") {
      return `http://localhost:0/v1/webhooks/${binding.workflowId}`;
    }
    const url = await this.options.webhookUrlFor?.(binding.workflowId);
    if (!url) {
      throw new Error(
        `No webhook endpoint available for workflow ${binding.workflowId}`,
      );
    }
    return url;
  }

  private async hook(
    binding: PieceTriggerBinding,
    hook: TriggerHookRequest["hook"],
    storeState: Record<string, unknown>,
    options: { isRepublish?: boolean; payload?: unknown } = {},
  ): Promise<PieceWorkerResult> {
    const bundle = await ensurePieceBundle({
      name: binding.packageName,
      version: binding.version,
      cacheDir: this.options.cacheDir,
    });
    const auth = await this.options.resolveAuth(binding.connectionId);
    return this.worker.runTriggerHook(
      {
        bundleDir: bundle.dir,
        triggerName: binding.triggerName,
        hook,
        propsValue: binding.config,
        auth,
        storeState,
        identity: { flowId: binding.workflowId },
        isRepublish: options.isRepublish,
        payload: options.payload,
        webhookUrl: await this.webhookUrl(binding),
      },
      { timeoutMs: this.hookTimeoutMs },
    );
  }

  // The row is written here for every kind; the driver only decides the
  // cursor, the cadence and whether the trigger armed at all.
  private async enable(binding: TriggerBinding): Promise<void> {
    const store = await this.options.store();
    if (!store) return;
    const hash = configHash(binding.blockType, binding.config);
    const existing = await store.getTriggerState(binding.workflowId);
    const isRepublish = existing?.config_hash === hash;
    if (existing && !isRepublish && existing.status === "ENABLED") {
      // The trigger changed: release the old registration first.
      await this.disableRow(binding.workflowId, existing);
    }
    const driver = this.driverFor(binding);
    const context: EnableContext = { existing, isRepublish };
    const ctx = this.driverContext(store);
    const now = this.now();
    const base = {
      workflow_id: binding.workflowId,
      block_type: binding.blockType,
      config_hash: hash,
      lease_owner: null,
      lease_expires_at: null,
      updated_at: now.toISOString(),
    };
    try {
      const state = await driver.arm(binding, context, ctx);
      await store.upsertTriggerState({
        ...base,
        status: "ENABLED",
        store_state: state.storeState,
        interval_ms: state.intervalMs,
        next_poll_at: state.nextPollAt,
        last_poll_at: state.lastPollAt,
        last_error: null,
        consecutive_failures: 0,
      });
      this.enabledOk.add(binding.workflowId);
      // Positional: a block type starts with `@`, which the logger reads as a
      // replacement token and would substitute away as "null".
      logger.info(
        "Enabled @block for workflow @workflow (@cadence)",
        binding.blockType,
        binding.workflowId,
        state.cadence,
      );
    } catch (error) {
      this.enabledOk.delete(binding.workflowId);
      const message = error instanceof Error ? error.message : String(error);
      const failed = driver.failedState(binding, context, ctx);
      // Arming failed: record the error and schedule nothing.
      await store.upsertTriggerState({
        ...base,
        status: "ERROR",
        store_state: failed.storeState,
        interval_ms: failed.intervalMs,
        next_poll_at: null,
        last_poll_at: failed.lastPollAt,
        last_error: message,
        consecutive_failures: (existing?.consecutive_failures ?? 0) + 1,
      });
      logger.error(
        "Enabling @block failed for workflow @workflow: @reason",
        binding.blockType,
        binding.workflowId,
        message,
      );
    }
  }

  private async disable(
    workflowId: string,
    binding?: TriggerBinding,
  ): Promise<void> {
    const store = await this.options.store();
    if (!store) return;
    const row = await store.getTriggerState(workflowId);
    if (!row || row.status === "DISABLED") return;
    await this.disableRow(workflowId, row, binding);
  }

  // store_state is kept: an unchanged re-enable republishes onto the cursor.
  private async disableRow(
    workflowId: string,
    row: TriggerStateRow,
    binding?: TriggerBinding,
  ): Promise<void> {
    const store = await this.options.store();
    if (!store) return;
    const target = binding ?? this.bindings.get(workflowId);
    if (target) {
      try {
        await this.driverFor(target).release?.(
          target,
          row,
          this.driverContext(store),
        );
      } catch (error) {
        logger.warn(`Releasing workflow ${workflowId} failed`, error);
      }
    }
    await store.setTriggerStatus(workflowId, "DISABLED");
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.enqueue(() => this.pollDue());
    } finally {
      this.ticking = false;
    }
  }

  private async pollDue(): Promise<void> {
    const store = await this.options.store();
    if (!store) return;
    const ctx = this.driverContext(store);
    const due = await store.listDueTriggerStates(this.now().toISOString());
    for (const row of due) {
      const binding = this.bindings.get(row.workflow_id);
      if (!binding) {
        // Zombie row: the registry no longer knows this workflow.
        await store.setTriggerStatus(row.workflow_id, "DISABLED");
        continue;
      }
      const driver = this.driverFor(binding);
      if (!driver.onDue) {
        // A request-driven kind should not come up due; clear the schedule
        // rather than spin on the row every tick.
        await store.recordPollSuccess(
          row.workflow_id,
          row.store_state,
          this.now().toISOString(),
          null,
        );
        continue;
      }
      await driver.onDue(binding, row, ctx);
    }
  }
}
