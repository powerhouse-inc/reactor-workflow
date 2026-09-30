import { createAction } from "@powerhousedao/pieces-framework";
import { authFromCtx, convertAuth } from "../auth.js";
import { health } from "../client.js";
import { healthOutputFields } from "../output-schemas.js";

export const healthAction = createAction({
  auth: convertAuth,
  name: "health",
  displayName: "Health",
  description:
    "Whether the conversion service is reachable and its models are loaded, which formats it reads and which OCR rungs it has.",
  audience: "both",
  aiMetadata: {
    description:
      "Checks the document conversion service. Returns ready, missing dependencies, supported formats and capabilities.",
    idempotent: true,
  },
  outputSchema: { fields: healthOutputFields },
  props: {},
  run: async (ctx) => health(authFromCtx(ctx)),
});
