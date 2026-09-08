import type { PaperlessClient } from "./client";
import { PaperlessApiError } from "./errors";

// PaperlessTask.COMPLETE_STATUSES — the terminal set a poll loop waits for.
// Lowercase, and `revoked` is not a retryable failure.
export const COMPLETE_STATUSES = ["success", "failure", "revoked"] as const;
export type TaskStatus =
  | "pending"
  | "started"
  | "success"
  | "failure"
  | "revoked";

export interface NormalizedTask {
  task_id: string;
  // Widened: a server may report a status this piece has not seen, and the
  // poll loop must not crash on one.
  status: string;
  task_type?: string;
  // v10 reports `related_document_ids`; v9 a single `related_document` derived
  // from the first id. Both land here, so an action never has to know which
  // version answered.
  document_ids: number[];
  document_id?: number;
  filename?: string;
  result?: string | null;
  date_created?: string;
  date_done?: string | null;
  raw: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// A paperless 2.18 server answers `related_document` as a *string* ("1") and
// its status in Celery's uppercase form ("SUCCESS"), while 3.x uses a list of
// ints and lowercase TextChoices. Both are coerced here so no caller has to
// know which server answered.
function toDocumentIds(value: unknown): number[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates
    .map((entry) =>
      typeof entry === "number"
        ? entry
        : typeof entry === "string" && entry.trim() !== ""
          ? Number(entry)
          : Number.NaN,
    )
    .filter((entry) => Number.isInteger(entry));
}

export function normalizeTask(row: unknown): NormalizedTask | undefined {
  if (!isRecord(row)) return undefined;
  const ids =
    row.related_document_ids !== undefined
      ? toDocumentIds(row.related_document_ids)
      : toDocumentIds(row.related_document);
  const inputData = isRecord(row.input_data) ? row.input_data : undefined;
  const filename =
    typeof inputData?.filename === "string"
      ? inputData.filename
      : typeof row.task_file_name === "string"
        ? row.task_file_name
        : undefined;
  return {
    task_id: typeof row.task_id === "string" ? row.task_id : "",
    // Lowercased: 2.18 reports SUCCESS/FAILURE/REVOKED, 3.x success/failure/
    // revoked, and the poll loop must terminate on either.
    status:
      typeof row.status === "string" ? row.status.toLowerCase() : "unknown",
    task_type:
      typeof row.task_type === "string"
        ? row.task_type
        : typeof row.task_name === "string"
          ? row.task_name
          : undefined,
    document_ids: ids,
    document_id: ids[0],
    filename,
    result: typeof row.result === "string" ? row.result : null,
    date_created:
      typeof row.date_created === "string" ? row.date_created : undefined,
    date_done: typeof row.date_done === "string" ? row.date_done : null,
    raw: row,
  };
}

export async function readTask(
  client: PaperlessClient,
  taskId: string,
): Promise<NormalizedTask | undefined> {
  // /api/tasks/ takes task_id directly (TasksViewSet.get_queryset), and its
  // envelope differs by version — client.list handles both.
  const { results } = await client.list<unknown>("tasks/", {
    task_id: taskId,
  });
  const match = results
    .map((row) => normalizeTask(row))
    .find((task) => task?.task_id === taskId);
  return match ?? normalizeTask(results[0]);
}

export function isComplete(status: string): boolean {
  return (COMPLETE_STATUSES as readonly string[]).includes(status);
}

export interface WaitOptions {
  timeoutMs: number;
  // Injected for tests; the default backs off with jitter.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls to a terminal status or the deadline. Deadline expiry is *not* an
// error: it returns the still-pending task so the workflow can hand the id to
// `get_task` in a later run rather than losing it.
export async function waitForTask(
  client: PaperlessClient,
  taskId: string,
  options: WaitOptions,
): Promise<NormalizedTask> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  const maxDelay = options.maxDelayMs ?? 5_000;
  let delay = options.initialDelayMs ?? 500;
  let last: NormalizedTask | undefined;

  for (;;) {
    last = await readTask(client, taskId);
    if (last && isComplete(last.status)) return last;
    const remaining = deadline - now();
    if (remaining <= 0) {
      return (
        last ?? {
          task_id: taskId,
          status: "pending",
          document_ids: [],
          raw: {},
        }
      );
    }
    // Jitter keeps a fleet of workers from polling in lockstep.
    const jittered = Math.min(delay * (0.5 + Math.random()), remaining);
    await sleep(Math.max(1, Math.round(jittered)));
    delay = Math.min(delay * 2, maxDelay);
  }
}

// Turns a terminal non-success into a typed error. `revoked` is distinct: the
// task was cancelled, so retrying the same upload is wrong.
export function assertTaskSucceeded(task: NormalizedTask): NormalizedTask {
  if (task.status === "success") return task;
  if (task.status === "failure") {
    throw new PaperlessApiError(
      `paperless-ngx failed to consume the document: ${task.result ?? "no detail reported"}`,
      { category: "validation", detail: task.raw },
    );
  }
  if (task.status === "revoked") {
    throw new PaperlessApiError(
      "The consumption task was revoked in paperless-ngx; the document was not created",
      { category: "config", detail: task.raw },
    );
  }
  return task;
}
