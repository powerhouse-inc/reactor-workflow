import { PaperlessApiError } from "./errors";

export interface NormalizedFile {
  filename: string;
  buffer: Buffer;
  contentType: string;
}

const EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  eml: "message/rfc822",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bufferFrom(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value;
  // JSON IPC flattens a Buffer to { type: "Buffer", data: [...] }.
  if (
    isRecord(value) &&
    value.type === "Buffer" &&
    Array.isArray(value.data)
  ) {
    return Buffer.from(value.data as number[]);
  }
  if (Array.isArray(value)) return Buffer.from(value as number[]);
  if (typeof value === "string") {
    const payload = /^data:[^,]*;base64,(.*)$/is.exec(value)?.[1] ?? value;
    return Buffer.from(payload, "base64");
  }
  return undefined;
}

export function contentTypeFor(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[extension] ?? "application/octet-stream";
}

// A Property.File value reaches the piece as one of three shapes:
//   - ApFile, from Activepieces' own picker: { filename, data: Buffer, base64 }
//   - a plain object after JSON IPC flattening, where `data` became
//     { type: "Buffer", data: [...] } or a base64 string
//   - a bare base64 / data-URI string, from host-side hydration
// One helper accepts all three so no action has to care which runtime it is in.
export function normalizeFile(value: unknown, fallbackName?: string): NormalizedFile {
  if (typeof value === "string") {
    const buffer = bufferFrom(value);
    if (!buffer || buffer.byteLength === 0) {
      throw new PaperlessApiError("The file input was empty", {
        category: "validation",
      });
    }
    const dataUriName = /^data:[^,]*;name=([^;,]+)/i.exec(value)?.[1];
    const filename =
      (dataUriName ? decodeURIComponent(dataUriName) : undefined) ??
      fallbackName ??
      "document";
    return { filename, buffer, contentType: contentTypeFor(filename) };
  }

  if (!isRecord(value)) {
    throw new PaperlessApiError(
      "No file was provided — connect a file output or upload one",
      { category: "validation" },
    );
  }

  const filename =
    (typeof value.filename === "string" && value.filename !== ""
      ? value.filename
      : undefined) ??
    (typeof value.fileName === "string" ? value.fileName : undefined) ??
    fallbackName ??
    "document";

  const buffer =
    bufferFrom(value.data) ??
    bufferFrom(value.base64) ??
    bufferFrom(value.buffer);
  if (!buffer || buffer.byteLength === 0) {
    throw new PaperlessApiError(
      `The file "${filename}" carried no readable bytes`,
      { category: "validation" },
    );
  }

  const declared =
    typeof value.contentType === "string"
      ? value.contentType
      : typeof value.mimeType === "string"
        ? value.mimeType
        : undefined;

  return {
    filename,
    buffer,
    contentType: declared ?? contentTypeFor(filename),
  };
}
