import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transcribeUrlAction } from "../pieces/docling/lib/actions/transcribe-url.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling } from "./mock-docling-serve.js";

function ctx(props: Record<string, unknown>, baseUrl = "http://127.0.0.1:1") {
  return makeActionContext(props, {
    type: "CUSTOM_AUTH",
    props: { base_url: baseUrl, api_key: "k-test" },
  }) as never;
}

const twoSpeakers = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/two-speakers.docling.json", import.meta.url)),
    "utf8",
  ),
) as unknown;

/** `run` is typed through a `never` context, so the result needs naming. */
type TranscribeResult = {
  transcript: string;
  speakers: { id: string; label: string }[];
  segments: { speaker: string | null; start: number | null; text: string }[];
  status: string;
};

function sentBody(bodies: string[]): Record<string, unknown> {
  return JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
}

describe("transcribe_url", () => {
  it("returns segments, speakers and a rendered transcript", async () => {
    const mock = await startMockDocling({
      apiKey: "k-test",
      jsonDocument: twoSpeakers,
    });
    try {
      const out = (await transcribeUrlAction.run(
        ctx(
          { url: "https://example.test/ep-42.mp3", execution: "sync" },
          mock.baseUrl,
        ),
      )) as TranscribeResult;

      expect(out.segments.length).toBeGreaterThan(0);
      expect(out.segments[0].speaker).toBe("SPEAKER_01");
      expect(out.speakers[0]).toEqual({
        id: "SPEAKER_01",
        label: "Speaker A",
      });
      expect(out.transcript).toContain("**Speaker A** (00:00):");
      expect(out.status).toBe("success");
    } finally {
      await mock.close();
    }
  });

  it("asks for the json document, which the transcript is built from", async () => {
    const mock = await startMockDocling({
      apiKey: "k-test",
      jsonDocument: twoSpeakers,
    });
    try {
      await transcribeUrlAction.run(
        ctx({ url: "https://example.test/a.mp3", execution: "sync" }, mock.baseUrl),
      );
      const body = sentBody(mock.requestBodies) as {
        options?: { to_formats?: string[] };
      };
      expect(body.options?.to_formats).toContain("json");
    } finally {
      await mock.close();
    }
  });

  // docling-jobkit rejects an explicit pipeline outright ("The pipeline
  // ProcessingPipeline.ASR is not implemented", v1.31.0) and routes audio to
  // ASR by sniffing the content instead. Setting it looks right and breaks
  // every transcription, so the absence is pinned here.
  it("never sends an explicit pipeline", async () => {
    const mock = await startMockDocling({
      apiKey: "k-test",
      jsonDocument: twoSpeakers,
    });
    try {
      await transcribeUrlAction.run(
        ctx({ url: "https://example.test/a.mp3", execution: "sync" }, mock.baseUrl),
      );
      const body = sentBody(mock.requestBodies) as {
        options?: Record<string, unknown>;
      };
      expect(body.options).not.toHaveProperty("pipeline");
      expect(JSON.stringify(body)).not.toContain("asr");
    } finally {
      await mock.close();
    }
  });

  it("passes source headers so docling-serve can fetch a private recording", async () => {
    const mock = await startMockDocling({
      apiKey: "k-test",
      jsonDocument: twoSpeakers,
    });
    try {
      await transcribeUrlAction.run(
        ctx(
          {
            url: "https://example.test/private.mp4",
            headers: { Authorization: "Bearer drive-token" },
            execution: "sync",
          },
          mock.baseUrl,
        ),
      );
      const body = sentBody(mock.requestBodies) as {
        sources?: Array<Record<string, unknown>>;
      };
      expect(body.sources?.[0]).toMatchObject({
        kind: "http",
        headers: { Authorization: "Bearer drive-token" },
      });
    } finally {
      await mock.close();
    }
  });

  // A header value is a wire string. Anything that is not a primitive would
  // stringify to "[object Object]" and be sent as a real header, so it is
  // dropped rather than mangled.
  it("drops header values that are not primitives", async () => {
    const mock = await startMockDocling({
      apiKey: "k-test",
      jsonDocument: twoSpeakers,
    });
    try {
      await transcribeUrlAction.run(
        ctx(
          {
            url: "https://example.test/a.mp3",
            headers: { Authorization: "Bearer t", Bad: { nested: true } },
            execution: "sync",
          },
          mock.baseUrl,
        ),
      );
      const body = sentBody(mock.requestBodies) as {
        sources?: Array<{ headers?: Record<string, string> }>;
      };
      expect(body.sources?.[0]?.headers).toEqual({ Authorization: "Bearer t" });
    } finally {
      await mock.close();
    }
  });

  it("rejects a missing url", async () => {
    await expect(
      transcribeUrlAction.run(ctx({ execution: "sync" })),
    ).rejects.toMatchObject({ kind: "VALIDATION" });
  });

  // A recording almost never comes from a URL ending in .mp3 — a Drive or
  // Dropbox share link has no extension at all, and the format is read from
  // one. Without this the commonest source of a recording is unusable.
  it("names the recording when the URL does not", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await transcribeUrlAction.run(
        ctx(
          {
            url: "https://drive.google.com/uc?id=abc",
            filename: "standup.mp3",
            execution: "sync",
          },
          mock.baseUrl,
        ),
      );
      const body = JSON.parse(mock.requestBodies[0]) as {
        sources: { filename?: string }[];
      };
      expect(body.sources[0].filename).toBe("standup.mp3");
    } finally { await mock.close(); }
  });
});
