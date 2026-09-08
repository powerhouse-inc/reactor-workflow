// An offline paperless-ngx good enough to pin the contract the piece depends
// on: token auth, Accept-header versioning with a configurable ceiling, the
// v9/v10 task divergence, multipart upload, the object viewsets, the file
// endpoints' archive/original split, and workflow registration.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface MockDocument {
  id: number;
  title: string;
  content?: string;
  correspondent: number | null;
  document_type: number | null;
  storage_path: number | null;
  tags: number[];
  created: string;
  added: string;
  modified: string;
  archive_serial_number: number | null;
  original_file_name: string;
  has_archive_version: boolean;
  custom_fields?: { field: number; value: unknown }[];
  owner?: number | null;
}

export interface MockTask {
  id: number;
  task_id: string;
  task_type: string;
  trigger_source: string;
  status: "pending" | "started" | "success" | "failure" | "revoked";
  result?: string | null;
  related_document_ids: number[];
  input_data?: { filename?: string };
  date_created: string;
  date_done?: string | null;
  // Non-file multipart fields as they arrived, for upload assertions.
  uploadedFields?: Record<string, string | undefined>;
}

export interface MockNamedObject {
  id: number;
  name: string;
  slug?: string;
  color?: string;
  path?: string;
  data_type?: string;
  document_count?: number;
}

export interface MockWorkflow {
  id: number;
  name: string;
  order: number;
  enabled: boolean;
  triggers: Record<string, unknown>[];
  actions: Record<string, unknown>[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string[] | undefined>;
  accept?: string;
  authorization?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody: Buffer;
}

export interface MockOptions {
  token?: string;
  // Mirrors REST_FRAMEWORK["ALLOWED_VERSIONS"]; the default is the max.
  allowedVersions?: number[];
  serverVersion?: string;
  username?: string;
  permissions?: string[];
}

interface FailureRule {
  status: number;
  body?: unknown;
  times: number;
}

const DEFAULT_PERMISSIONS = [
  "view_document",
  "add_document",
  "change_document",
  "view_workflow",
  "add_workflow",
  "change_workflow",
  "delete_workflow",
  "view_tag",
  "add_tag",
];

export class MockPaperless {
  readonly requests: RecordedRequest[] = [];
  readonly documents = new Map<number, MockDocument>();
  readonly tasks = new Map<string, MockTask>();
  readonly tags = new Map<number, MockNamedObject>();
  readonly correspondents = new Map<number, MockNamedObject>();
  readonly documentTypes = new Map<number, MockNamedObject>();
  readonly storagePaths = new Map<number, MockNamedObject>();
  readonly customFields = new Map<number, MockNamedObject>();
  readonly workflows = new Map<number, MockWorkflow>();
  readonly bulkEdits: Record<string, unknown>[] = [];
  readonly files = new Map<number, { archive?: Buffer; original: Buffer }>();

  private server?: Server;
  private port = 0;
  private nextId = 1;
  private readonly failures = new Map<string, FailureRule>();
  private readonly options: Required<MockOptions>;

