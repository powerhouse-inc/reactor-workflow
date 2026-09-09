import { createAction, Property } from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import type { PaperlessClient } from "../common/client";
import { clientForContext, type StoreLike } from "../common/context";
import { trimContent } from "../common/documents";
import { PaperlessApiError } from "../common/errors";
import { normalizeFile } from "../common/files";
import { objectMultiPicker, objectPicker } from "../common/pickers";
import {
  assertTaskSucceeded,
  isComplete,
  normalizeTask,
  waitForTask,
  type NormalizedTask,
} from "../common/tasks";
import { uploadOutputFields } from "../common/output-schemas";

// paperless consumes duplicates by default (pre_check_duplicate only rejects
// when PAPERLESS_CONSUMER_DELETE_DUPLICATES is set, and it is not by default),
// so a step that uploads, then dies mid-poll, then retries really does create
// a second document. The upload endpoint has no idempotency key, so the guard
// is to look for the consumption task the previous attempt started.
const ADOPT_WINDOW_MS = 15 * 60_000;

const TASK_STORE_PREFIX = "paperless:upload-task:";

// Remembered with the time it was written, because the store branch has to
// honour the same adoption window as the server-side lookup: a bare id with no
// timestamp would be adopted forever, so a step that uploaded once could never
// upload that filename and size again.
interface RememberedTask {
  task_id: string;
  at: number;
}

function readRemembered(value: unknown, windowMs: number): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { task_id, at } = value as Partial<RememberedTask>;
  if (typeof task_id !== "string" || task_id === "") return undefined;
  if (typeof at !== "number" || Date.now() - at > windowMs) return undefined;
  return task_id;
}

async function findAdoptableTask(
  client: PaperlessClient,
  filename: string,
  windowMs: number,
): Promise<NormalizedTask | undefined> {
  const since = new Date(Date.now() - windowMs).toISOString();
  // `name` filters on input_data__filename__icontains, so the exact match is
  // re-checked client-side; date_created_after bounds the window.
  const { results } = await client.list<unknown>("tasks/", {
    task_type: "consume_file",
    trigger_source: "api_upload",
    date_created_after: since,
    name: filename,
    ordering: "-date_created",
  });
  return results
    .map((row) => normalizeTask(row))
    .find(
      (task): task is NormalizedTask =>
        task !== undefined &&
        task.filename === filename &&
        task.status !== "failure" &&
        task.status !== "revoked",
    );
}

