import { Property } from "@powerhousedao/pieces-framework";
import { DoclingError } from "./errors.js";

export interface ActionOptionsProps {
  format?: "markdown" | "markdown+json" | "all";
  ocr?: boolean;
  table_mode?: "fast" | "accurate";
  page_range?: unknown;
  image_mode?: "placeholder" | "embedded" | "referenced";
  execution?: "async" | "sync";
  timeout_seconds?: number;
  // Everything below is optional in both senses: the prop may be unset, and
  // an unset prop is left out of the request entirely (see buildOptions).
  force_ocr?: boolean;
  /** Comma-separated in the builder; the schema wants array<string>. */
  ocr_lang?: unknown;
  ocr_engine?: string;
  ocr_preset?: string;
  pdf_backend?: string;
  table_cell_matching?: boolean;
  heading_hierarchy?: boolean;
  include_page_images?: boolean;
  images_scale?: number;
  document_timeout?: number;
  abort_on_error?: boolean;
  enrichments?: unknown;
}

export interface ConvertDocumentsOptionsPayload {
  to_formats: string[];
  do_ocr: boolean;
  table_mode: "fast" | "accurate";
  do_table_structure: boolean;
  image_export_mode: "placeholder" | "embedded" | "referenced";
  page_range?: [number, number];
  force_ocr?: boolean;
  ocr_lang?: string[];
  ocr_engine?: string;
  ocr_preset?: string;
  pdf_backend?: string;
  table_cell_matching?: boolean;
  do_pdf_heading_hierarchy?: boolean;
  include_page_images?: boolean;
  images_scale?: number;
  document_timeout?: number;
  abort_on_error?: boolean;
  do_code_enrichment?: boolean;
  do_formula_enrichment?: boolean;
  do_picture_classification?: boolean;
  do_chart_extraction?: boolean;
  do_picture_description?: boolean;
}

/**
 * The builder offers one multi-select; docling takes five independent flags.
 * Verified against ConvertDocumentsOptions on docling-serve 1.31.0 -- note
 * it is chart *extraction*, not "chart understanding".
 */
const ENRICHMENT_FLAGS = {
  code: "do_code_enrichment",
  formula: "do_formula_enrichment",
  picture_classification: "do_picture_classification",
  chart: "do_chart_extraction",
  picture_description: "do_picture_description",
} as const satisfies Record<string, keyof ConvertDocumentsOptionsPayload>;

/** The six the 1.31.0 schema enumerates. Anything else the server rejects. */
const PDF_BACKENDS = [
  "pypdfium2",
  "docling_parse",
  "threaded_docling_parse",
  "dlparse_v1",
  "dlparse_v2",
  "dlparse_v4",
];

const FORMAT_MAP: Record<string, string[]> = {
  markdown: ["md"],
  "markdown+json": ["md", "json"],
  all: ["md", "json", "html", "text", "doctags"],
};

export function buildOptions(props: ActionOptionsProps): ConvertDocumentsOptionsPayload {
  const preset = props.format ?? "markdown";
  const to_formats = FORMAT_MAP[preset];
  if (!to_formats) {
    throw new DoclingError("VALIDATION", `Unknown format preset "${preset}".`);
  }
  const out: ConvertDocumentsOptionsPayload = {
    to_formats,
    do_ocr: props.ocr ?? true,
    table_mode: props.table_mode ?? "accurate",
    do_table_structure: true,
    image_export_mode: props.image_mode ?? "placeholder",
  };
  const range = parsePageRange(props.page_range);
  if (range) out.page_range = range;

  // Set, not merely truthy: `table_cell_matching: false` is a deliberate
  // choice the server needs to hear, since it defaults to true. Anything the
  // author left alone stays out of the request so the server keeps owning
  // its own defaults -- they move (the design doc recorded pdf_backend
  // defaulting to threaded_docling_parse; 1.31.0 answers docling_parse).
  const set = <K extends keyof ConvertDocumentsOptionsPayload>(
    key: K,
    value: ConvertDocumentsOptionsPayload[K] | undefined,
  ) => {
    if (value !== undefined) out[key] = value;
  };

  set("force_ocr", props.force_ocr);
  set("ocr_engine", props.ocr_engine);
  set("ocr_preset", props.ocr_preset);
  set("table_cell_matching", props.table_cell_matching);
  set("do_pdf_heading_hierarchy", props.heading_hierarchy);
  set("include_page_images", props.include_page_images);
  set("images_scale", props.images_scale);
  set("document_timeout", props.document_timeout);
  set("abort_on_error", props.abort_on_error);
  set("ocr_lang", parseOcrLang(props.ocr_lang));

  if (props.pdf_backend !== undefined) {
    if (!PDF_BACKENDS.includes(props.pdf_backend)) {
      throw new DoclingError(
        "VALIDATION",
        `pdf_backend must be one of ${PDF_BACKENDS.join(", ")}, got "${props.pdf_backend}".`,
      );
    }
    out.pdf_backend = props.pdf_backend;
  }

  for (const name of parseEnrichments(props.enrichments)) {
    out[ENRICHMENT_FLAGS[name]] = true;
  }

  return out;
}

