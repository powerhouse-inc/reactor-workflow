import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildTranscript,
  type DoclingJsonDocument,
  formatTimestamp,
  speakerLabel,
} from "../pieces/docling/lib/transcript.js";

// Read rather than `import ... with { type: "json" }`: the package's tsconfig
// does not list json in its file set, and the fixtures are test-only.
function fixture(name: string): DoclingJsonDocument {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as DoclingJsonDocument;
}

const twoSpeakers = fixture("two-speakers.docling.json");
const noDiarization = fixture("no-diarization.docling.json");

describe("formatTimestamp", () => {
  it("renders mm:ss below an hour", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(72)).toBe("01:12");
  });

  it("renders h:mm:ss at an hour and above", () => {
    expect(formatTimestamp(3661)).toBe("1:01:01");
  });
});

describe("speakerLabel", () => {
  it("letters speakers A, B, C by position", () => {
    expect(speakerLabel(0)).toBe("Speaker A");
    expect(speakerLabel(2)).toBe("Speaker C");
  });

  // A diarized recording can exceed 26 voices; the label must stay unique.
  it("carries past Z", () => {
    expect(speakerLabel(26)).toBe("Speaker AA");
  });
});

describe("buildTranscript", () => {
  it("extracts one segment per utterance with its timings and raw voice", () => {
    const { segments } = buildTranscript(twoSpeakers);

    expect(segments.length).toBeGreaterThan(0);
    const first = segments[0];
    expect(first.text).toBe("computer scientist e podcaster.");
    expect(first.start).toBe(0);
    expect(first.end).toBe(2.02);
    expect(first.startLabel).toBe("00:00");
    // The raw docling id, not the display label: it is the only stable key
    // for mapping a voice to a real name later.
    expect(first.speaker).toBe("SPEAKER_01");
  });

  it("lists each voice once, lettered in order of first appearance", () => {
    const { speakers } = buildTranscript(twoSpeakers);

    expect(speakers[0]).toEqual({ id: "SPEAKER_01", label: "Speaker A" });
    expect(new Set(speakers.map((s) => s.id)).size).toBe(speakers.length);
  });

  it("renders a speaker-labelled markdown transcript", () => {
    const { transcript } = buildTranscript(twoSpeakers);

    expect(transcript).toContain("**Speaker A** (00:00):");
    expect(transcript).toContain("computer scientist e podcaster.");
  });

  it("merges consecutive utterances by the same voice into one paragraph", () => {
    const { transcript } = buildTranscript(twoSpeakers);
    const paragraphs = transcript.split("\n\n");

    // The fixture opens with three consecutive SPEAKER_01 utterances; they
    // belong to one paragraph, so there are fewer paragraphs than segments.
    expect(paragraphs.length).toBeLessThan(
      buildTranscript(twoSpeakers).segments.length,
    );
    expect(paragraphs[0]).toContain("Since 2018");
  });

  // The case yesterday's meeting-only version threw away: it bailed with null
  // when no utterance carried a voice, and the caller fell back to docling's
  // plain markdown -- losing every timestamp. Solo narration and undiarized
  // podcasts are exactly that shape.
  it("keeps timings when no diarization ran", () => {
    const { segments, speakers, transcript } = buildTranscript(noDiarization);

    expect(segments).toHaveLength(3);
    expect(segments[0].speaker).toBeNull();
    expect(segments[0].start).toBe(0);
    expect(speakers).toEqual([]);
    expect(transcript).toContain("(00:00): Welcome back to the show.");
    // Still no speaker prefix to invent.
    expect(transcript).not.toContain("Speaker A");
  });

  it("labels an hour-plus timestamp in the rendered transcript", () => {
    const { transcript } = buildTranscript(noDiarization);

    expect(transcript).toContain("(1:01:01):");
  });

  it("returns an empty result for a document with no text items", () => {
    expect(buildTranscript({ texts: [] })).toEqual({
      segments: [],
      speakers: [],
      transcript: "",
    });
  });

  it("tolerates a missing or malformed document", () => {
    expect(buildTranscript(null).segments).toEqual([]);
    expect(buildTranscript(undefined).transcript).toBe("");
  });

  it("drops items whose text is blank after trimming", () => {
    const { segments } = buildTranscript({
      texts: [
        { text: "   ", source: [{ kind: "track", start_time: 1, voice: null }] },
        { text: "kept", source: [{ kind: "track", start_time: 2, voice: null }] },
      ],
    });

    expect(segments.map((s) => s.text)).toEqual(["kept"]);
  });

  // A docling document with no track source at all (a converted PDF, say)
  // yields text but no timings; the segment is still usable.
  it("keeps an untimed text item as a segment with null timings", () => {
    const { segments, transcript } = buildTranscript({
      texts: [{ text: "no track here" }],
    });

    expect(segments).toEqual([
      {
        start: null,
        end: null,
        startLabel: null,
        speaker: null,
        text: "no track here",
      },
    ]);
    expect(transcript).toBe("no track here");
  });
});
