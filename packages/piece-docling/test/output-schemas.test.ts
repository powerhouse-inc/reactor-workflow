import {
  chunkOutputFields,
  convertOutputFields,
  getResultOutputFields,
  healthOutputFields,
  jobOutputFields,
  transcribeOutputFields,
} from "../pieces/docling/lib/output-schemas.js";

it("convert fields cover the response shape", () => {
  expect(convertOutputFields.map((f) => f.key)).toEqual([
    "document",
    "status",
    "errors",
    "processing_time",
    // The Document Conversion add-on measures more than docling-serve's shape
    // has room for and sends it under a key of its own. An author cannot
    // reference what the builder does not list, so it is listed — and it is
    // simply absent against a stock docling-serve.
    "powerhouse",
  ]);
  expect(convertOutputFields.every((f) => f.label.length > 0)).toBe(true);
});

// The same block comes back from a transcription — a recording has a quality
// score and a textSource too — so both convert and transcribe list it.
it("transcribe fields carry the measurements block as well", () => {
  expect(transcribeOutputFields.map((f) => f.key)).toContain("powerhouse");
});

it("job/getResult fields cover the task lifecycle shape", () => {
  expect(jobOutputFields.map((f) => f.key)).toEqual([
    "task_id",
    "task_status",
    "task_position",
    "task_meta",
  ]);
  expect(getResultOutputFields.map((f) => f.key)).toEqual(["done", "task_id"]);
});

it("health and chunk fields are non-empty and labelled", () => {
  expect(healthOutputFields.map((f) => f.key)).toEqual(["status", "versions"]);
  expect(chunkOutputFields.map((f) => f.key)).toEqual(["chunks", "processing_time"]);
  expect(
    [...healthOutputFields, ...chunkOutputFields].every((f) => f.label.length > 0),
  ).toBe(true);
});