/**
 * The builder field is a comma-separated ShortText -- a plain text box is
 * what an author can fill from an expression -- while the schema types
 * ocr_lang as array<string>. An already-array value passes through, for
 * values injected by an expression.
 */
export function parseOcrLang(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parts = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const langs = parts.map((v) => v.trim()).filter((v) => v !== "");
  return langs.length > 0 ? langs : undefined;
}

/** Validates the multi-select against the flags docling actually has. */
export function parseEnrichments(
  raw: unknown,
): (keyof typeof ENRICHMENT_FLAGS)[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new DoclingError(
      "VALIDATION",
      `enrichments must be a list, got ${JSON.stringify(raw)}.`,
    );
  }
  return raw.map((value) => {
    const name = String(value);
    if (!(name in ENRICHMENT_FLAGS)) {
      throw new DoclingError(
        "VALIDATION",
        `Unknown enrichment "${name}"; expected one of ${Object.keys(ENRICHMENT_FLAGS).join(", ")}.`,
      );
    }
    return name as keyof typeof ENRICHMENT_FLAGS;
  });
}

// docling-serve's contract: a 1-based [start, end] page tuple
// (ConvertDocumentsOptions.page_range). The builder field is a ShortText
// "start[-end]" string; 2-element integer arrays are accepted too, for
// values injected via expressions. "start" alone means that page only;
// "start-" runs to the last page (sent as a large integer the server
// validator accepts).
export function parsePageRange(raw: unknown): [number, number] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let start: number;
  let end: number;
  if (typeof raw === "string") {
    const m = /^(\d+)(?:-(\d*))?$/.exec(raw.trim());
    if (!m) {
      throw new DoclingError("VALIDATION", `page_range must look like "start" or "start-end" (1-based), got "${raw}".`);
    }
    start = Number(m[1]);
    end = m[2] === undefined ? start : m[2] === "" ? 2147483647 : Number(m[2]);
  } else if (Array.isArray(raw) && raw.length === 2 && raw.every((n) => typeof n === "number" && Number.isInteger(n))) {
    [start, end] = raw as [number, number];
  } else {
    throw new DoclingError("VALIDATION", `page_range must be a "start" / "start-end" string or a 2-element integer array, got ${JSON.stringify(raw)}.`);
  }
  if (start < 1 || end < start) {
    throw new DoclingError("VALIDATION", `page_range must be 1-based with start <= end, got [${start}, ${end}].`);
  }
  return [start, end];
}

export function executionMode(props: ActionOptionsProps): "async" | "sync" {
  return props.execution === "sync" ? "sync" : "async";
}

export function timeoutMs(props: ActionOptionsProps): number {
  const t = props.timeout_seconds ?? 600;
  if (!Number.isFinite(t) || t < 5 || t > 3600) {
    throw new DoclingError("VALIDATION", `timeout_seconds must be between 5 and 3600, got ${t}.`);
  }
  return Math.floor(t) * 1000;
}

