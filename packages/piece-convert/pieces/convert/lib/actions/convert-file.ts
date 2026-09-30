import { createAction, Property } from "@powerhousedao/pieces-framework";
import { authFromCtx, convertAuth } from "../auth.js";
import { convert } from "../client.js";
import { fileBytes, normalizeFile } from "../files.js";
import { convertOutputFields } from "../output-schemas.js";
import { convertProps, timeoutMs, type SharedProps } from "./shared.js";

export const convertFileAction = createAction({
  auth: convertAuth,
  name: "convert_file",
  displayName: "Convert File",
  description:
    "Convert an attached document (PDF, DOCX, PPTX, images, HTML, …) to markdown, with retrieval-sized chunks and an extraction score.",
  audience: "both",
  aiMetadata: {
    description:
      "Converts an uploaded document to markdown plus chunks. Use for a file already in the workflow; use Convert URL for a link.",
    idempotent: true,
  },
  outputSchema: { fields: convertOutputFields },
  props: { file: Property.File({ displayName: "File", required: true }), ...convertProps },
  run: async (ctx) => {
    const file = normalizeFile(ctx.propsValue.file);
    return convert({
      auth: authFromCtx(ctx),
      // The extension is how the service picks the format, so the normalised
      // filename is passed through rather than a generic name.
      filename: file.filename,
      bytes: fileBytes(file),
      ocr: ctx.propsValue.ocr === true,
      figures: ctx.propsValue.figures === true,
      timeoutMs: timeoutMs(ctx.propsValue as SharedProps),
    });
  },
});