  constructor(options: MockOptions = {}) {
    this.options = {
      token: options.token ?? "test-token",
      allowedVersions: options.allowedVersions ?? [9, 10],
      serverVersion: options.serverVersion ?? "3.1.3",
      username: options.username ?? "archivist",
      permissions: options.permissions ?? DEFAULT_PERMISSIONS,
    };
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get maxVersion(): number {
    return Math.max(...this.options.allowedVersions);
  }

  allocateId(): number {
    return this.nextId++;
  }

  // Forces the next `times` matching requests to fail; "METHOD /path" keys.
  failOnce(key: string, status: number, body?: unknown, times = 1): void {
    this.failures.set(key, { status, body, times });
  }

  seedDocument(partial: Partial<MockDocument> = {}): MockDocument {
    const id = partial.id ?? this.allocateId();
    const now = new Date("2026-09-01T10:00:00Z").toISOString();
    const document: MockDocument = {
      id,
      title: `Document ${id}`,
      content: "extracted text",
      correspondent: null,
      document_type: null,
      storage_path: null,
      tags: [],
      created: now,
      added: now,
      modified: now,
      archive_serial_number: null,
      original_file_name: `document-${id}.pdf`,
      has_archive_version: true,
      ...partial,
    };
    this.documents.set(document.id, document);
    this.files.set(document.id, {
      original: Buffer.from(`original-${document.id}`),
      archive: document.has_archive_version
        ? Buffer.from(`archive-${document.id}`)
        : undefined,
    });
    return document;
  }

  seedObject(
    kind: "tags" | "correspondents" | "document_types" | "storage_paths" | "custom_fields",
    partial: Partial<MockNamedObject> = {},
  ): MockNamedObject {
    const id = partial.id ?? this.allocateId();
    const object: MockNamedObject = { id, name: `${kind}-${id}`, ...partial };
    this.collectionFor(kind).set(id, object);
    return object;
  }

  seedTask(partial: Partial<MockTask> = {}): MockTask {
    const task: MockTask = {
      id: this.allocateId(),
      task_id: partial.task_id ?? randomUUID(),
      task_type: "consume_file",
      trigger_source: "api_upload",
      status: "pending",
      related_document_ids: [],
      date_created: new Date("2026-09-01T10:00:00Z").toISOString(),
      ...partial,
    };
    this.tasks.set(task.task_id, task);
    return task;
  }

  private collectionFor(kind: string): Map<number, MockNamedObject> {
    switch (kind) {
      case "tags":
        return this.tags;
      case "correspondents":
        return this.correspondents;
      case "document_types":
        return this.documentTypes;
      case "storage_paths":
        return this.storagePaths;
      case "custom_fields":
        return this.customFields;
      default:
        throw new Error(`Unknown object collection ${kind}`);
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((request, response) => {
        void this.handle(request).then((result) => {
          response.writeHead(result.status, {
            "Content-Type": result.contentType ?? "application/json",
            ...result.headers,
          });
          response.end(result.body);
        });
      });
      const server = this.server;
      server.listen(0, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage): Promise<{
    status: number;
    body?: string | Buffer;
    contentType?: string;
    headers?: Record<string, string>;
  }> {
    const rawBody = await readBody(request);
    const url = new URL(request.url ?? "/", "http://mock");
    const path = url.pathname.replace(/^\/api/, "") || "/";
    const query: Record<string, string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      query[key] = url.searchParams.getAll(key);
    }
    const recorded: RecordedRequest = {
      method: request.method ?? "GET",
      path,
      query,
      accept: header(request, "accept"),
      authorization: header(request, "authorization"),
      headers: request.headers as Record<string, string | string[] | undefined>,
      rawBody,
      body: parseMaybeJson(rawBody, header(request, "content-type")),
    };
    this.requests.push(recorded);

    const failureKey = `${recorded.method} ${path}`;
    const failure = this.failures.get(failureKey);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return this.json(failure.status, failure.body ?? { detail: "forced failure" });
    }

    if (recorded.authorization !== `Token ${this.options.token}`) {
      return this.json(401, { detail: "Invalid token." });
    }

    // Accept-header versioning, exactly as DRF's AcceptHeaderVersioning does:
    // no version means the server default (its maximum), and anything outside
    // ALLOWED_VERSIONS is 406.
    const requested = /version=(\d+)/.exec(recorded.accept ?? "")?.[1];
    const effective = requested ? Number(requested) : this.maxVersion;
    if (requested && !this.options.allowedVersions.includes(effective)) {
      return this.json(406, { detail: 'Invalid version in "Accept" header.' });
    }

    return this.route(recorded, effective, url);
  }

  private route(
    request: RecordedRequest,
    version: number,
    url: URL,
  ): {
    status: number;
    body?: string | Buffer;
    contentType?: string;
    headers?: Record<string, string>;
  } {
    const { method, path } = request;
    const versionHeaders = {
      "X-Api-Version": String(version),
      "X-Version": this.options.serverVersion,
    };

    if (path === "/ui_settings/" && method === "GET") {
      return this.json(
        200,
        {
          user: {
            id: 1,
            username: this.options.username,
            is_staff: true,
            is_superuser: false,
            groups: [],
          },
          settings: { version: this.options.serverVersion },
          permissions: this.options.permissions,
        },
        versionHeaders,
      );
    }

    if (path === "/documents/post_document/" && method === "POST") {
      const parts = parseMultipart(request.rawBody, request.headers["content-type"]);
      const document = parts.find((part) => part.name === "document");
      if (!document) {
        return this.json(400, { document: ["No file was submitted."] }, versionHeaders);
      }
      const task = this.seedTask({
        input_data: { filename: document.filename },
      });
      task.uploadedFields = Object.fromEntries(
        parts
          .filter((part) => part.name !== "document")
          .map((part) => [part.name, part.value.toString("utf8")]),
      );
      return this.json(200, task.task_id, versionHeaders);
    }

    if (path === "/tasks/" && method === "GET") {
      const taskId = request.query.task_id?.[0];
      const taskType = request.query.task_type?.[0];
      const triggerSource = request.query.trigger_source?.[0];
      // PaperlessTaskFilterSet.filter_name matches input_data__filename
      // *icontains*, which is why the client re-checks the name exactly.
      const nameLike = request.query.name?.[0];
      const createdAfter = request.query.date_created_after?.[0];
      const rows = [...this.tasks.values()].filter((task) => {
        if (taskId !== undefined && task.task_id !== taskId) return false;
        if (taskType !== undefined && task.task_type !== taskType) return false;
        if (triggerSource !== undefined && task.trigger_source !== triggerSource) {
          return false;
        }
        if (
          nameLike !== undefined &&
          !(task.input_data?.filename ?? "")
            .toLowerCase()
            .includes(nameLike.toLowerCase())
        ) {
          return false;
        }
        if (createdAfter !== undefined && task.date_created < createdAfter) {
          return false;
        }
        return true;
      });
      const serialized = rows.map((task) => serializeTask(task, version));
      // v9 does not paginate this endpoint.
      return this.json(
        200,
        version < 10
          ? serialized
          : { count: serialized.length, next: null, previous: null, results: serialized },
        versionHeaders,
      );
    }

    const documentFile = /^\/documents\/(\d+)\/(download|preview|thumb)\/$/.exec(path);
    if (documentFile && method === "GET") {
      const id = Number(documentFile[1]);
      const variant = documentFile[2];
      const document = this.documents.get(id);
      const stored = this.files.get(id);
      if (!document || !stored) {
        return this.json(404, { detail: "Not found." }, versionHeaders);
      }
      if (variant === "thumb") {
        return {
          status: 200,
          body: Buffer.from(`thumb-${id}`),
          contentType: "image/webp",
          headers: versionHeaders,
        };
      }
      const original = url.searchParams.get("original") === "true";
      const useArchive = !original && document.has_archive_version;
      const body = useArchive ? (stored.archive ?? stored.original) : stored.original;
      return {
        status: 200,
        body,
        contentType: "application/pdf",
        headers: {
          ...versionHeaders,
          "Content-Disposition": `${variant === "preview" ? "inline" : "attachment"}; filename="${document.original_file_name}"`,
        },
      };
    }

    const documentDetail = /^\/documents\/(\d+)\/$/.exec(path);
    if (documentDetail) {
      const id = Number(documentDetail[1]);
      const document = this.documents.get(id);
      if (!document) return this.json(404, { detail: "Not found." }, versionHeaders);
      if (method === "GET") {
        return this.json(200, document, versionHeaders);
      }
      if (method === "PATCH" || method === "PUT") {
        const patch = (request.body ?? {}) as Partial<MockDocument>;
        const updated = { ...document, ...patch, modified: new Date().toISOString() };
        this.documents.set(id, updated);
        return this.json(200, updated, versionHeaders);
      }
    }

    if (path === "/documents/bulk_edit/" && method === "POST") {
      this.bulkEdits.push((request.body ?? {}) as Record<string, unknown>);
      return this.json(200, { result: "OK" }, versionHeaders);
    }

    if (path === "/documents/" && method === "GET") {
      let rows = [...this.documents.values()];
      const addedAfter = request.query.added__gt?.[0];
      if (addedAfter) {
        rows = rows.filter((row) => row.added > addedAfter);
      }
      const modifiedAfter = request.query.modified__gt?.[0];
      if (modifiedAfter) {
        rows = rows.filter((row) => row.modified > modifiedAfter);
      }
      const titleContains = request.query.title__icontains?.[0];
      if (titleContains) {
        rows = rows.filter((row) =>
          row.title.toLowerCase().includes(titleContains.toLowerCase()),
        );
      }
      const ordering = request.query.ordering?.[0];
      if (ordering === "added") rows.sort((a, b) => a.added.localeCompare(b.added));
      const query = request.query.query?.[0];
      const results = rows.map((row) =>
        query
          ? { ...row, __search_hit__: { score: 1, highlights: row.title, rank: 0 } }
          : row,
      );
      return this.json(
        200,
        { count: results.length, next: null, previous: null, results },
        versionHeaders,
      );
    }

    const objectCollection =
      /^\/(tags|correspondents|document_types|storage_paths|custom_fields)\/$/.exec(path);
    if (objectCollection) {
      const kind = objectCollection[1];
      const collection = this.collectionFor(kind);
      if (method === "GET") {
        const iexact = request.query.name__iexact?.[0];
        const icontains = request.query.name__icontains?.[0];
        let rows = [...collection.values()];
        if (iexact !== undefined) {
          rows = rows.filter(
            (row) => row.name.toLowerCase() === iexact.toLowerCase(),
          );
        }
        if (icontains !== undefined) {
          rows = rows.filter((row) =>
            row.name.toLowerCase().includes(icontains.toLowerCase()),
          );
        }
        return this.json(
          200,
          { count: rows.length, next: null, previous: null, results: rows },
          versionHeaders,
        );
      }
      if (method === "POST") {
        const payload = (request.body ?? {}) as Partial<MockNamedObject>;
        const created: MockNamedObject = {
          id: this.allocateId(),
          name: payload.name ?? "unnamed",
          ...payload,
        };
        collection.set(created.id, created);
        return this.json(201, created, versionHeaders);
      }
    }

    if (path === "/workflows/" && method === "POST") {
      const payload = (request.body ?? {}) as Record<string, unknown>;
      const created = this.materializeWorkflow(payload);
      return this.json(201, created, versionHeaders);
    }

    if (path === "/workflows/" && method === "GET") {
      const rows = [...this.workflows.values()];
      return this.json(
        200,
        { count: rows.length, next: null, previous: null, results: rows },
        versionHeaders,
      );
    }

    const workflowDetail = /^\/workflows\/(\d+)\/$/.exec(path);
    if (workflowDetail) {
      const id = Number(workflowDetail[1]);
      const existing = this.workflows.get(id);
      if (!existing) return this.json(404, { detail: "Not found." }, versionHeaders);
      if (method === "GET") return this.json(200, existing, versionHeaders);
      if (method === "PATCH" || method === "PUT") {
        const payload = (request.body ?? {}) as Record<string, unknown>;
        const updated = this.materializeWorkflow(
          { ...existing, ...payload },
          id,
        );
        return this.json(200, updated, versionHeaders);
      }
      if (method === "DELETE") {
        this.workflows.delete(id);
        return { status: 204, headers: versionHeaders };
      }
    }

    const triggerDetail = /^\/workflow_(triggers|actions)\/(\d+)\/$/.exec(path);
    if (triggerDetail && method === "DELETE") {
      return { status: 204, headers: versionHeaders };
    }

    return this.json(404, { detail: "Not found." }, versionHeaders);
  }

  // Mirrors WorkflowSerializer.update_triggers_and_actions: nested triggers and
  // actions are created (or updated when they carry an id) in one request, and
  // the response echoes them back with ids.
  private materializeWorkflow(
    payload: Record<string, unknown>,
    reuseId?: number,
  ): MockWorkflow {
    const id = reuseId ?? this.allocateId();
    const triggers = (Array.isArray(payload.triggers) ? payload.triggers : []).map(
      (trigger) => {
        const record = trigger as Record<string, unknown>;
        return {
          ...record,
          id: typeof record.id === "number" ? record.id : this.allocateId(),
        };
      },
    );
    const actions = (Array.isArray(payload.actions) ? payload.actions : []).map(
      (action, index) => {
        const record = action as Record<string, unknown>;
        const webhook = record.webhook as Record<string, unknown> | undefined;
        return {
          ...record,
          order: index,
          id: typeof record.id === "number" ? record.id : this.allocateId(),
          webhook: webhook
            ? {
                ...webhook,
                id:
                  typeof webhook.id === "number" ? webhook.id : this.allocateId(),
              }
            : undefined,
        };
      },
    );
    const workflow: MockWorkflow = {
      id,
      name: typeof payload.name === "string" ? payload.name : `workflow-${id}`,
      order: typeof payload.order === "number" ? payload.order : 0,
      enabled: payload.enabled !== false,
      triggers,
      actions,
    };
    this.workflows.set(id, workflow);
    return workflow;
  }

  private json(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): { status: number; body: string; contentType: string; headers: Record<string, string> } {
    return {
      status,
      body: JSON.stringify(body),
      contentType: "application/json",
      headers,
    };
  }
}

// v9 renamed two fields relative to v10 (TaskSerializerV9): a single
// `related_document` derived from the first result id, plus `task_file_name`.
function serializeTask(task: MockTask, version: number): Record<string, unknown> {
  const base = {
    id: task.id,
    task_id: task.task_id,
    task_type: task.task_type,
    status: task.status,
    result: task.result ?? null,
    date_created: task.date_created,
    date_done: task.date_done ?? null,
  };
  if (version < 10) {
    return {
      ...base,
      task_file_name: task.input_data?.filename ?? null,
      related_document: task.related_document_ids[0] ?? null,
    };
  }
  return {
    ...base,
    related_document_ids: task.related_document_ids,
    input_data: task.input_data,
  };
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function parseMaybeJson(raw: Buffer, contentType?: string): unknown {
  if (raw.byteLength === 0) return undefined;
  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  value: Buffer;
}

// Minimal multipart/form-data reader: enough to assert what the upload action
// actually put on the wire, including repeated fields.
export function parseMultipart(
  raw: Buffer,
  contentType: string | string[] | undefined,
): MultipartPart[] {
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type ?? "");
  if (!boundary) return [];
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts: MultipartPart[] = [];
  let cursor = raw.indexOf(marker);
  while (cursor !== -1) {
    const start = cursor + marker.byteLength;
    if (raw.subarray(start, start + 2).toString() === "--") break;
    const next = raw.indexOf(marker, start);
    const chunk = raw.subarray(start + 2, next === -1 ? raw.byteLength : next - 2);
    const split = chunk.indexOf("\r\n\r\n");
    if (split !== -1) {
      const rawHeaders = chunk.subarray(0, split).toString("utf8");
      const value = chunk.subarray(split + 4);
      const name = /name="([^"]+)"/.exec(rawHeaders)?.[1];
      if (name) {
        parts.push({
          name,
          filename: /filename="([^"]*)"/.exec(rawHeaders)?.[1],
          contentType: /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders)?.[1],
          value,
        });
      }
    }
    cursor = next;
  }
  return parts;
}

export async function startMockPaperless(
  options: MockOptions = {},
): Promise<MockPaperless> {
  const mock = new MockPaperless(options);
  await mock.start();
  return mock;
}
