// Turns docling's ASR output into segments, a speaker list and a rendered
// markdown transcript.
//
// docling returns a normal DoclingDocument: each entry in `texts` carries
// `source: [{ kind: "track", start_time, end_time, voice }]`, where `voice`
// ("SPEAKER_01") is present only when diarization ran.
//
// Segments are the primitive here, not speakers. A meeting groups them by
// voice, a podcast reads them as a timeline, and solo narration has no voice
// at all -- so a speaker is an optional attribute of a segment rather than
// the thing the transcript is organised around. That also keeps the timings
// on the undiarized path, which a speakers-first reading has to throw away.

export interface TrackSource {
  kind?: string;
  start_time?: number | null;
  end_time?: number | null;
  voice?: string | null;
}

export interface TextItem {
  text?: string;
  source?: TrackSource[];
}

export interface DoclingJsonDocument {
  texts?: TextItem[];
}

export interface TranscriptSegment {
  /** Seconds from the start of the recording, or null for an untimed item. */
  start: number | null;
  end: number | null;
  /** `start` as mm:ss / h:mm:ss, for display. */
  startLabel: string | null;
  /** docling's own voice id, e.g. "SPEAKER_01"; null when undiarized. */
  speaker: string | null;
  text: string;
}

export interface SpeakerRef {
  id: string;
  label: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  speakers: SpeakerRef[];
  transcript: string;
}

/** "Speaker A", "Speaker B", … "Speaker AA" — by order of first appearance. */
export function speakerLabel(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Speaker ${label}`;
}

/** Seconds as mm:ss, or h:mm:ss once past an hour. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function toSegment(item: TextItem): TranscriptSegment | null {
  const text = (item.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const track = item.source?.find((s) => s.kind === "track") ?? item.source?.[0];
  const start = track?.start_time ?? null;
  return {
    start,
    end: track?.end_time ?? null,
    startLabel: start === null ? null : formatTimestamp(start),
    speaker: track?.voice ?? null,
    text,
  };
}

function render(segments: TranscriptSegment[], labels: Map<string, string>) {
  const paragraphs: { head: string | null; parts: string[] }[] = [];
  for (const segment of segments) {
    const last = paragraphs.at(-1);
    // Only a known voice merges with what came before it. Without
    // diarization there is nothing saying two consecutive utterances share a
    // speaker, and merging them would collapse their timestamps into one.
    const continues =
      segment.speaker !== null &&
      last !== undefined &&
      last.head !== null &&
      last.head.startsWith(`**${labels.get(segment.speaker) ?? ""}**`);
    if (continues) {
      last.parts.push(segment.text);
      continue;
    }
    const who = segment.speaker ? `**${labels.get(segment.speaker)}**` : "";
    const when = segment.startLabel ? `(${segment.startLabel})` : "";
    const head = [who, when].filter(Boolean).join(" ");
    paragraphs.push({ head: head || null, parts: [segment.text] });
  }
  return paragraphs
    .map((p) => (p.head ? `${p.head}: ${p.parts.join(" ")}` : p.parts.join(" ")))
    .join("\n\n");
}

export function buildTranscript(
  doc: DoclingJsonDocument | null | undefined,
): Transcript {
  const segments = (doc?.texts ?? [])
    .map(toSegment)
    .filter((s): s is TranscriptSegment => s !== null);

  const labels = new Map<string, string>();
  for (const segment of segments) {
    if (segment.speaker && !labels.has(segment.speaker)) {
      labels.set(segment.speaker, speakerLabel(labels.size));
    }
  }

  return {
    segments,
    speakers: [...labels].map(([id, label]) => ({ id, label })),
    transcript: render(segments, labels),
  };
}
