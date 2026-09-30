import { createAction, Property } from "@powerhousedao/pieces-framework";
import { httpClient, HttpMethod } from "@powerhousedao/pieces-framework/common";
import { authFromCtx, convertAuth } from "../auth.js";
import { convert } from "../client.js";
import { ConvertError } from "../errors.js";
import { convertOutputFields } from "../output-schemas.js";
import { convertProps, timeoutMs, type SharedProps } from "./shared.js";

/**
 * The last path segment, which is where the extension lives — and the
 * extension is how the service picks the format, so a URL without one has to
 * be named by hand.
 */
export function filenameFromUrl(raw: string): string | null {
  let path: string;
  try {
    path = new URL(raw).pathname;
  } catch {
    return null;
  }
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return null;
  const name = decodeURIComponent(last);
  return name.includes(".") ? name : null;
}

export const convertUrlAction = createAction({
  auth: convertAuth,
  name: "convert_url",
  displayName: "Convert URL",
  description:
    "Fetch a document from a URL and convert it to markdown, with retrieval-sized chunks and an extraction score.",
  audience: "both",
  aiMetadata: {
    description:
      "Downloads a document from a URL and converts it to markdown plus chunks.",
    idempotent: true,
  },
  outputSchema: { fields: convertOutputFields },
  props: {
    url: Property.ShortText({
      displayName: "URL",
      required: true,
      description:
        "Where to fetch the document. Unlike the conversion service, which takes bytes, this step downloads the file itself — so the URL has to be one this workflow is allowed to reach.",
    }),
    filename: Property.ShortText({
      displayName: "Filename",
      required: false,
      description:
        'Overrides the name taken from the URL. Required when the URL has no extension, e.g. "report.pdf" for a download link ending in an id — the extension is how the service picks the format.',
    }),
    ...convertProps,
  },
  run: async (ctx) => {
    const raw = ctx.propsValue.url;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new ConvertError("VALIDATION", "The URL property is required.");
    }
    const url = raw.trim();

    const override =
      typeof ctx.propsValue.filename === "string"
        ? ctx.propsValue.filename.trim()
        : "";
    const filename = override || filenameFromUrl(url);
    if (!filename) {
      throw new ConvertError(
        "VALIDATION",
        `Could not tell the file type from "${url}". Set Filename, e.g. report.pdf — the service picks the format from the extension.`,
      );
    }

    const deadline = timeoutMs(ctx.propsValue as SharedProps);

    let bytes: Buffer;
    try {
      const res = await httpClient.sendRequest({
        method: HttpMethod.GET,
        url,
        timeout: deadline,
        retries: 0,
        responseType: "arraybuffer",
      } as never);
      bytes = Buffer.from(res.body as ArrayBuffer);
    } catch (err) {
      throw new ConvertError(
        "UNREACHABLE",
        `Could not download ${url}: ${(err as Error)?.message ?? String(err)}`,
      );
    }

    return convert({
      auth: authFromCtx(ctx),
      filename,
      bytes,
      ocr: ctx.propsValue.ocr === true,
      figures: ctx.propsValue.figures === true,
      timeoutMs: deadline,
    });
  },
});
