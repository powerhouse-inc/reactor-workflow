import { createAction, Property } from "@powerhousedao/pieces-framework";
import { doclingAuth, authFromCtx } from "../auth.js";
import { DoclingError } from "../errors.js";
import { buildOptions, convertProps, executionMode, timeoutMs } from "../options.js";
import { runConversion } from "../client.js";
import { convertOutputFields } from "../output-schemas.js";

const urlProp = Property.ShortText({
  displayName: "URL",
  required: true,
  description: "Public URL of the document to convert (PDF, DOCX, …). ZIP archives are not supported.",
});

const filenameProp = Property.ShortText({
  displayName: "Filename",
  required: false,
  description:
    "Names the document when the URL does not — a share link such as " +
    "drive.google.com/uc?id=… carries no extension, and the format is read " +
    "from one. Leave empty when the URL ends in the file's own name.",
});

export const convertUrlAction = createAction({
  auth: doclingAuth,
  name: "convert_url",
  displayName: "Convert URL",
  description:
    "Downloads and converts a document from a public URL with a docling-serve v1 API and returns the requested output formats.",
  audience: "both",
  aiMetadata: {
    description:
      "Converts a document at a public URL to Markdown (or other formats) via docling-serve. Use when the source is a link rather than an uploaded file.",
    idempotent: true,
  },
  outputSchema: { fields: convertOutputFields },
  props: { url: urlProp, filename: filenameProp, ...convertProps },
  run: async (ctx) => {
    const raw = ctx.propsValue.url;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new DoclingError("VALIDATION", "The URL property is required.");
    }
    const url = raw.trim();
    if (url.toLowerCase().endsWith(".zip")) {
      throw new DoclingError("VALIDATION", "zip archives are not supported — convert the individual documents instead.");
    }
    const given = ctx.propsValue.filename;
    const filename = typeof given === "string" && given.trim() ? given.trim() : undefined;
    return runConversion({
      auth: authFromCtx(ctx),
      source: { kind: "http", url, filename },
      options: buildOptions(ctx.propsValue as never),
      mode: executionMode(ctx.propsValue as never),
      timeoutMs: timeoutMs(ctx.propsValue as never),
      path: "convert",
    });
  },
});
