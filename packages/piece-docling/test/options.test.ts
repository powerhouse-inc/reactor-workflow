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

  it("passes a valid 1-based page_range through", () => {
    expect(buildOptions({ page_range: [2, 10] }).page_range).toEqual([2, 10]);
  });

  it("rejects invalid page_range", () => {
    expect(() => buildOptions({ page_range: [0, 5] })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: [5, 2] })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: "nonsense" })).toThrow(DoclingError);
  });

  it("execution/timeout defaults", () => {
    expect(executionMode({})).toBe("async");
    expect(executionMode({ execution: "sync" })).toBe("sync");
    expect(timeoutMs({})).toBe(600_000);
    expect(timeoutMs({ timeout_seconds: 30 })).toBe(30_000);
  });
});
