import { Property } from "@powerhousedao/pieces-framework";
import { ConvertError } from "../errors.js";

/** Settings both convert actions share. */
export const convertProps = {
  ocr: Property.Checkbox({
    displayName: "Force OCR",
    required: false,
    description:
      "Re-read the pages with OCR even where the service would not choose to. Use it when a scanned page came back empty, or to recover tables the flat text layer lost. Slow: the service estimates around 8 seconds a page.",
  }),
  figures: Property.Checkbox({
    displayName: "Include Figures",
    required: false,
    description:
      "Return the document's pictures and display formulas as PNGs, each keyed to its placeholder in the markdown.",
  }),
  timeout_seconds: Property.Number({
    displayName: "Timeout (seconds)",
    required: false,
    defaultValue: 600,
    description:
      "Deadline for the conversion (5–3600). A long document costs roughly two passes: the service converts, then chunks.",
  }),
};

export interface SharedProps {
  ocr?: boolean;
  figures?: boolean;
  timeout_seconds?: number;
}

export function timeoutMs(props: SharedProps): number {
  const t = props.timeout_seconds ?? 600;
  if (!Number.isFinite(t) || t < 5 || t > 3600) {
    throw new ConvertError(
      "VALIDATION",
      `timeout_seconds must be between 5 and 3600, got ${t}.`,
    );
  }
  return Math.floor(t) * 1000;
}
