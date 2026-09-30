import { startMockDocling, type MockDocling } from "./mock-docling-serve.js";
import {
  runConversion, submitJob, pollTask, fetchResult,
  type DoclingAuth, type ConvertDocumentResponse,
} from "../pieces/docling/lib/client.js";
import { DoclingError } from "../pieces/docling/lib/errors.js";

const OPTS = { to_formats: ["md"], do_ocr: true, table_mode: "accurate", do_table_structure: true, image_export_mode: "placeholder" } as const;

describe("runConversion", () => {
  it("sync mode posts /v1/convert/source with the v1 schema and returns the document", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: { kind: "file", filename: "a.pdf", base64: "AAAA" },
        options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
      });
      const req = mock.requests.find((r) => r.path === "/v1/convert/source");
      expect(req?.headers["x-api-key"]).toBe("k-test");
      expect(out.status).toBe("success");
      // runConversion is already typed as ConvertDocumentResponse; the as-cast is a no-op.
      expect(out.document?.md_content).toBeTruthy();
    } finally { await mock.close(); }
  });

  it("async mode: submit → long-poll with wait=5 → result", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: { kind: "http", url: "https://example.com/x.pdf" },
        options: OPTS as never, mode: "async", timeoutMs: 30_000, path: "convert",
      });
      expect(out.status).toBe("success");
      const poll = mock.requests.find((r) => r.path.startsWith("/v1/status/poll/"));
      expect(poll?.query.get("wait")).toBe("5");
    } finally { await mock.close(); }
  });

  it("maps 401 to a typed AUTH error", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "wrong" },
          source: { kind: "http", url: "https://example.com/x.pdf" },
          options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "AUTH", name: "DoclingError" });
    } finally { await mock.close(); }
  });

  it("maps a sync 504 to SYNC_TIMEOUT", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", syncSlow: true });
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
          source: { kind: "http", url: "https://example.com/x.pdf" },
          options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "SYNC_TIMEOUT" });
    } finally { await mock.close(); }
  });

  it("async job failure surfaces the server's failure detail", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
          source: { kind: "file", filename: "bad.pdf", base64: "AAAA" },
          options: OPTS as never, mode: "async", timeoutMs: 30_000, path: "convert",
        }),
      // vitest 4.1.1 types stringContaining as `any`; the cast satisfies no-unsafe-assignment.
      ).rejects.toMatchObject({ kind: "JOB_FAILED", retryable: false, message: expect.stringContaining("mock inference failure") as unknown });
    } finally { await mock.close(); }
  });

  it("retries 429 backpressure with backoff, then succeeds", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", backpressure: 2 });
    try {
      const out = await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: { kind: "http", url: "https://example.com/x.pdf" },
        options: OPTS as never, mode: "async", timeoutMs: 30_000, path: "convert",
      });
      expect(out.status).toBe("success");
    } finally { await mock.close(); }
  });

  it("throws a typed DEADLINE error when the job outlives the deadline", async () => {
    // The mock never finishes jobs when failJobs is empty? No — to simulate
    // a forever job, use a dedicated option: neverFinish. (Add it to the mock
    // in this task if missing: jobs stay "started" forever.)
    const mock = await startMockDocling({ apiKey: "k-test", neverFinish: true } as never);
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
          source: { kind: "http", url: "https://example.com/slow.pdf" },
          options: OPTS as never, mode: "async", timeoutMs: 1_500, path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "DEADLINE", retryable: true });
    } finally { await mock.close(); }
  });
});

// docling-serve fetches an http source itself, so a private one (a Drive
// file, a signed URL) needs its credentials travelling with the request.
// Sending them this way also keeps the bytes out of the workflow entirely.
describe("http source headers", () => {
  it("passes the source headers through to docling-serve", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: {
          kind: "http",
          url: "https://example.test/private.mp4",
          headers: { Authorization: "Bearer drive-token" },
        },
        options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
      });
      const body = JSON.parse(mock.requestBodies[0] ?? "{}") as {
        sources?: Array<Record<string, unknown>>;
      };
      expect(body.sources?.[0]).toMatchObject({
        kind: "http",
        url: "https://example.test/private.mp4",
        headers: { Authorization: "Bearer drive-token" },
      });
    } finally { await mock.close(); }
  });

  it("omits the headers key when the source carries none", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: { kind: "http", url: "https://example.test/a.pdf" },
        options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
      });
      const body = JSON.parse(mock.requestBodies[0] ?? "{}") as {
        sources?: Array<Record<string, unknown>>;
      };
      expect(body.sources?.[0]).not.toHaveProperty("headers");
    } finally { await mock.close(); }
  });

  // 415 is a permanent answer about the file, not a server fault: retrying
  // sends the same bytes to the same refusal. A generic JOB_FAILED hides both
  // facts, and the recovery — check what the server reads — is specific.
  it("maps 415 to an UNSUPPORTED format error that is not retryable", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", failStatus: 415 });
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
          source: { kind: "http", url: "https://example.com/x.pdf" },
          options: OPTS as never,
          mode: "sync",
          timeoutMs: 5000,
          path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "UNSUPPORTED", retryable: false });
    } finally { await mock.close(); }
  });
});
