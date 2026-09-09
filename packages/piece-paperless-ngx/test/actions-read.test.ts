import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPaperlessConnection } from "../src/lib/auth";
import { customApiCall } from "../src/lib/actions/custom-api-call";
import { getDocument } from "../src/lib/actions/get-document";
import { getDocumentFile } from "../src/lib/actions/get-document-file";
import { getTask } from "../src/lib/actions/get-task";
import { searchDocuments } from "../src/lib/actions/search-documents";
import type { MockPaperless } from "./mock-paperless";
import { startMockPaperless } from "./mock-paperless";
import {
  authFor,
  MemoryStore,
  RecordingFiles,
  runAction,
} from "./helpers";

let mock: MockPaperless;

beforeEach(async () => {
  mock = await startMockPaperless();
});

afterEach(async () => {
  await mock.close();
});

describe("get_document", () => {
  it("omits the OCR text by default and keeps it on request", async () => {
    const document = mock.seedDocument({ content: "a".repeat(5000) });

    const trimmed = (await runAction(getDocument, {
      auth: authFor(mock),
      props: { id: document.id },
    })) as Record<string, unknown>;
    expect(trimmed.id).toBe(document.id);
    expect(trimmed).not.toHaveProperty("content");

    const full = (await runAction(getDocument, {
      auth: authFor(mock),
      props: { id: document.id, include_content: true },
    })) as Record<string, unknown>;
    expect(full.content).toHaveLength(5000);
  });

  it("passes a version through", async () => {
    const document = mock.seedDocument();
    await runAction(getDocument, {
      auth: authFor(mock),
      props: { id: document.id, version: 3 },
    });
    expect(mock.requests.at(-1)?.query.version).toEqual(["3"]);
  });
});

describe("search_documents", () => {
  it("rejects an unknown mode instead of returning the whole archive", async () => {
    mock.seedDocument({ title: "Invoice Q3" });
    mock.seedDocument({ title: "Unrelated" });

    // An unknown mode used to index MODE_PARAM to undefined and write the
    // literal key "undefined"; paperless ignores the unknown param, so the
    // step answered with every document in the archive.
    await expect(
      runAction(searchDocuments, {
        auth: authFor(mock),
        props: { mode: "title", term: "invoice" },
      }),
    ).rejects.toThrow(/Unknown search mode "title"/);
  });

  it("uses the query parameter for full text and keeps the search hit", async () => {
    mock.seedDocument({ title: "Invoice Q3" });

    const result = (await runAction(searchDocuments, {
      auth: authFor(mock),
      props: { mode: "full_text", term: "invoice" },
    })) as { count: number; results: Record<string, unknown>[] };

    expect(mock.requests.at(-1)?.query.query).toEqual(["invoice"]);
    expect(result.count).toBe(1);
    expect(result.results[0].__search_hit__).toBeDefined();
    expect(result.results[0]).not.toHaveProperty("content");
  });

  it("maps each mode onto its own parameter", async () => {
    for (const [mode, param, value] of [
      ["substring", "text", "rent"],
      ["title_only", "title_search", "rent"],
    ] as const) {
      await runAction(searchDocuments, {
        auth: authFor(mock),
        props: { mode, term: value },
      });
      expect(mock.requests.at(-1)?.query[param]).toEqual([value]);
    }

    await runAction(searchDocuments, {
      auth: authFor(mock),
      props: { mode: "more_like", document_id: 12 },
    });
    expect(mock.requests.at(-1)?.query.more_like_id).toEqual(["12"]);
  });

  it("filters tags conjunctively", async () => {
    await runAction(searchDocuments, {
      auth: authFor(mock),
      props: { mode: "substring", term: "x", tags: [3, 4] },
    });
    expect(mock.requests.at(-1)?.query.tags__id__all).toEqual(["3,4"]);
  });

  it("refuses a mode without its input", async () => {
    await expect(
      runAction(searchDocuments, {
        auth: authFor(mock),
        props: { mode: "full_text" },
      }),
    ).rejects.toThrow(/search term is required/);
    await expect(
      runAction(searchDocuments, {
        auth: authFor(mock),
        props: { mode: "more_like" },
      }),
    ).rejects.toThrow(/needs a document id/);
  });
});