// Shared property definitions for the convert/chunk actions. `as const`-free
// on purpose: the framework's property types carry their own generics.
export const convertProps = {
  format: Property.StaticDropdown({
    displayName: "Output Format",
    required: true,
    defaultValue: "markdown",
    options: {
      options: [
        { label: "Markdown", value: "markdown" },
        { label: "Markdown + document model (JSON)", value: "markdown+json" },
        { label: "All (md, json, html, text, doctags)", value: "all" },
      ],
    },
  }),
  ocr: Property.Checkbox({
    displayName: "OCR",
    required: true,
    defaultValue: true,
    description: "Run OCR on the pages (server default: on).",
  }),
  table_mode: Property.StaticDropdown({
    displayName: "Table Mode",
    required: true,
    defaultValue: "accurate",
    options: {
      options: [
        { label: "Fast", value: "fast" },
        { label: "Accurate (TableFormer)", value: "accurate" },
      ],
    },
  }),
  page_range: Property.ShortText({
    displayName: "Page Range",
    required: false,
    description: 'Optional 1-based page window as start-end, e.g. "5-20" ("5-" to the last page, "5" a single page).',
  }),
  image_mode: Property.StaticDropdown({
    displayName: "Image Mode",
    required: true,
    defaultValue: "placeholder",
    options: {
      options: [
        { label: "Placeholder", value: "placeholder" },
        { label: "Embedded (base64 in output)", value: "embedded" },
        { label: "Referenced (URLs)", value: "referenced" },
      ],
    },
  }),
  execution: Property.StaticDropdown({
    displayName: "Execution",
    required: true,
    defaultValue: "async",
    options: {
      options: [
        { label: "Auto (async — recommended)", value: "async" },
        { label: "Sync (fast documents only; server caps at ~120 s)", value: "sync" },
      ],
    },
  }),
  timeout_seconds: Property.Number({
    displayName: "Timeout (seconds)",
    required: false,
    defaultValue: 600,
    description: "Overall deadline for async conversions (5–3600).",
  }),
  force_ocr: Property.Checkbox({
    displayName: "Force OCR",
    required: false,
    description:
      "Re-OCR the pages even where the document already has a text layer — the fix for a scanned PDF whose embedded text is garbage.",
  }),
  ocr_lang: Property.ShortText({
    displayName: "OCR Language(s)",
    required: false,
    description:
      'Comma-separated language hints for OCR, e.g. "de,en". Left empty, the server decides.',
  }),
  enrichments: Property.StaticMultiSelectDropdown({
    displayName: "Enrichments",
    required: false,
    description:
      "Extra passes that add information rather than change formatting. Each costs time, and picture description needs a model the server has to provide.",
    options: {
      options: [
        { label: "Formulae", value: "formula" },
        { label: "Code blocks", value: "code" },
        { label: "Picture classification", value: "picture_classification" },
        { label: "Picture description", value: "picture_description" },
        { label: "Chart extraction", value: "chart" },
      ],
    },
  }),
  heading_hierarchy: Property.Checkbox({
    displayName: "Heading Hierarchy",
    required: false,
    description:
      "Derive a heading structure for PDFs from bookmarks, numbering and styles.",
  }),
  include_page_images: Property.Checkbox({
    displayName: "Include Page Images",
    required: false,
    description: "Render each page as an image alongside the converted text.",
  }),
  images_scale: Property.Number({
    displayName: "Image Scale",
    required: false,
    description: "Resolution multiplier for page images (server default: 2).",
  }),
  document_timeout: Property.Number({
    displayName: "Document Timeout (seconds)",
    required: false,
    description:
      "Server-side cap on converting one document. Distinct from Timeout above, which is this step's own deadline.",
  }),
  abort_on_error: Property.Checkbox({
    displayName: "Abort On Error",
    required: false,
    description:
      "Fail the whole conversion on the first error instead of returning partial_success with the pages that worked.",
  }),
  // --- advanced: rarely needed, and wrong values fail at the server --------
  pdf_backend: Property.StaticDropdown({
    displayName: "Advanced — PDF Backend",
    required: false,
    description: "Parser used for PDFs. Leave empty unless diagnosing a parsing problem.",
    options: {
      options: [
        { label: "docling_parse", value: "docling_parse" },
        { label: "threaded_docling_parse", value: "threaded_docling_parse" },
        { label: "pypdfium2", value: "pypdfium2" },
        { label: "dlparse_v1", value: "dlparse_v1" },
        { label: "dlparse_v2", value: "dlparse_v2" },
        { label: "dlparse_v4", value: "dlparse_v4" },
      ],
    },
  }),
  // Open strings, not dropdowns: the 1.31.0 schema gives these no enum, so
  // any list we hard-coded would go stale the first time one is added.
  ocr_engine: Property.ShortText({
    displayName: "Advanced — OCR Engine",
    required: false,
    description: 'OCR engine name, e.g. "tesseract". Server default: auto.',
  }),
  ocr_preset: Property.ShortText({
    displayName: "Advanced — OCR Preset",
    required: false,
    description: "OCR preset name. Server default: auto.",
  }),
  table_cell_matching: Property.Checkbox({
    displayName: "Advanced — Table Cell Matching",
    required: false,
    description:
      "Match recognised table cells back to the PDF text (server default: on). Turning it off can help badly ruled tables.",
  }),
};
