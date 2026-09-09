import {
  chunkOutputFields,
  convertOutputFields,
  getResultOutputFields,
  healthOutputFields,
  jobOutputFields,
} from "../src/lib/output-schemas.js";

it("convert fields cover the response shape", () => {
  expect(convertOutputFields.map((f) => f.key)).toEqual([
    "document",
    "status",
    "errors",
    "processing_time",
  ]);
  expect(convertOutputFields.every((f) => f.label.length > 0)).toBe(true);
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
