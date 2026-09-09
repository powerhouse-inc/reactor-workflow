import { buildOptions, executionMode, timeoutMs } from "../src/lib/options.js";
import { DoclingError } from "../src/lib/errors.js";

describe("buildOptions", () => {
  it("maps the format presets to to_formats", () => {
    expect(buildOptions({}).to_formats).toEqual(["md"]);
    expect(buildOptions({ format: "markdown+json" }).to_formats).toEqual(["md", "json"]);
    expect(buildOptions({ format: "all" }).to_formats).toEqual(["md", "json", "html", "text", "doctags"]);
  });

  it("applies defaults", () => {
    expect(buildOptions({})).toEqual({
      to_formats: ["md"],
      do_ocr: true,
      table_mode: "accurate",
      do_table_structure: true,
      image_export_mode: "placeholder",
    });
  });

  it("passes a valid 1-based page_range through (array form)", () => {
    expect(buildOptions({ page_range: [2, 10] }).page_range).toEqual([2, 10]);
  });

  it("parses the builder's start-end string form", () => {
    expect(buildOptions({ page_range: "5-20" }).page_range).toEqual([5, 20]);
    expect(buildOptions({ page_range: "5" }).page_range).toEqual([5, 5]);
    expect(buildOptions({ page_range: "5-" }).page_range).toEqual([5, 2147483647]);
    expect(buildOptions({ page_range: " 5-20 " }).page_range).toEqual([5, 20]);
  });

  it("omits page_range when empty", () => {
    expect(buildOptions({ page_range: undefined }).page_range).toBeUndefined();
    expect(buildOptions({ page_range: "" }).page_range).toBeUndefined();
  });

  it("rejects invalid page_range", () => {
    expect(() => buildOptions({ page_range: [0, 5] })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: [5, 2] })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: "nonsense" })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: "0-5" })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: "5-3" })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: "1-2-3" })).toThrow(DoclingError);
  });

  it("execution/timeout defaults", () => {
    expect(executionMode({})).toBe("async");
    expect(executionMode({ execution: "sync" })).toBe("sync");
    expect(timeoutMs({})).toBe(600_000);
    expect(timeoutMs({ timeout_seconds: 30 })).toBe(30_000);
  });
});