export const uploadDocument = createAction({
  auth: paperlessAuth,
  name: "upload_document",
  displayName: "Upload document",
  description:
    "Uploads a file for consumption and, by default, waits for paperless to finish creating the document.",
  audience: "both",
  aiMetadata: { idempotent: false },
  outputSchema: { fields: uploadOutputFields },
  props: {
    file: Property.File({
      displayName: "File",
      required: true,
    }),
    title: Property.ShortText({ displayName: "Title", required: false }),
    created: Property.ShortText({
      displayName: "Created date",
      description: "ISO date or datetime; paperless infers one when omitted.",
      required: false,
    }),
    correspondent: objectPicker("correspondents"),
    document_type: objectPicker("document_types"),
    storage_path: objectPicker("storage_paths"),
    tags: objectMultiPicker("tags"),
    archive_serial_number: Property.Number({
      displayName: "Archive serial number",
      required: false,
    }),
    custom_fields: Property.Json({
      displayName: "Custom fields",
      description:
        'Either a map of field id to value ({"3": "ACME"}) or a list of field ids to attach empty ([3, 4]).',
      required: false,
    }),
    wait_for_consumption: Property.Checkbox({
      displayName: "Wait for consumption",
      description:
        "The upload returns a task id before the document exists. Waiting resolves the document id; the step's own timeoutSeconds must cover the wait.",
      required: false,
      defaultValue: true,
    }),
    timeout_seconds: Property.Number({
      displayName: "Wait timeout (seconds)",
      description:
        "Capped by the step timeout. On expiry the action returns the pending task instead of failing, so a later Get task can finish the job.",
      required: false,
      defaultValue: 300,
    }),
    include_document: Property.Checkbox({
      displayName: "Return the created document",
      required: false,
      defaultValue: true,
    }),
    include_content: Property.Checkbox({
      displayName: "Include OCR text in the returned document",
      required: false,
      defaultValue: false,
    }),
    adopt_existing_task: Property.Checkbox({
      displayName: "Resume a previous attempt",
      description:
        "Before uploading, adopt a matching consumption task started in the last 15 minutes instead of uploading a second copy. Turn off for deliberate re-uploads of the same file.",
      required: false,
      defaultValue: true,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    const props = context.propsValue as {
      file?: unknown;
      title?: string;
      created?: string;
      correspondent?: number;
      document_type?: number;
      storage_path?: number;
      tags?: number[];
      archive_serial_number?: number;
      custom_fields?: unknown;
      wait_for_consumption?: boolean;
      timeout_seconds?: number;
      include_document?: boolean;
      include_content?: boolean;
      adopt_existing_task?: boolean;
    };
    const file = normalizeFile(props.file, props.title);
    const store = context.store as StoreLike | undefined;
    const storeKey = `${TASK_STORE_PREFIX}${file.filename}:${file.buffer.byteLength}`;

    let taskId: string | undefined;
    let adopted = false;

    if (props.adopt_existing_task !== false) {
      // The piece store is the cheap path, but it lives in the worker process
      // and a timeout replaces that worker — so the server-side lookup is the
      // one that actually survives the case this guards against.
      const remembered = readRemembered(
        await store?.get(storeKey),
        ADOPT_WINDOW_MS,
      );
      if (remembered !== undefined) {
        taskId = remembered;
        adopted = true;
      } else {
        const existing = await findAdoptableTask(
          client,
          file.filename,
          ADOPT_WINDOW_MS,
        );
        if (existing) {
          taskId = existing.task_id;
          adopted = true;
        }
      }
    }

    if (!taskId) {
      const form = new FormData();
      form.append(
        "document",
        new Blob([new Uint8Array(file.buffer)], { type: file.contentType }),
        file.filename,
      );
      if (props.title) form.append("title", props.title);
      if (props.created) form.append("created", props.created);
      if (props.correspondent)
        form.append("correspondent", String(props.correspondent));
      if (props.document_type)
        form.append("document_type", String(props.document_type));
      if (props.storage_path)
        form.append("storage_path", String(props.storage_path));
      // Repeated field, one entry per tag — a comma-joined list is rejected.
      for (const tag of props.tags ?? []) form.append("tags", String(tag));
      if (props.archive_serial_number !== undefined)
        form.append(
          "archive_serial_number",
          String(props.archive_serial_number),
        );
      if (props.custom_fields !== undefined && props.custom_fields !== null) {
        // The endpoint takes a map of id -> value or a bare list of ids.
        form.append("custom_fields", JSON.stringify(props.custom_fields));
      }

      // Content-Type is left unset so the runtime writes the multipart
      // boundary; this endpoint accepts multipart only.
      const response = await client.request<unknown>({
        method: "POST",
        path: "documents/post_document/",
        body: form,
      });
      const returned = response.data;
      if (typeof returned !== "string" || returned === "") {
        throw new PaperlessApiError(
          "paperless-ngx accepted the upload but returned no consumption task id",
          { category: "server", detail: returned },
        );
      }
      taskId = returned;
      await store?.put(storeKey, {
        task_id: taskId,
        at: Date.now(),
      } satisfies RememberedTask);
    }

    if (props.wait_for_consumption === false) {
      return { task_id: taskId, status: "pending", adopted };
    }

    const timeoutSeconds = props.timeout_seconds ?? 300;
    const task = await waitForTask(client, taskId, {
      timeoutMs: Math.max(1, timeoutSeconds) * 1000,
    });

    if (!isComplete(task.status)) {
      // Not a failure: the id is the handle a later Get task step can use.
      return {
        task_id: taskId,
        status: task.status,
        adopted,
        timed_out: true,
      };
    }

    // Cleared on any terminal status, not just success: a remembered id whose
    // task ended in failure or revoked has nothing left to adopt, and leaving
    // it behind made every later attempt re-read that same failure instead of
    // uploading again.
    await store?.put(storeKey, null);
    assertTaskSucceeded(task);

    const result: Record<string, unknown> = {
      task_id: taskId,
      status: task.status,
      document_id: task.document_id ?? null,
      adopted,
    };

    if (props.include_document !== false && task.document_id !== undefined) {
      const document = await client.request<Record<string, unknown>>({
        path: `documents/${task.document_id}/`,
      });
      result.document = trimContent(
        document.data,
        props.include_content === true,
      );
    }
    return result;
  },
});
