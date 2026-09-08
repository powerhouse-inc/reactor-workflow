import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bulkEditDocuments } from "../src/lib/actions/bulk-edit-documents";
import { findOrCreateObject } from "../src/lib/actions/find-or-create-object";
import { updateDocument } from "../src/lib/actions/update-document";
import { uploadDocument } from "../src/lib/actions/upload-document";
import { normalizeFile } from "../src/lib/common/files";
import type { MockPaperless } from "./mock-paperless";
import { parseMultipart, startMockPaperless } from "./mock-paperless";
import { authFor, MemoryStore, runAction, waitFor } from "./helpers";

let mock: MockPaperless;

beforeEach(async () => {
  mock = await startMockPaperless();
});

afterEach(async () => {
  await mock.close();
});

describe("normalizeFile", () => {
  const bytes = Buffer.from("%PDF-1.7 scan");

  it("accepts an ApFile from the Activepieces picker", () => {
    const file = normalizeFile({ filename: "scan.pdf", data: bytes });
    expect(file.buffer.equals(bytes)).toBe(true);
    expect(file.contentType).toBe("application/pdf");
  });

  it("accepts a Buffer flattened by JSON IPC", () => {
    const file = normalizeFile({
      filename: "scan.pdf",
      data: { type: "Buffer", data: [...bytes] },
    });
    expect(file.buffer.equals(bytes)).toBe(true);
  });

  it("accepts a base64 string from host hydration", () => {
    const file = normalizeFile(
      { filename: "scan.png", data: bytes.toString("base64") },
      undefined,
    );
    expect(file.buffer.equals(bytes)).toBe(true);
    expect(file.contentType).toBe("image/png");
  });

  it("accepts a bare data URI and reads the name from it", () => {
    const uri = `data:application/pdf;name=invoice.pdf;base64,${bytes.toString("base64")}`;
    const file = normalizeFile(uri);
    expect(file.filename).toBe("invoice.pdf");
    expect(file.buffer.equals(bytes)).toBe(true);
  });

  it("refuses an empty or missing file with an actionable message", () => {
    expect(() => normalizeFile(undefined)).toThrow(/No file was provided/);
    expect(() => normalizeFile({ filename: "x.pdf", data: "" })).toThrow(
      /no readable bytes/,
    );
  });
});

