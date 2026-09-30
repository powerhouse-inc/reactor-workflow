import { httpClient, HttpMethod } from "@powerhousedao/pieces-framework/common";
import { ConvertError } from "./errors.js";

export { ConvertError } from "./errors.js";
export type { ConvertErrorKind } from "./errors.js";

/**
 * The Document Conversion add-on (`@powerhousedao/docling-service`). It is
 * unauthenticated by design -- it carries no ingress and the chart's own note
 * is that in-cluster callers are trusted -- so the connection is a URL and
 * nothing else.
 */
export interface ConvertAuth {
  baseUrl: string;
}

export interface HealthReport {
  ok: boolean;
  ready: boolean;
  backend?: string;
  version?: string;
  /** Dependencies the service wants and has not got; empty when ready. */
  missing: string[];
  formats: string[];
  capabilities?: Record<string, unknown>;
  ocrEngine?: string;
}

export interface ConvertChunk {
  text: string;
  headings?: string[];
  docItems?: string[];
  contextualized?: string;
}

export interface ConvertQuality {
  /** Share of the PDF text layer's tokens present in the markdown. A floor. */
  coverage: number | null;
  rawTokens: number;
  formulas: { total: number; decoded: number };
  images: number;
}

export interface ConvertFigure {
  id: string;
  kind: "picture" | "formula";
  page: number;
  placeholderIndex: number;
  alt: string;
  mimeType: string;
  width: number;
  height: number;
  bytesBase64: string;
}

export interface ConvertResult {
  markdown: string;
  chunks: ConvertChunk[];
  format?: string;
  inputName?: string;
  pages?: number | null;
  /** Which rung of the OCR ladder produced the text. */
  textSource?: "docling" | "pdfjs" | "tesseract" | "docling-ocr";
  ocr?: "forced" | "requested" | "tesseract" | "docling" | null;
  /** Set when the file was repaired before converting. */
  normalised?: "qpdf" | "gs" | null;
  /** OCR is needed but over the service's budget; re-request with ocr: true. */
  needsOcr?: { via: string; estimateSeconds: number } | null;
  /** The text layer was read flat; what OCR would cost to recover tables. */
  ocrOffer?: { via: string; estimateSeconds: number } | null;
  quality?: ConvertQuality | null;
  figures?: ConvertFigure[];
  timings?: Record<string, unknown>;
  backend?: string;
}

export interface ConvertProgress {
  phase: string;
  pages?: number | null;
  pagesDone?: number | null;
  elapsedMs?: number;
}

export function normalizeBaseUrl(raw: string | undefined): string {
  const url = (raw ?? "").trim();
  if (!url) {
    throw new ConvertError("VALIDATION", "The service URL is required.");
  }
  return url.replace(/\/+$/, "");
}

