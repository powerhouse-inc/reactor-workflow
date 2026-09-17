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
}

export interface ConvertDocumentsOptionsPayload {
  to_formats: string[];
  do_ocr: boolean;
  table_mode: "fast" | "accurate";
  do_table_structure: boolean;
  image_export_mode: "placeholder" | "embedded" | "referenced";
  page_range?: [number, number];
}

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
  return out;
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
};