describe("upload_document", () => {
  const file = { filename: "scan.pdf", data: Buffer.from("%PDF-1.7 scan") };

  it("posts multipart with repeated tag fields and resolves the document", async () => {
    const store = new MemoryStore();
    const promise = runAction(uploadDocument, {
      auth: authFor(mock),
      props: {
        file,
        title: "Invoice Q3",
        tags: [11, 12],
        correspondent: 5,
        wait_for_consumption: true,
        timeout_seconds: 5,
      },
      store,
    });

    // The consumption task completes while the action polls.
    const task = await waitFor(() => [...mock.tasks.values()][0]);
    const document = mock.seedDocument({ title: "Invoice Q3" });
    task.status = "success";
    task.related_document_ids = [document.id];

    const result = (await promise) as Record<string, unknown>;

    expect(result.status).toBe("success");
    expect(result.document_id).toBe(document.id);
    expect((result.document as Record<string, unknown>).title).toBe("Invoice Q3");
    expect(result.document).not.toHaveProperty("content");

    const upload = mock.requests.find(
      (request) => request.path === "/documents/post_document/",
    );
    const parts = parseMultipart(upload!.rawBody, upload!.headers["content-type"]);
    expect(parts.find((part) => part.name === "document")?.filename).toBe(
      "scan.pdf",
    );
    expect(parts.filter((part) => part.name === "tags").map((p) => p.value.toString())).toEqual([
      "11",
      "12",
    ]);
    expect(parts.find((part) => part.name === "title")?.value.toString()).toBe(
      "Invoice Q3",
    );
    expect(parts.find((part) => part.name === "correspondent")?.value.toString()).toBe(
      "5",
    );
  });

  it("returns the task id without waiting when asked", async () => {
    const result = (await runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, wait_for_consumption: false },
    })) as Record<string, unknown>;

    expect(result.status).toBe("pending");
    expect(typeof result.task_id).toBe("string");
  });

  it("adopts the previous attempt's task instead of uploading twice", async () => {
    // What the retried step sees: a consume_file task for the same filename,
    // started by the attempt whose worker was replaced mid-poll.
    const existing = mock.seedTask({
      status: "started",
      input_data: { filename: "scan.pdf" },
      date_created: new Date().toISOString(),
    });

    const result = (await runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, wait_for_consumption: false },
    })) as Record<string, unknown>;

    expect(result.adopted).toBe(true);
    expect(result.task_id).toBe(existing.task_id);
    expect(
      mock.requests.filter(
        (request) => request.path === "/documents/post_document/",
      ),
    ).toHaveLength(0);
  });

  it("uploads again when adoption is turned off", async () => {
    mock.seedTask({
      status: "started",
      input_data: { filename: "scan.pdf" },
      date_created: new Date().toISOString(),
    });

    const result = (await runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, wait_for_consumption: false, adopt_existing_task: false },
    })) as Record<string, unknown>;

    expect(result.adopted).toBe(false);
    expect(
      mock.requests.filter(
        (request) => request.path === "/documents/post_document/",
      ),
    ).toHaveLength(1);
  });

  it("ignores a task for a different file", async () => {
    mock.seedTask({
      status: "started",
      input_data: { filename: "other-scan.pdf" },
      date_created: new Date().toISOString(),
    });

    const result = (await runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, wait_for_consumption: false },
    })) as Record<string, unknown>;

    expect(result.adopted).toBe(false);
  });

  it("finishes the wait on a 2.18 server's uppercase status", async () => {
    await mock.close();
    mock = await startMockPaperless({
      allowedVersions: [9],
      serverVersion: "2.18.4",
    });

    const promise = runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, wait_for_consumption: true, timeout_seconds: 10 },
    });
    const task = await waitFor(() => [...mock.tasks.values()][0]);
    const document = mock.seedDocument();
    task.status = "success";
    task.related_document_ids = [document.id];

    const result = (await promise) as Record<string, unknown>;
    expect(result.status).toBe("success");
    expect(result.document_id).toBe(document.id);
    expect(result.timed_out).toBeUndefined();
  });

  it("returns the pending task rather than failing when the wait expires", async () => {
    const result = (await runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, wait_for_consumption: true, timeout_seconds: 0.05 },
    })) as Record<string, unknown>;

    expect(result.timed_out).toBe(true);
    expect(result.status).toBe("pending");
    expect(typeof result.task_id).toBe("string");
  });

  it("fails distinctly on a failed and on a revoked task", async () => {
    const failing = runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, timeout_seconds: 5, adopt_existing_task: false },
    });
    const first = await waitFor(() => [...mock.tasks.values()][0]);
    first.status = "failure";
    first.result = "It is a duplicate of Invoice (#4)";
    await expect(failing).rejects.toThrow(/duplicate of Invoice/);

    const revoking = runAction(uploadDocument, {
      auth: authFor(mock),
      props: { file, timeout_seconds: 5, adopt_existing_task: false },
    });
    const second = await waitFor(() =>
      [...mock.tasks.values()].length > 1
        ? [...mock.tasks.values()].at(-1)
        : undefined,
    );
    second.status = "revoked";
    await expect(revoking).rejects.toThrow(/revoked/);
  });
});

