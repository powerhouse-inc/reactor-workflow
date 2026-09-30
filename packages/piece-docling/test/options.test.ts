import { buildOptions, convertProps, executionMode, timeoutMs } from "../pieces/docling/lib/options.js";
import { DoclingError } from "../pieces/docling/lib/errors.js";

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

// The options below are all sent only when the user set them. docling's
// defaults are the server's to choose and they move: the design doc recorded
// `pdf_backend` defaulting to `threaded_docling_parse` while 1.31.0 answers
// `docling_parse`. Sending a default eagerly would freeze whichever value we
// believed at the time.
describe("buildOptions — options omitted unless set", () => {
  const KEYS = [
    "force_ocr",
    "ocr_lang",
    "document_timeout",
    "abort_on_error",
    "do_pdf_heading_hierarchy",
    "include_page_images",
    "images_scale",
    "pdf_backend",
    "ocr_engine",
    "ocr_preset",
    "table_cell_matching",
    "do_code_enrichment",
    "do_formula_enrichment",
    "do_picture_classification",
    "do_chart_extraction",
    "do_picture_description",
  ];

  it("sends none of them for an empty props object", () => {
    const out = buildOptions({}) as unknown as Record<string, unknown>;
    for (const key of KEYS) {
      expect(out).not.toHaveProperty(key);
    }
  });
});

describe("buildOptions — OCR controls", () => {
  it("passes force_ocr through when enabled", () => {
    expect(buildOptions({ force_ocr: true })).toMatchObject({ force_ocr: true });
  });

  // The schema types ocr_lang as array<string>; the builder field is a
  // comma-separated ShortText because a plain text box is what a workflow
  // author can fill from an expression.
  it("splits a comma-separated ocr_lang into the array the schema wants", () => {
    expect(buildOptions({ ocr_lang: "de, en ,fr" })).toMatchObject({
      ocr_lang: ["de", "en", "fr"],
    });
  });

  it("ignores an ocr_lang that is only separators", () => {
    expect(buildOptions({ ocr_lang: " , , " })).not.toHaveProperty("ocr_lang");
  });

  it("accepts an ocr_lang array as given, for expression-injected values", () => {
    expect(buildOptions({ ocr_lang: ["de", "en"] })).toMatchObject({
      ocr_lang: ["de", "en"],
    });
  });

  it("passes the open-string ocr engine and preset through untouched", () => {
    expect(
      buildOptions({ ocr_engine: "tesseract", ocr_preset: "scanned" }),
    ).toMatchObject({ ocr_engine: "tesseract", ocr_preset: "scanned" });
  });
});

describe("buildOptions — enrichments", () => {
  it("fans the multi-select out to the individual do_* flags", () => {
    expect(
      buildOptions({ enrichments: ["formula", "chart"] }),
    ).toMatchObject({
      do_formula_enrichment: true,
      do_chart_extraction: true,
    });
  });

  it("sets only the chosen flags, not the rest", () => {
    const out = buildOptions({ enrichments: ["code"] }) as unknown as Record<string, unknown>;
    expect(out.do_code_enrichment).toBe(true);
    expect(out).not.toHaveProperty("do_formula_enrichment");
    expect(out).not.toHaveProperty("do_picture_description");
  });

  it("maps every offered enrichment to a real schema flag", () => {
    expect(
      buildOptions({
        enrichments: [
          "code",
          "formula",
          "picture_classification",
          "chart",
          "picture_description",
        ],
      }),
    ).toMatchObject({
      do_code_enrichment: true,
      do_formula_enrichment: true,
      do_picture_classification: true,
      do_chart_extraction: true,
      do_picture_description: true,
    });
  });

  it("rejects an unknown enrichment rather than silently dropping it", () => {
    expect(() => buildOptions({ enrichments: ["nope"] })).toThrow(DoclingError);
  });

  it("ignores an empty enrichment selection", () => {
    expect(buildOptions({ enrichments: [] })).toEqual(buildOptions({}));
  });
});

