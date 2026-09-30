export type OutputField = {
  key: string;
  label: string;
  description?: string;
};

export const convertOutputFields: OutputField[] = [
  { key: "markdown", label: "Markdown", description: "The converted document." },
  { key: "chunks", label: "Chunks", description: "Retrieval-sized pieces with their heading paths: { text, headings }." },
  { key: "pages", label: "Pages" },
  { key: "textSource", label: "Text Source", description: "Which rung read the file: docling | pdfjs | tesseract | docling-ocr." },
  { key: "quality", label: "Extraction Quality", description: "{ coverage, rawTokens, formulas, images }. Coverage is a floor on completeness, not a proof." },
  { key: "figures", label: "Figures", description: "With Include Figures: pictures and display formulas as PNGs, keyed to their placeholder in the markdown." },
  { key: "ocrOffer", label: "OCR Offer", description: "Set when the text layer was read flat and OCR would recover tables, with its estimated cost." },
];

export const healthOutputFields: OutputField[] = [
  { key: "ready", label: "Ready" },
  { key: "missing", label: "Missing Dependencies" },
  { key: "formats", label: "Supported Formats" },
  { key: "capabilities", label: "Capabilities" },
];
