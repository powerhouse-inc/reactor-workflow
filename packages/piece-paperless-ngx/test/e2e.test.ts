// Live end-to-end suite against a real paperless-ngx. Skipped unless
// PAPERLESS_E2E_URL is set, because it needs a server, consumes documents and
// takes minutes:
//
//   docker compose -f test/e2e-compose.yml up -d
//   PAPERLESS_E2E_URL=http://localhost:18000 \
//   PAPERLESS_E2E_USER=admin PAPERLESS_E2E_PASSWORD=paperless-e2e \
//   pnpm vitest run test/e2e.test.ts
//
// It covers the things a mock cannot settle: what the server actually accepts
// on the multipart upload, whether a duplicate really is consumed, and what
// paperless puts on the wire when its own workflow engine fires our webhook.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bulkEditDocuments } from "../src/lib/actions/bulk-edit-documents";
import { customApiCall } from "../src/lib/actions/custom-api-call";
import { findOrCreateObject } from "../src/lib/actions/find-or-create-object";
import { getDocument } from "../src/lib/actions/get-document";
import { getDocumentFile } from "../src/lib/actions/get-document-file";
import { getTask } from "../src/lib/actions/get-task";
import { searchDocuments } from "../src/lib/actions/search-documents";
import { updateDocument } from "../src/lib/actions/update-document";
import { uploadDocument } from "../src/lib/actions/upload-document";
import { checkPaperlessConnection } from "../src/lib/auth";
import { newDocument } from "../src/lib/triggers/document-trigger";
import { MemoryStore, RecordingFiles, runAction, runHook } from "./helpers";

const baseUrl = process.env.PAPERLESS_E2E_URL;
const username = process.env.PAPERLESS_E2E_USER ?? "admin";
const password = process.env.PAPERLESS_E2E_PASSWORD ?? "paperless-e2e";

interface Delivery {
  method: string;
  contentType?: string;
  token?: string;
  body: unknown;
}

let auth: unknown;
let listener: http.Server;
let listenerUrl = "";
let deliveries: Delivery[] = [];
// Unique per run so a re-run against the same server does not collide.
const stamp = Date.now();
const fileName = `e2e-invoice-${stamp}.txt`;
const fileBody = `ACME Corporation invoice ${stamp}\nTotal due 42.00 EUR\n`;
const file = { filename: fileName, data: Buffer.from(fileBody, "utf8") };

// A valid single-page PDF with a text layer, assembled with real xref offsets
// so ocrmypdf accepts it. paperless only produces an archive version for file
// types it can convert, which a .txt upload is not — hence a PDF for the
// file-variant test.
function minimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 14 Tf 20 150 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const pdfName = `e2e-scan-${stamp}.pdf`;
const pdfFile = {
  filename: pdfName,
  data: minimalPdf(`ACME scanned invoice ${stamp}`),
};