describe("buildOptions — page images, structure and error handling", () => {
  it("passes the page-image controls through", () => {
    expect(
      buildOptions({ include_page_images: true, images_scale: 3 }),
    ).toMatchObject({ include_page_images: true, images_scale: 3 });
  });

  it("passes heading hierarchy and table cell matching through", () => {
    expect(
      buildOptions({ heading_hierarchy: true, table_cell_matching: false }),
    ).toMatchObject({
      do_pdf_heading_hierarchy: true,
      table_cell_matching: false,
    });
  });

  it("passes document_timeout and abort_on_error through", () => {
    expect(
      buildOptions({ document_timeout: 300, abort_on_error: true }),
    ).toMatchObject({ document_timeout: 300, abort_on_error: true });
  });

  // `false` is a deliberate choice, not an absence: table_cell_matching
  // defaults to true server-side, so turning it off has to reach the server.
  it("sends a deliberately false boolean rather than treating it as unset", () => {
    expect(buildOptions({ table_cell_matching: false })).toHaveProperty(
      "table_cell_matching",
      false,
    );
  });

  it("rejects a pdf_backend the schema does not list", () => {
    expect(() => buildOptions({ pdf_backend: "ghostscript" })).toThrow(
      DoclingError,
    );
  });

  it("accepts every pdf_backend the 1.31.0 schema lists", () => {
    for (const backend of [
      "pypdfium2",
      "docling_parse",
      "threaded_docling_parse",
      "dlparse_v1",
      "dlparse_v2",
      "dlparse_v4",
    ]) {
      expect(buildOptions({ pdf_backend: backend })).toMatchObject({
        pdf_backend: backend,
      });
    }
  });
});

// The mapping above is only reachable if the builder actually offers the
// fields. These are the props the convert/chunk actions pick up wholesale.
describe("convertProps", () => {
  it("offers the new conversion controls", () => {
    for (const key of [
      "force_ocr",
      "ocr_lang",
      "enrichments",
      "heading_hierarchy",
      "include_page_images",
      "images_scale",
      "document_timeout",
      "abort_on_error",
    ]) {
      expect(convertProps).toHaveProperty(key);
    }
  });

  it("offers the advanced controls too", () => {
    for (const key of ["pdf_backend", "ocr_engine", "ocr_preset", "table_cell_matching"]) {
      expect(convertProps).toHaveProperty(key);
    }
  });

  // include_images is not include_page_images: one asks for the pictures and
  // display formulas cut out of the pages, the other for whole-page renders.
  // The Document Conversion add-on reads it as its figure pass; a real
  // docling-serve reads it as "embed the images". Both want the same answer.
  it("passes include_images through, distinct from include_page_images", () => {
    expect(buildOptions({ include_images: true })).toMatchObject({
      include_images: true,
    });
    expect(buildOptions({ include_page_images: true })).not.toHaveProperty(
      "include_images",
    );
  });

  it("leaves include_images out when the author did not ask", () => {
    expect(buildOptions({})).not.toHaveProperty("include_images");
  });

  it("offers include_images as a prop", () => {
    expect(convertProps.include_images).toBeDefined();
  });

  // Every enrichment the builder offers must be one buildOptions accepts,
  // or the form would let an author pick something that throws at run time.
  it("offers only enrichments that map to a real flag", () => {
    const prop = convertProps.enrichments as unknown as {
      options: { options: { value: string }[] };
    };
    const offered = prop.options.options.map((o) => o.value);
    expect(offered.length).toBeGreaterThan(0);
    expect(() => buildOptions({ enrichments: offered })).not.toThrow();
  });

  // Same contract on the other side: the dropdown must not offer a backend
  // the validator rejects.
  it("offers only pdf backends buildOptions accepts", () => {
    const prop = convertProps.pdf_backend as unknown as {
      options: { options: { value: string }[] };
    };
    for (const { value } of prop.options.options) {
      expect(() => buildOptions({ pdf_backend: value })).not.toThrow();
    }
  });
});