/** pieces-common's httpClient throws on any non-2xx; recover the status. */
function statusOf(err: unknown): number | undefined {
  if (err !== null && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function bodyOf(err: unknown): Record<string, unknown> | undefined {
  if (err !== null && typeof err === "object" && "responseBody" in err) {
    const body = (err as { responseBody?: unknown }).responseBody;
    if (body !== null && typeof body === "object") {
      return body as Record<string, unknown>;
    }
  }
  return undefined;
}

function serviceError(err: unknown, baseUrl: string): ConvertError {
  const status = statusOf(err);
  // The body is the service's JSON; its `error` is a code string, but the
  // type is unknown, so only a string is used as one.
  const raw = bodyOf(err)?.error;
  const code = typeof raw === "string" ? raw : "";
  const detail = code ? ` (${code})` : "";

  if (status === 400) {
    return new ConvertError("VALIDATION", `The service rejected the request${detail}.`);
  }
  if (status === 415) {
    return new ConvertError(
      "UNSUPPORTED",
      `The service cannot read this format${detail}. Its /health lists the formats it supports.`,
    );
  }
  if (status === 503) {
    // Documented behaviour, not an outage: one conversion at a time.
    return new ConvertError(
      "BUSY",
      "The conversion service is busy with another document; try again shortly.",
      true,
    );
  }
  if (status === 500) {
    return new ConvertError("CONVERT_FAILED", `The conversion failed${detail}.`);
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|aborted/i.test(message)) {
    return new ConvertError("DEADLINE", `The conversion outlived its deadline: ${message}`);
  }
  return new ConvertError(
    "UNREACHABLE",
    `Could not reach the conversion service at ${baseUrl}. ${message}`,
  );
}

export async function health(auth: ConvertAuth): Promise<HealthReport> {
  const baseUrl = normalizeBaseUrl(auth.baseUrl);
  try {
    const res = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${baseUrl}/health`,
      timeout: 10_000,
      retries: 0,
    });
    return toHealth(res.body as Record<string, unknown>);
  } catch (err) {
    // A service whose models are missing answers /health with 503 and says
    // which. That is an answer about readiness, not a failure to reach it.
    const body = bodyOf(err);
    if (statusOf(err) === 503 && body) return toHealth(body);
    throw serviceError(err, baseUrl);
  }
}

function toHealth(body: Record<string, unknown>): HealthReport {
  const missing = Array.isArray(body.missing) ? (body.missing as string[]) : [];
  return {
    ok: body.ok === true,
    ready: body.ready === true,
    backend: typeof body.backend === "string" ? body.backend : undefined,
    version: typeof body.version === "string" ? body.version : undefined,
    missing,
    formats: Array.isArray(body.formats) ? (body.formats as string[]) : [],
    capabilities:
      body.capabilities !== null && typeof body.capabilities === "object"
        ? (body.capabilities as Record<string, unknown>)
        : undefined,
    ocrEngine: typeof body.ocrEngine === "string" ? body.ocrEngine : undefined,
  };
}

export interface ConvertArgs {
  auth: ConvertAuth;
  /** Keeps its extension: the service dispatches on it to pick the format. */
  filename: string;
  bytes: Buffer;
  ocr?: boolean;
  figures?: boolean;
  /** Caller-chosen id, so `fetchProgress` can follow this conversion. */
  jobId?: string;
  timeoutMs: number;
}

export async function convert(args: ConvertArgs): Promise<ConvertResult> {
  const baseUrl = normalizeBaseUrl(args.auth.baseUrl);
  const filename = args.filename.trim();
  if (!filename) {
    throw new ConvertError(
      "VALIDATION",
      "A filename is required: the service picks the format from its extension.",
    );
  }
  if (args.bytes.length === 0) {
    throw new ConvertError("VALIDATION", "The file is empty.");
  }

  const query = new URLSearchParams({ filename });
  if (args.jobId) query.set("job", args.jobId);
  if (args.ocr) query.set("ocr", "1");
  if (args.figures) query.set("figures", "1");

  try {
    const res = await httpClient.sendRequest({
      method: HttpMethod.POST,
      url: `${baseUrl}/convert?${query.toString()}`,
      headers: { "content-type": "application/octet-stream" },
      body: args.bytes,
      timeout: args.timeoutMs,
      retries: 0,
    });
    return res.body as ConvertResult;
  } catch (err) {
    throw serviceError(err, baseUrl);
  }
}

/**
 * The phase and page counts of a conversion already in flight. Jobs linger
 * about a minute after finishing and then 404 — `null` is the poller's cue to
 * stop, not an error.
 */
export async function fetchProgress(
  auth: ConvertAuth,
  jobId: string,
): Promise<ConvertProgress | null> {
  const baseUrl = normalizeBaseUrl(auth.baseUrl);
  try {
    const res = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${baseUrl}/progress/${encodeURIComponent(jobId)}`,
      timeout: 10_000,
      retries: 0,
    });
    return res.body as ConvertProgress;
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw serviceError(err, baseUrl);
  }
}