async function mintToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new Error(`Could not mint an API token: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describe.skipIf(!baseUrl)("live paperless-ngx", () => {
  let documentId = 0;
  let tagId = 0;

  beforeAll(async () => {
    auth = {
      type: "CUSTOM_AUTH",
      props: { base_url: baseUrl, token: await mintToken() },
    };

    // Stands in for the switchboard's GraphQL endpoint. paperless has to be
    // able to reach it, which is why e2e-compose.yml puts the server on the
    // host network: on a bridge network this would be host.docker.internal,
    // and many hosts drop container-to-host traffic at the firewall.
    listener = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // keep the raw text
        }
        deliveries.push({
          method: request.method ?? "",
          contentType: request.headers["content-type"],
          token: request.headers["x-powerhouse-webhook-token"] as
            | string
            | undefined,
          body: parsed,
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: { workflowRuntime: { fireWebhook: { accepted: true } } } }));
      });
    });
    await new Promise<void>((resolve) =>
      listener.listen(0, "0.0.0.0", resolve),
    );
    const port = (listener.address() as AddressInfo).port;
    listenerUrl = `http://127.0.0.1:${port}/graphql/workflow-runtime`;
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => listener.close(resolve));
  });

  it("labels the connection from a real server", async () => {
    const identity = await checkPaperlessConnection({ auth });

    expect(identity.username).toBe(username);
    // Negotiation picked a version this server actually allows.
    expect([9, 10]).toContain(identity.apiVersion);
    expect(identity.serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(identity.permissions.length).toBeGreaterThan(0);
    console.log(`connected: ${identity.name}`);
  });

  it("creates a tag by name, then finds the same one", async () => {
    const created = (await runAction(findOrCreateObject, {
      auth,
      props: {
        object_type: "tags",
        name: `E2E ${stamp}`,
        extras: { color: "#a6cee3" },
      },
    })) as { id: number; created: boolean };
    expect(created.created).toBe(true);
    tagId = created.id;

    const found = (await runAction(findOrCreateObject, {
      auth,
      // Different case on purpose: the lookup is name__iexact.
      props: { object_type: "tags", name: `e2e ${stamp}` },
    })) as { id: number; created: boolean };
    expect(found).toEqual({
      id: tagId,
      name: `E2E ${stamp}`,
      created: false,
      object_type: "tags",
    });
  }, 60_000);

  it("uploads a document and waits for paperless to consume it", async () => {
    const result = (await runAction(uploadDocument, {
      auth,
      props: {
        file,
        title: `E2E Invoice ${stamp}`,
        tags: [tagId],
        wait_for_consumption: true,
        timeout_seconds: 240,
      },
      store: new MemoryStore(),
    })) as {
      status: string;
      document_id: number;
      task_id: string;
      adopted: boolean;
      document: Record<string, unknown>;
    };

    expect(result.status).toBe("success");
    expect(result.adopted).toBe(false);
    expect(typeof result.document_id).toBe("number");
    expect(result.document.title).toBe(`E2E Invoice ${stamp}`);
    expect(result.document.tags).toEqual([tagId]);
    // The OCR text is not in the step output unless asked for.
    expect(result.document).not.toHaveProperty("content");
    documentId = result.document_id;

    const task = (await runAction(getTask, {
      auth,
      props: { task_id: result.task_id },
    })) as Record<string, unknown>;
    expect(task.status).toBe("success");
    expect(task.document_id).toBe(documentId);
  }, 300_000);

  it("adopts the completed task instead of uploading the same file twice", async () => {
    const result = (await runAction(uploadDocument, {
      auth,
      props: { file, wait_for_consumption: true, timeout_seconds: 120 },
    })) as { adopted: boolean; document_id: number };

    expect(result.adopted).toBe(true);
    expect(result.document_id).toBe(documentId);
  }, 180_000);

  it("really does create a duplicate when the guard is off", async () => {
    // paperless consumes duplicates by default: pre_check_duplicate only
    // rejects when PAPERLESS_CONSUMER_DELETE_DUPLICATES is set. This is the
    // behaviour the adoption guard exists for.
    const result = (await runAction(uploadDocument, {
      auth,
      props: {
        file,
        adopt_existing_task: false,
        wait_for_consumption: true,
        timeout_seconds: 240,
      },
    })) as { status: string; document_id: number | null };

    expect(result.status).toBe("success");
    expect(result.document_id).not.toBe(documentId);
    expect(typeof result.document_id).toBe("number");
  }, 300_000);

  it("reads the document, with and without its extracted text", async () => {
    const lean = (await runAction(getDocument, {
      auth,
      props: { id: documentId },
    })) as Record<string, unknown>;
    expect(lean).not.toHaveProperty("content");

    const full = (await runAction(getDocument, {
      auth,
      props: { id: documentId, include_content: true },
    })) as Record<string, unknown>;
    expect(String(full.content)).toContain("ACME");
  }, 60_000);

  it("finds the document by full-text search", async () => {
    const result = await waitFor(async () => {
      const page = (await runAction(searchDocuments, {
        auth,
        props: { mode: "full_text", term: `${stamp}` },
      })) as { count: number; results: Record<string, unknown>[] };
      return page.count > 0 ? page : undefined;
    }, "the search index to pick the document up", 120_000);

    expect(result.results.some((row) => row.id === documentId)).toBe(true);
    expect(result.results[0].__search_hit__).toBeDefined();
  }, 180_000);

  it("adds and removes tags without clobbering the rest", async () => {
    const second = (await runAction(findOrCreateObject, {
      auth,
      props: { object_type: "tags", name: `E2E Reviewed ${stamp}` },
    })) as { id: number };

    await runAction(updateDocument, {
      auth,
      props: {
        id: documentId,
        tags: [second.id],
        tag_mode: "add",
        title: `E2E Invoice ${stamp} (reviewed)`,
      },
    });

    const afterAdd = (await runAction(getDocument, {
      auth,
      props: { id: documentId },
    })) as { tags: number[]; title: string };
    expect(afterAdd.tags).toContain(tagId);
    expect(afterAdd.tags).toContain(second.id);
    expect(afterAdd.title).toBe(`E2E Invoice ${stamp} (reviewed)`);

    await runAction(updateDocument, {
      auth,
      props: { id: documentId, tags: [second.id], tag_mode: "remove" },
    });
    const afterRemove = (await runAction(getDocument, {
      auth,
      props: { id: documentId },
    })) as { tags: number[] };
    expect(afterRemove.tags).toEqual([tagId]);
  }, 120_000);

  it("bulk edits through the server-side operation", async () => {
    const result = (await runAction(bulkEditDocuments, {
      auth,
      props: {
        document_ids: [documentId],
        method: "modify_tags",
        parameters: { add_tags: [tagId], remove_tags: [] },
      },
    })) as { result: string };
    expect(result.result).toBe("OK");
  }, 60_000);

  it("serves the archive and the original per has_archive_version", async () => {
    // A PDF upload, because paperless produces an archive version for those.
    const upload = (await runAction(uploadDocument, {
      auth,
      props: {
        file: pdfFile,
        title: `E2E Scan ${stamp}`,
        wait_for_consumption: true,
        timeout_seconds: 300,
      },
    })) as { status: string; document_id: number };
    expect(upload.status).toBe("success");

    // `has_archive_version` is a server-side model property that the
    // serializer never exposes; `archived_file_name` is what a client sees.
    const document = (await runAction(getDocument, {
      auth,
      props: { id: upload.document_id },
    })) as { archived_file_name?: string | null };

    const files = new RecordingFiles();
    const archive = (await runAction(getDocumentFile, {
      auth,
      props: { id: upload.document_id, variant: "archive" },
      files,
    })) as { ref: string; mime_type: string; size: number };
    const original = (await runAction(getDocumentFile, {
      auth,
      props: { id: upload.document_id, variant: "original" },
      files,
    })) as { size: number };

    expect(archive.ref).toMatch(/^apfile:\/\//);
    expect(files.written[1].data.equals(pdfFile.data)).toBe(true);
    expect(original.size).toBe(pdfFile.data.byteLength);

    if (document.archived_file_name) {
      // The archive is paperless's own conversion, so different bytes.
      expect(files.written[0].data.equals(pdfFile.data)).toBe(false);
      expect(files.written[0].data.subarray(0, 4).toString()).toBe("%PDF");
      expect(archive.mime_type).toBe("application/pdf");
    } else {
      // Documented fallback: /download/ serves the original when there is no
      // archive copy. This is what a .txt upload does.
      expect(files.written[0].data.equals(pdfFile.data)).toBe(true);
    }

    const thumb = (await runAction(getDocumentFile, {
      auth,
      props: { id: upload.document_id, variant: "thumbnail" },
      files,
    })) as { mime_type: string };
    expect(thumb.mime_type).toBe("image/webp");
  }, 420_000);

  it("confirms a text upload has no archive copy, and falls back", async () => {
    const document = (await runAction(getDocument, {
      auth,
      props: { id: documentId },
    })) as { archived_file_name?: string | null; mime_type?: string };

    // Recorded because it is the reason the variant fallback exists at all.
    expect(document.mime_type).toBe("text/plain");
    expect(document.archived_file_name ?? null).toBeNull();

    const files = new RecordingFiles();
    await runAction(getDocumentFile, {
      auth,
      props: { id: documentId, variant: "archive" },
      files,
    });
    expect(files.written[0].data.toString()).toBe(fileBody);
  }, 120_000);

  it("reaches the tail of the API through the escape hatch", async () => {
    const result = (await runAction(customApiCall, {
      auth,
      props: { method: "GET", path: `documents/${documentId}/metadata/` },
    })) as { status: number; body: Record<string, unknown> };

    expect(result.status).toBe(200);
    expect(result.body.original_filename).toBe(fileName);
  }, 60_000);

  describe("webhook trigger against paperless's own workflow engine", () => {
    const store = new MemoryStore();
    const token = `e2e-token-${stamp}`;

    it("registers one workflow with the trigger and webhook nested", async () => {
      await runHook(newDocument, "onEnable", {
        auth,
        store,
        webhookUrl: `${listenerUrl}#${token}`,
        props: { sources: [2] },
      });

      const registration = store.entries.get(
        "paperless:webhook-registration",
      ) as { workflow_id: number };
      expect(typeof registration.workflow_id).toBe("number");

      // What paperless stored, read back from paperless itself.
      const listed = (await runAction(customApiCall, {
        auth,
        props: { method: "GET", path: "workflows/" },
      })) as {
        body: {
          results: {
            id: number;
            enabled: boolean;
            triggers: { type: number; sources: unknown }[];
            actions: { type: number; webhook: Record<string, unknown> }[];
          }[];
        };
      };
      const mine = listed.body.results.find(
        (row) => row.id === registration.workflow_id,
      );
      expect(mine?.enabled).toBe(true);
      expect(mine?.triggers[0].type).toBe(2);
      expect(mine?.actions[0].type).toBe(4);
      expect(mine?.actions[0].webhook).toMatchObject({
        use_params: true,
        as_json: true,
        include_document: false,
        headers: { "X-Powerhouse-Webhook-Token": token },
      });
    }, 120_000);

    it("receives a real delivery when a document is added", async () => {
      deliveries = [];
      const upload = (await runAction(uploadDocument, {
        auth,
        props: {
          file: {
            filename: `e2e-trigger-${stamp}.txt`,
            data: Buffer.from(`Triggered document ${stamp}\n`, "utf8"),
          },
          title: `E2E Trigger ${stamp}`,
          adopt_existing_task: false,
          wait_for_consumption: true,
          timeout_seconds: 240,
        },
      })) as { document_id: number };

      const delivery = await waitFor(
        () => Promise.resolve(deliveries[0]),
        "paperless to POST the webhook",
        120_000,
      );

      expect(delivery.method).toBe("POST");
      expect(delivery.contentType).toContain("application/json");
      expect(delivery.token).toBe(token);

      // use_params + as_json is the only combination that yields a real JSON
      // object body, and only {{doc_id}} was interpolated.
      const body = delivery.body as { query: string };
      expect(typeof body.query).toBe("string");
      expect(body.query).toContain(
        `fireWebhook(payload: { docId: ${upload.document_id}, event: "DOCUMENT_ADDED" })`,
      );
      expect(body.query).not.toContain("{{");

      // The payload the resolver would hand the trigger.
      const items = (await runHook(newDocument, "run", {
        auth,
        store,
        payload: { docId: upload.document_id, event: "DOCUMENT_ADDED" },
      })) as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(upload.document_id);
      expect(String(items[0]._dedupe_key)).toMatch(
        new RegExp(`^${upload.document_id}:DOCUMENT_ADDED:.+`),
      );
    }, 420_000);

    it("recovers a missed delivery with the reconciliation sweep", async () => {
      // The sweep is what makes a dropped delivery survivable: paperless never
      // retries a transport error or a slow response.
      await store.put("paperless:sweep-cursor", new Date(0).toISOString());

      const items = (await runHook(newDocument, "run", {
        auth,
        store,
      })) as Record<string, unknown>[];

      expect(items.length).toBeGreaterThan(0);
      expect(items.some((item) => item.id === documentId)).toBe(true);
      // The cursor advanced, so a second sweep is quiet.
      const again = (await runHook(newDocument, "run", {
        auth,
        store,
      })) as unknown[];
      expect(again).toEqual([]);
    }, 120_000);

    it("removes the workflow, the action and the trigger on disable", async () => {
      const registration = store.entries.get(
        "paperless:webhook-registration",
      ) as { workflow_id: number };

      await runHook(newDocument, "onDisable", { auth, store });

      const listed = (await runAction(customApiCall, {
        auth,
        props: { method: "GET", path: "workflows/" },
      })) as { body: { results: { id: number }[] } };
      expect(
        listed.body.results.some((row) => row.id === registration.workflow_id),
      ).toBe(false);
      expect(store.entries.get("paperless:webhook-registration")).toBeNull();
    }, 120_000);
  });
});