describe("get_task", () => {
  it("reports nothing rather than a stranger's task when the filter is ignored", async () => {
    // A server that does not honour the task_id filter answers with the whole
    // list. Falling back to its first row reported someone else's task — and
    // through waitForTask, would have handed upload_document that task's
    // document id as the newly uploaded one.
    mock.seedTask({ status: "success", related_document_ids: [7] });
    mock.seedTask({ status: "success", related_document_ids: [8] });
    mock.ignoreTaskIdFilter = true;

    const result = (await runAction(getTask, {
      auth: authFor(mock),
      props: { task_id: "00000000-0000-0000-0000-000000000000" },
    })) as Record<string, unknown>;

    expect(result.status).toBe("unknown");
    expect(result.task_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("normalizes the v10 task shape", async () => {
    const task = mock.seedTask({
      status: "success",
      related_document_ids: [42],
      input_data: { filename: "scan.pdf" },
    });

    const result = (await runAction(getTask, {
      auth: authFor(mock),
      props: { task_id: task.task_id },
    })) as Record<string, unknown>;

    expect(result.status).toBe("success");
    expect(result.document_id).toBe(42);
    expect(result.filename).toBe("scan.pdf");
  });

  it("normalizes the 2.18 task shape to the same fields", async () => {
    await mock.close();
    mock = await startMockPaperless({
      allowedVersions: [9],
      serverVersion: "2.18.4",
    });
    const task = mock.seedTask({
      status: "success",
      related_document_ids: [42],
      input_data: { filename: "scan.pdf" },
    });

    const result = (await runAction(getTask, {
      auth: authFor(mock),
      props: { task_id: task.task_id },
    })) as Record<string, unknown>;

    // A 2.18 server sends "SUCCESS" and related_document as the string "42";
    // both have to land on the same fields a 3.x server produces, or the
    // consumption poll never terminates.
    expect((result.raw as Record<string, unknown>).status).toBe("SUCCESS");
    expect((result.raw as Record<string, unknown>).related_document).toBe("42");
    expect(result.status).toBe("success");
    expect(result.document_id).toBe(42);
    expect(result.filename).toBe("scan.pdf");
    expect(result.task_type).toBe("consume_file");
  });

  it("reports an unknown task rather than failing", async () => {
    const result = (await runAction(getTask, {
      auth: authFor(mock),
      props: { task_id: "00000000-0000-0000-0000-000000000000" },
    })) as Record<string, unknown>;
    expect(result.status).toBe("unknown");
  });
});

describe("get_document_file", () => {
  it("serves the archive copy by default and the original on request", async () => {
    const document = mock.seedDocument({ has_archive_version: true });
    const files = new RecordingFiles();

    const archive = (await runAction(getDocumentFile, {
      auth: authFor(mock),
      props: { id: document.id, variant: "archive" },
      files,
    })) as Record<string, unknown>;

    expect(files.written[0].data.toString()).toBe(`archive-${document.id}`);
    expect(archive.ref).toBe("apfile://1");
    expect(archive.filename).toBe(document.original_file_name);
    expect(archive.mime_type).toBe("application/pdf");
    expect(mock.requests.at(-1)?.query.original).toBeUndefined();

    await runAction(getDocumentFile, {
      auth: authFor(mock),
      props: { id: document.id, variant: "original" },
      files,
    });
    expect(files.written[1].data.toString()).toBe(`original-${document.id}`);
    expect(mock.requests.at(-1)?.query.original).toEqual(["true"]);
  });

  it("serves the webp thumbnail", async () => {
    const document = mock.seedDocument();
    const files = new RecordingFiles();

    const result = (await runAction(getDocumentFile, {
      auth: authFor(mock),
      props: { id: document.id, variant: "thumbnail" },
      files,
    })) as Record<string, unknown>;

    expect(result.mime_type).toBe("image/webp");
    expect(result.filename).toBe(`document-${document.id}.webp`);
    expect(files.written[0].data.toString()).toBe(`thumb-${document.id}`);
  });
});

describe("custom_api_call", () => {
  it("passes method, path, query and body through", async () => {
    const tag = mock.seedObject("tags", { name: "Receipts" });

    const result = (await runAction(customApiCall, {
      auth: authFor(mock),
      props: {
        method: "GET",
        path: "tags/",
        query: { name__iexact: "Receipts" },
      },
    })) as { status: number; body: { results: { id: number }[] } };

    expect(result.status).toBe(200);
    expect(result.body.results[0].id).toBe(tag.id);
    expect(mock.requests.at(-1)?.path).toBe("/tags/");
  });

  it("sends a JSON body for a write", async () => {
    const result = (await runAction(customApiCall, {
      auth: authFor(mock),
      props: { method: "POST", path: "tags/", body: { name: "Utilities" } },
    })) as { status: number; body: { name: string } };

    expect(result.status).toBe(201);
    expect(result.body.name).toBe("Utilities");
    expect(mock.requests.at(-1)?.body).toEqual({ name: "Utilities" });
  });
});

describe("checkConnection", () => {
  it("labels the connection with user, host, server and API version", async () => {
    const identity = await checkPaperlessConnection({ auth: authFor(mock) });

    expect(identity.name).toMatch(/^archivist@127\.0\.0\.1:\d+ \(v3\.1\.3, API 10\)$/);
    expect(identity.permissions).toContain("add_workflow");
  });

  it("fails with the credential message on a bad token", async () => {
    await expect(
      checkPaperlessConnection({ auth: authFor(mock, "nope") }),
    ).rejects.toThrow(/rejected the API token/);
  });
});

describe("version cache", () => {
  it("stores the negotiated version in the piece store, keyed by host", async () => {
    await mock.close();
    mock = await startMockPaperless({
      allowedVersions: [9],
      serverVersion: "2.18.4",
    });
    const document = mock.seedDocument();
    const store = new MemoryStore();

    await runAction(getDocument, {
      auth: authFor(mock),
      props: { id: document.id },
      store,
    });

    const host = new URL(mock.baseUrl).host;
    expect(store.entries.get(`paperless:api-version:${host}`)).toBe(9);

    // A second run reads the cache: no 406, no probe.
    const before = mock.requests.length;
    await runAction(getDocument, {
      auth: authFor(mock),
      props: { id: document.id },
      store,
    });
    expect(mock.requests.length).toBe(before + 1);
    expect(mock.requests.at(-1)?.accept).toBe("application/json; version=9");
  });
});
