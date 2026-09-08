import { createPiece } from "@activepieces/pieces-framework";
import { PieceCategory } from "@activepieces/shared";
import { healthAction } from "./lib/actions/health.js";

// Stub — replaced by Task 4. Kept minimal so the bundle/loader pipeline is
// proven before any real logic exists.
const stub = createPiece({
  displayName: "Docling",
  description: "Docling document conversion (stub).",
  logoUrl: "data:image/svg+xml,stub",
  authors: ["froid"],
  categories: [PieceCategory.CONTENT_AND_FILES],
  auth: undefined,
  actions: [healthAction],
  triggers: [],
});

export { stub as docling };
export default stub;
