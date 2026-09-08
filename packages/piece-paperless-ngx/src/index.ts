import { PieceCategory } from "@activepieces/shared";
import { createPiece } from "@activepieces/pieces-framework";
import { checkPaperlessConnection, paperlessAuth } from "./lib/auth";
import { bulkEditDocuments } from "./lib/actions/bulk-edit-documents";
import { customApiCall } from "./lib/actions/custom-api-call";
import { findOrCreateObject } from "./lib/actions/find-or-create-object";
import { getDocument } from "./lib/actions/get-document";
import { getDocumentFile } from "./lib/actions/get-document-file";
import { getTask } from "./lib/actions/get-task";
import { searchDocuments } from "./lib/actions/search-documents";
import { updateDocument } from "./lib/actions/update-document";
import { uploadDocument } from "./lib/actions/upload-document";
import { PAPERLESS_LOGO } from "./lib/logo";

export const paperlessNgx = createPiece({
  displayName: "Paperless-ngx",
  description:
    "Manage documents in a self-hosted paperless-ngx archive: upload, search, tag, and react to new documents.",
  logoUrl: PAPERLESS_LOGO,
  authors: ["powerhouse-inc"],
  categories: [PieceCategory.CONTENT_AND_FILES],
  minimumSupportedRelease: "0.30.0",
  auth: paperlessAuth,
  actions: [
    uploadDocument,
    getDocument,
    getDocumentFile,
    searchDocuments,
    updateDocument,
    bulkEditDocuments,
    findOrCreateObject,
    getTask,
    customApiCall,
  ],
  triggers: [],
});

// The reactor's checkConnection mutation calls `piece.checkConnection(ctx)` if
// the piece declares one, and records its label on the connection document.
// Not part of the Activepieces surface (real AP never calls it), and the host
// tolerates its absence — declaring it is what gives the connection a status
// and an account label.
(
  paperlessNgx as unknown as {
    checkConnection: (context: { auth?: unknown }) => Promise<unknown>;
  }
).checkConnection = checkPaperlessConnection;

export { paperlessAuth };
export default paperlessNgx;
