import {
  convert,
  fetchProgress,
  health,
  ConvertError,
} from "../pieces/convert/lib/client.js";
import {
  MOCK_MARKDOWN,
  startMockConvertService,
} from "./mock-convert-service.js";

const BYTES = Buffer.from("%PDF-1.7 mock");

describe("health", () => {
  it("reports the service as ready with its formats and capabilities", async () => {
    const mock = await startMockConvertService();
    try {
      const out = await health({ baseUrl: mock.baseUrl });
      expect(out.ready).toBe(true);
      expect(out.backend).toBe("docling.rs");
      expect(out.formats).toContain("pdf");
      expect(out.missing).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  // The service answers /health with 503 while its models are missing, and
  // says which. That is a readiness answer, not an outage, so it comes back
  // as a value rather than a throw.
  it("reports what is missing rather than throwing when not ready", async () => {
    const mock = await startMockConvertService({ missing: ["layout", "tableformer"] });
    try {
      const out = await health({ baseUrl: mock.baseUrl });
      expect(out.ready).toBe(false);
      expect(out.missing).toEqual(["layout", "tableformer"]);
    } finally {
      await mock.close();
    }
  });

  it("raises UNREACHABLE when nothing answers", async () => {
    await expect(health({ baseUrl: "http://127.0.0.1:1" })).rejects.toMatchObject(
      { kind: "UNREACHABLE" },
    );
  });
});

describe("convert", () => {
  it("posts the bytes with the filename in the query and returns the result", async () => {
    const mock = await startMockConvertService();
    try {
      const out = await convert({
        auth: { baseUrl: mock.baseUrl },
        filename: "report.pdf",
        bytes: BYTES,
        timeoutMs: 10_000,
      });

      const req = mock.requests.find((r) => r.path === "/convert");
      expect(req?.method).toBe("POST");
      expect(req?.query.get("filename")).toBe("report.pdf");
      // The body is the file itself, not a JSON envelope.
      expect(req?.bodyBytes).toBe(BYTES.length);
      expect(req?.headers["content-type"]).toBe("application/octet-stream");

      expect(out.markdown).toBe(MOCK_MARKDOWN);
      expect(out.chunks).toHaveLength(2);
      expect(out.quality?.coverage).toBeCloseTo(0.982);
      expect(out.pages).toBe(2);
    } finally {
      await mock.close();
    }
  });

  it("asks for OCR and figures only when told to", async () => {
    const mock = await startMockConvertService();
    try {
      await convert({
        auth: { baseUrl: mock.baseUrl },
        filename: "a.pdf",
        bytes: BYTES,
        timeoutMs: 10_000,
      });
      const plain = mock.requests.find((r) => r.path === "/convert");
      expect(plain?.query.get("ocr")).toBeNull();
      expect(plain?.query.get("figures")).toBeNull();

      await convert({
        auth: { baseUrl: mock.baseUrl },
        filename: "b.pdf",
        bytes: BYTES,
        ocr: true,
        figures: true,
        timeoutMs: 10_000,
      });
      const asked = mock.requests.filter((r) => r.path === "/convert")[1];
      expect(asked?.query.get("ocr")).toBe("1");
      expect(asked?.query.get("figures")).toBe("1");
    } finally {
      await mock.close();
    }
  });

  it("passes a job id through so progress can be polled", async () => {
    const mock = await startMockConvertService();
    try {
      await convert({
        auth: { baseUrl: mock.baseUrl },
        filename: "a.pdf",
        bytes: BYTES,
        jobId: "job-1",
        timeoutMs: 10_000,
      });
      const req = mock.requests.find((r) => r.path === "/convert");
      expect(req?.query.get("job")).toBe("job-1");
    } finally {
      await mock.close();
    }
  });

  // The service converts one document at a time and says so with 503. That is
  // a queueing signal, not an outage: the engine should retry rather than park.
  it("maps 503 CONVERSION_BUSY to a retryable error", async () => {
    const mock = await startMockConvertService({ busy: true });
    try {
      await expect(
        convert({
          auth: { baseUrl: mock.baseUrl },
          filename: "a.pdf",
          bytes: BYTES,
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ kind: "BUSY", retryable: true });
    } finally {
      await mock.close();
    }
  });

  it("maps 415 to an unsupported-format error that is not retryable", async () => {
    const mock = await startMockConvertService({
      failWith: { status: 415, error: "UNSUPPORTED_FORMAT" },
    });
    try {
      await expect(
        convert({
          auth: { baseUrl: mock.baseUrl },
          filename: "a.xyz",
          bytes: BYTES,
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ kind: "UNSUPPORTED", retryable: false });
    } finally {
      await mock.close();
    }
  });

  it("maps 500 CONVERT_FAILED to a conversion error", async () => {
    const mock = await startMockConvertService({
      failWith: { status: 500, error: "CONVERT_FAILED" },
    });
    try {
      await expect(
        convert({
          auth: { baseUrl: mock.baseUrl },
          filename: "a.pdf",
          bytes: BYTES,
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ kind: "CONVERT_FAILED" });
    } finally {
      await mock.close();
    }
  });

  // The filename's extension is how the service picks the format, so an empty
  // one is caught here rather than surfacing as a 400 from the server.
  it("rejects an empty filename before sending anything", async () => {
    const mock = await startMockConvertService();
    try {
      await expect(
        convert({
          auth: { baseUrl: mock.baseUrl },
          filename: "   ",
          bytes: BYTES,
          timeoutMs: 10_000,
        }),
      ).rejects.toBeInstanceOf(ConvertError);
      expect(mock.requests.filter((r) => r.path === "/convert")).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("rejects an empty body before sending anything", async () => {
    const mock = await startMockConvertService();
    try {
      await expect(
        convert({
          auth: { baseUrl: mock.baseUrl },
          filename: "a.pdf",
          bytes: Buffer.alloc(0),
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ kind: "VALIDATION" });
      expect(mock.requests.filter((r) => r.path === "/convert")).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });
});

describe("fetchProgress", () => {
  it("returns the phase and page counts for a running job", async () => {
    const mock = await startMockConvertService();
    try {
      const out = await fetchProgress({ baseUrl: mock.baseUrl }, "job-1");
      expect(out).toMatchObject({ phase: "reading", pages: 23, pagesDone: 7 });
    } finally {
      await mock.close();
    }
  });

  // Jobs linger about a minute after finishing, then 404. That is the poller's
  // cue to stop, not an error to raise.
  it("returns null once the job has aged out", async () => {
    const mock = await startMockConvertService();
    try {
      expect(await fetchProgress({ baseUrl: mock.baseUrl }, "gone")).toBeNull();
    } finally {
      await mock.close();
    }
  });
});
