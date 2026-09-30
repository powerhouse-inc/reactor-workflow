// 0.32.0's `outputSchema` is a UI field descriptor list, not a validator
// (review fix 3): it describes the result shape to the builder/preview UI.
// The AI-facing contract (spec D10) rides on `audience` + `aiMetadata`.
export type OutputField = {
  key: string;
  label: string;
  description?: string;
};
export const convertOutputFields: OutputField[] = [
  { key: "document", label: "Converted Document", description: "Only the requested *_content fields are populated." },
  { key: "status", label: "Status", description: "success | partial_success | skipped | failure." },
  { key: "errors", label: "Errors" },
  { key: "processing_time", label: "Processing Time (s)" },
  {
    key: "powerhouse",
    label: "Conversion Measurements",
    description:
      "Only from the Document Conversion add-on, which measures more than " +
      "docling-serve's response shape has room for: quality.coverage (how " +
      "much of the document's own text survived), textSource (which rung of " +
      "the OCR ladder read it), ocrOffer (OCR worth running, with a cost " +
      "estimate), pages, figures and backend. Absent against a stock " +
      "docling-serve, so read it with `?.`.",
  },
];
export const jobOutputFields: OutputField[] = [
  { key: "task_id", label: "Task ID" },
  { key: "task_status", label: "Status" },
  { key: "task_position", label: "Queue Position" },
  { key: "task_meta", label: "Task Meta" },
];
export const getResultOutputFields: OutputField[] = [
  { key: "done", label: "Done", description: "false while the job is still running; true once the result is inlined." },
  { key: "task_id", label: "Task ID" },
];
export const healthOutputFields: OutputField[] = [
  { key: "status", label: "Status" },
  { key: "versions", label: "Server Versions" },
];
export const transcribeOutputFields: OutputField[] = [
  { key: "transcript", label: "Transcript", description: "Markdown; speaker-labelled and timestamped where docling diarized the audio." },
  { key: "speakers", label: "Speakers", description: "One entry per detected voice: { id, label }. Empty when no diarization ran." },
  { key: "segments", label: "Segments", description: "One entry per utterance: { start, end, startLabel, speaker, text }. Timings in seconds." },
  { key: "status", label: "Status", description: "success | partial_success | skipped | failure." },
  { key: "errors", label: "Errors" },
  { key: "processing_time", label: "Processing Time (s)" },
  {
    key: "powerhouse",
    label: "Conversion Measurements",
    description:
      "Only from the Document Conversion add-on, which measures more than " +
      "docling-serve's response shape has room for: quality.coverage (how " +
      "much of the document's own text survived), textSource (which rung of " +
      "the OCR ladder read it), ocrOffer (OCR worth running, with a cost " +
      "estimate), pages, figures and backend. Absent against a stock " +
      "docling-serve, so read it with `?.`.",
  },
];
export const chunkOutputFields: OutputField[] = [
  { key: "chunks", label: "Chunks", description: "One entry per chunk: { text, page_no, start_chunk_no, end_chunk_no }." },
  { key: "processing_time", label: "Processing Time (s)" },
];
