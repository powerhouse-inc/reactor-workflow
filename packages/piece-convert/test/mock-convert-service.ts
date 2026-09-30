// A stand-in for @powerhousedao/docling-service — the Document Conversion
// add-on. Its surface is four routes over plain node:http, and the shapes
// below are taken from the service's own README and the convert subgraph's
// client types, not invented here.
import http from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_MARKDOWN = "# Mock document\n\nParagraph one.\n\n<!-- image -->\n";

export const MOCK_CHUNKS = [
  { text: "Mock document", headings: ["Mock document"] },
  { text: "Paragraph one.", headings: ["Mock document"] },
];

export const MOCK_QUALITY = {
  coverage: 0.982,
  rawTokens: 412,
  formulas: { total: 0, decoded: 0 },
  images: 1,
};

export interface MockConvertOptions {
  /** Answer every convert with 503 CONVERSION_BUSY. */
  busy?: boolean;
  /** Answer every convert with this status and error code. */
  failWith?: { status: number; error: string };
  /** Report the service as not ready, with these missing dependencies. */
  missing?: string[];
  /** Milliseconds to hold a convert before answering. */
  delayMs?: number;
  /** Replaces the default convert body. */
  result?: Record<string, unknown>;
}

export interface MockConvertService {
  baseUrl: string;
  close(): Promise<void>;
  requests: Array<{
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string | string[] | undefined>;
    bodyBytes: number;
    body: Buffer;
  }>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function defaultResult(filename: string) {
  return {
    markdown: MOCK_MARKDOWN,
    chunks: MOCK_CHUNKS,
    format: "pdf",
    inputName: filename,
    timings: { convertMs: 1200, chunkMs: 1500 },
    backend: "docling.rs",
    normalised: null,
    ocr: null,
    textSource: "docling",
    needsOcr: null,
    ocrOffer: null,
    pages: 2,
    quality: MOCK_QUALITY,
  };
}

export async function startMockConvertService(
  opts: MockConvertOptions = {},
): Promise<MockConvertService> {
  const requests: MockConvertService["requests"] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        bodyBytes: body.length,
        body,
      });

      if (req.method === "GET" && url.pathname === "/health") {
        const missing = opts.missing ?? [];
        return json(res, missing.length > 0 ? 503 : 200, {
          ok: missing.length === 0,
          backend: "docling.rs",
          version: "0.2.2",
          ready: missing.length === 0,
          missing,
          formats: ["pdf", "docx", "pptx", "md", "html"],
          capabilities: { tesseract: true, ocrmypdf: true, gs: true, sharp: true },
          ocrEngine: "tesseract",
        });
      }

      if (req.method === "GET" && url.pathname.startsWith("/progress/")) {
        const id = decodeURIComponent(url.pathname.slice("/progress/".length));
        if (!id || id === "gone") {
          return json(res, 404, { error: "JOB_NOT_FOUND" });
        }
        return json(res, 200, {
          phase: "reading",
          pages: 23,
          pagesDone: 7,
          elapsedMs: 4200,
        });
      }

      if (req.method === "POST" && url.pathname === "/convert") {
        if (opts.busy) {
          return json(res, 503, { error: "CONVERSION_BUSY" });
        }
        if (opts.failWith) {
          return json(res, opts.failWith.status, { error: opts.failWith.error });
        }
        const filename = url.searchParams.get("filename");
        if (!filename) {
          return json(res, 400, { error: "FILENAME_REQUIRED" });
        }
        if (body.length === 0) {
          return json(res, 400, { error: "EMPTY_BODY" });
        }
        const answer = () =>
          json(res, 200, opts.result ?? defaultResult(filename));
        if (opts.delayMs) setTimeout(answer, opts.delayMs);
        else answer();
        return;
      }

      if (url.pathname === "/") {
        return json(res, 200, {
          service: "vault-convert",
          endpoints: ["GET /health", "POST /convert?filename=<name>"],
        });
      }

      return json(res, 404, { error: "not found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
