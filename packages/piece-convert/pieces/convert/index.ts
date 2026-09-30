import { createPiece, PieceCategory } from "@powerhousedao/pieces-framework";
import { authFromCtx, convertAuth } from "./lib/auth.js";
import { health } from "./lib/client.js";
import { ConvertError } from "./lib/errors.js";
import { convertFileAction } from "./lib/actions/convert-file.js";
import { convertUrlAction } from "./lib/actions/convert-url.js";
import { healthAction } from "./lib/actions/health.js";

const DOC_LOGO =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#0f766e"/><path d="M14 10h14l8 8v20a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#fff"/><path d="M28 10v8h8" fill="none" stroke="#0f766e" stroke-width="2"/><path d="M18 26h12M18 31h12M18 36h8" stroke="#0f766e" stroke-width="2"/></svg>`,
  );

const result = createPiece({
  displayName: "Document Conversion",
  description:
    "Convert PDF, DOCX, PPTX, images and HTML to markdown with retrieval-sized chunks, figures and an extraction score, through the Document Conversion add-on running inside your environment.",
  logoUrl: DOC_LOGO,
  authors: ["froid"],
  categories: [PieceCategory.CONTENT_AND_FILES],
  auth: convertAuth,
  actions: [healthAction, convertFileAction, convertUrlAction],
  triggers: [],
});

// The workflow-runtime's checkConnection subgraph predates the framework's
// auth.validate convention and calls piece.checkConnection(ctx) with the
// shaped auth. This bridges the two, reporting the backend and version as the
// connection label. Never called by real Activepieces.
const convertPiece = result as typeof result & {
  checkConnection: (ctx: unknown) => Promise<{ name: string }>;
};

convertPiece.checkConnection = async (ctx: unknown) => {
  const report = await health(authFromCtx(ctx as { auth?: unknown }));
  if (!report.ready) {
    throw new ConvertError(
      "UNREACHABLE",
      `The service is not ready; missing: ${report.missing.join(", ") || "unknown"}.`,
    );
  }
  const backend = report.backend ?? "conversion service";
  return { name: report.version ? `${backend} ${report.version}` : backend };
};

export { convertPiece };
export default convertPiece;
