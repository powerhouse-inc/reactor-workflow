import { createAction, Property } from "@powerhousedao/pieces-framework";
import { doclingAuth, authFromCtx } from "../auth.js";
import { runConversion } from "../client.js";
import { DoclingError } from "../errors.js";
import {
  convertProps,
  executionMode,
  timeoutMs,
  type ConvertDocumentsOptionsPayload,
} from "../options.js";
import { transcribeOutputFields } from "../output-schemas.js";
import { buildTranscript } from "../transcript.js";

// Audio and video have no pages, tables or images to reason about, so the
// convert knobs are deliberately not offered here -- only execution mode and
// timeout, which still mean something for a long recording.
//
// There is no `pipeline` key, and there must not be: docling-jobkit rejects
// an explicit one outright ("The pipeline ProcessingPipeline.ASR is not
// implemented", v1.31.0) and routes audio to ASR by sniffing the content
// instead. Setting it looks correct and breaks every transcription.
function transcribeOptions(): ConvertDocumentsOptionsPayload {
  return {
    // json carries `texts[].source[].{start_time, end_time, voice}` -- the
    // timings and voices the transcript is built from. md is the plain full
    // text, kept as the fallback when a document has no track sources.
    to_formats: ["md", "json"],
    do_ocr: false,
    table_mode: "fast",
    do_table_structure: false,
    image_export_mode: "placeholder",
  };
}

/** Free-form prop values are `unknown`; keep the string pairs, drop the rest. */
function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim()) continue;
    if (value === "") continue;
    // A header value is a wire string. Anything else -- an object from a
    // mis-wired expression, say -- would stringify to "[object Object]" and
    // be sent as a real header, so it is dropped rather than mangled.
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const transcribeUrlAction = createAction({
  auth: doclingAuth,
  // Saved workflows refer to the action by name: do not rename once published.
  name: "transcribe_url",
  displayName: "Transcribe URL",
  description:
    "Has docling-serve fetch an audio or video recording from a URL and transcribe it (ASR), returning timed segments, the speakers it detected, and a rendered transcript.",
  audience: "both",
  aiMetadata: {
    description:
      "Transcribes audio or video at a URL via docling-serve. Returns `segments` ({start, end, speaker, text}), a `speakers` list, and a markdown `transcript`. Use for recordings — meetings, podcasts, talks — rather than documents.",
    idempotent: true,
  },
  outputSchema: { fields: transcribeOutputFields },
  props: {
    url: Property.ShortText({
      displayName: "Recording URL",
      required: true,
      description:
        "URL of the audio or video to transcribe. docling-serve downloads it itself, so the bytes never pass through the workflow.",
    }),
    headers: Property.Object({
      displayName: "Source Headers",
      required: false,
      description:
        "Sent with docling-serve's fetch of the URL, for a source that needs credentials — e.g. Authorization: Bearer <token> for a Google Drive file or a signed link.",
    }),
    execution: convertProps.execution,
    timeout_seconds: convertProps.timeout_seconds,
  },
  run: async (ctx) => {
    const raw = ctx.propsValue.url;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new DoclingError("VALIDATION", "The recording URL is required.");
    }
    const headers = normalizeHeaders(ctx.propsValue.headers);

    const result = await runConversion({
      auth: authFromCtx(ctx),
      source: {
        kind: "http",
        url: raw.trim(),
        ...(headers ? { headers } : {}),
      },
      options: transcribeOptions(),
      mode: executionMode(ctx.propsValue as never),
      timeoutMs: timeoutMs(ctx.propsValue as never),
      path: "convert",
    });

    const { segments, speakers, transcript } = buildTranscript(
      result.document?.json_content as never,
    );

    return {
      // A document with no track sources yields no rendered transcript; fall
      // back to docling's own markdown rather than returning nothing.
      transcript: transcript || (result.document?.md_content ?? ""),
      speakers,
      segments,
      status: result.status,
      errors: result.errors,
      processing_time: result.processing_time,
    };
  },
});
