import { createPiece, PieceCategory } from "@powerhousedao/pieces-framework";
import { doclingAuth } from "./lib/auth.js";
import { healthAction } from "./lib/actions/health.js";
import { convertFileAction } from "./lib/actions/convert-file.js";
import { convertUrlAction } from "./lib/actions/convert-url.js";
import { submitJobAction } from "./lib/actions/submit-job.js";
import { getResultAction } from "./lib/actions/get-result.js";
import { chunkAction } from "./lib/actions/chunk.js";

const DOC_LOGO =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#1e3a8a"/><path d="M14 10h14l8 8v20a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#fff"/><path d="M28 10v8h8" fill="none" stroke="#1e3a8a" stroke-width="2"/><path d="M18 24h12M18 29h12M18 34h8" stroke="#1e3a8a" stroke-width="2"/></svg>`,
  );

export const docling = createPiece({
  displayName: "Docling",
  description:
    "Convert documents (PDF, DOCX, PPTX, images, HTML, …) to Markdown, docling-document JSON, HTML, DocTags and plain text via a docling-serve v1 API (self-hosted or Docling for IBM watsonx).",
  logoUrl: DOC_LOGO,
  authors: ["froid"],
  categories: [PieceCategory.CONTENT_AND_FILES],
  auth: doclingAuth,
  actions: [healthAction, convertFileAction, convertUrlAction, submitJobAction, getResultAction, chunkAction],
  triggers: [],
});

export default docling;