describe("update_document", () => {
  it("adds tags through the server-side bulk edit, not a read-modify-write", async () => {
    const document = mock.seedDocument({ tags: [1] });

    await runAction(updateDocument, {
      auth: authFor(mock),
      props: { id: document.id, tags: [2, 3], tag_mode: "add" },
    });

    expect(mock.bulkEdits).toEqual([
      {
        documents: [document.id],
        method: "modify_tags",
        parameters: { add_tags: [2, 3], remove_tags: [] },
      },
    ]);
    // No PATCH: nothing outside tags changed.
    expect(
      mock.requests.filter((request) => request.method === "PATCH"),
    ).toHaveLength(0);
  });

  it("removes tags the same way", async () => {
    const document = mock.seedDocument({ tags: [1, 2] });

    await runAction(updateDocument, {
      auth: authFor(mock),
      props: { id: document.id, tags: [2], tag_mode: "remove" },
    });

    expect(mock.bulkEdits[0].parameters).toEqual({
      add_tags: [],
      remove_tags: [2],
    });
  });

  it("replaces the whole tag list with a PATCH when asked", async () => {
    const document = mock.seedDocument({ tags: [1, 2] });

    const result = (await runAction(updateDocument, {
      auth: authFor(mock),
      props: { id: document.id, tags: [9], tag_mode: "replace", title: "New" },
    })) as Record<string, unknown>;

    expect(mock.bulkEdits).toHaveLength(0);
    expect(result.tags).toEqual([9]);
    expect(result.title).toBe("New");
  });

  it("patches metadata and drops the OCR text from the result", async () => {
    const document = mock.seedDocument({ content: "x".repeat(3000) });

    const result = (await runAction(updateDocument, {
      auth: authFor(mock),
      props: { id: document.id, title: "Renamed", correspondent: 7 },
    })) as Record<string, unknown>;

    expect(result.title).toBe("Renamed");
    expect(result.correspondent).toBe(7);
    expect(result).not.toHaveProperty("content");
  });
});

describe("bulk_edit_documents", () => {
  it("shapes modify_tags parameters", async () => {
    const result = (await runAction(bulkEditDocuments, {
      auth: authFor(mock),
      props: {
        document_ids: [1, "2"],
        method: "modify_tags",
        parameters: { add_tags: [5], remove_tags: [6] },
      },
    })) as Record<string, unknown>;

    expect(result.result).toBe("OK");
    expect(mock.bulkEdits[0]).toEqual({
      documents: [1, 2],
      method: "modify_tags",
      parameters: { add_tags: [5], remove_tags: [6] },
    });
  });

  it("passes a single-id method straight through", async () => {
    await runAction(bulkEditDocuments, {
      auth: authFor(mock),
      props: {
        document_ids: [4],
        method: "set_correspondent",
        parameters: { correspondent: 8 },
      },
    });

    expect(mock.bulkEdits[0].parameters).toEqual({ correspondent: 8 });
  });

  it("refuses an empty selection and an unsupported method", async () => {
    await expect(
      runAction(bulkEditDocuments, {
        auth: authFor(mock),
        props: { document_ids: [], method: "add_tag" },
      }),
    ).rejects.toThrow(/at least one document id/i);

    await expect(
      runAction(bulkEditDocuments, {
        auth: authFor(mock),
        props: { document_ids: [1], method: "reprocess" },
      }),
    ).rejects.toThrow(/Unsupported bulk edit method/);
  });
});

describe("find_or_create_object", () => {
  it("finds an existing object case-insensitively", async () => {
    const tag = mock.seedObject("tags", { name: "Receipts" });

    const result = (await runAction(findOrCreateObject, {
      auth: authFor(mock),
      props: { object_type: "tags", name: "receipts" },
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ id: tag.id, created: false });
    expect(mock.requests.at(-1)?.query.name__iexact).toEqual(["receipts"]);
  });

  it("creates the object with its type-specific extras", async () => {
    const result = (await runAction(findOrCreateObject, {
      auth: authFor(mock),
      props: {
        object_type: "tags",
        name: "Utilities",
        extras: { color: "#a6cee3", is_inbox_tag: false },
      },
    })) as Record<string, unknown>;

    expect(result).toMatchObject({ name: "Utilities", created: true });
    expect(mock.requests.at(-1)?.body).toEqual({
      name: "Utilities",
      color: "#a6cee3",
      is_inbox_tag: false,
    });
  });

  it("creates a storage path with its template", async () => {
    const result = (await runAction(findOrCreateObject, {
      auth: authFor(mock),
      props: {
        object_type: "storage_paths",
        name: "By year",
        extras: { path: "{{ created_year }}/{{ correspondent }}" },
      },
    })) as Record<string, unknown>;

    expect(result.created).toBe(true);
    expect(mock.requests.at(-1)?.path).toBe("/storage_paths/");
  });
});
