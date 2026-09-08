import { createAction, Property } from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import { clientForContext } from "../common/context";

// `/download/` and `/preview/` serve the *archive* copy when one exists
// (`use_archive = not original_requested and has_archive_version`) and differ
// only in Content-Disposition, so they are not two variants. `?original=true`
// forces the uploaded file, and `/thumb/` is the webp thumbnail.
const VARIANTS = {
  archive: { path: "download/", original: false },
  original: { path: "download/", original: true },
  thumbnail: { path: "thumb/", original: false },
} as const;

type Variant = keyof typeof VARIANTS;

function filenameFrom(
  disposition: string | null,
  fallback: string,
): string {
  if (!disposition) return fallback;
  const utf8 = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain form
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1]?.trim() ?? fallback;
}

export const getDocumentFile = createAction({
  auth: paperlessAuth,
  name: "get_document_file",
  displayName: "Get document file",
  description:
    "Downloads a document's bytes and returns a file reference the next step can consume.",
  audience: "both",
  aiMetadata: { idempotent: true },
  props: {
    id: Property.Number({ displayName: "Document ID", required: true }),
    variant: Property.StaticDropdown({
      displayName: "Variant",
      required: true,
      defaultValue: "archive",
      description:
        "Archive is the searchable PDF paperless produced (it already carries a text layer); Original is the file as uploaded. Archive falls back to the original when the document has none — the document's archived_file_name says whether it has one.",
      options: {
        options: [
          { label: "Archive (OCR'd PDF)", value: "archive" },
          { label: "Original (as uploaded)", value: "original" },
          { label: "Thumbnail (webp)", value: "thumbnail" },
        ],
      },
    }),
    version: Property.Number({
      displayName: "Version ID",
      required: false,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    // Unvalidated JSON in the reactor path: default here, not in the schema.
    const { id, version, variant } = context.propsValue as {
      id: number;
      version?: number;
      variant?: Variant;
    };
    // Anything unrecognised falls back to the archive copy.
    const resolvedVariant: Variant =
      variant === "original" || variant === "thumbnail" ? variant : "archive";
    const spec = VARIANTS[resolvedVariant];

    const response = await client.request<Buffer>({
      path: `documents/${id}/${spec.path}`,
      query: {
        ...(spec.original ? { original: "true" } : {}),
        ...(version ? { version } : {}),
      },
      responseType: "binary",
    });

    const extension = resolvedVariant === "thumbnail" ? "webp" : "pdf";
    const filename = filenameFrom(
      response.headers.get("content-disposition"),
      `document-${id}.${extension}`,
    );
    const data = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(String(response.data));

    // ctx.files.write hands the bytes to the host's attachment store and
    // returns the reference that goes in the step output — bytes themselves
    // never enter the journal.
    const ref = await context.files.write({ fileName: filename, data });

    return {
      ref,
      filename,
      mime_type:
        response.headers.get("content-type")?.split(";")[0] ??
        (resolvedVariant === "thumbnail" ? "image/webp" : "application/pdf"),
      size: data.byteLength,
      variant_requested: resolvedVariant,
    };
  },
});
