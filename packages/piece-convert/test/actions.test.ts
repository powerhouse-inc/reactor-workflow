import { Buffer } from "node:buffer";
import { convertFileAction } from "../pieces/convert/lib/actions/convert-file.js";
import {
  convertUrlAction,
  filenameFromUrl,
} from "../pieces/convert/lib/actions/convert-url.js";
import { healthAction } from "../pieces/convert/lib/actions/health.js";
import { convertPiece } from "../pieces/convert/index.js";
import { makeActionContext } from "./mock-context.js";
import { startMockConvertService } from "./mock-convert-service.js";

function ctx(props: Record<string, unknown>, baseUrl = "http://127.0.0.1:1") {
  return makeActionContext(props, {
    type: "CUSTOM_AUTH",
    props: { base_url: baseUrl },
  }) as never;
}

type ConvertOut = { markdown: string; chunks: unknown[]; pages?: number | null };
type HealthOut = { ready: boolean; formats: string[] };

describe("the piece", () => {
  it("ships the three actions under stable names", () => {
    // The framework keeps them in `_actions`, keyed by name.
    const registered = (convertPiece as unknown as {
      _actions: Record<string, { name: string }>;
    })._actions;
    expect(Object.values(registered).map((a) => a.name).sort()).toEqual([
      "convert_file",
      "convert_url",
      "health",
    ]);
  });

  // The connection carries no credentials: the service is unauthenticated by
  // design, so offering an API key field would be a lie.
  it("asks only for a service URL", () => {
    const auth = convertPiece.auth as unknown as {
      props: Record<string, unknown>;
    };
    expect(Object.keys(auth.props)).toEqual(["base_url"]);
  });
});

describe("health action", () => {
  it("reports readiness and the formats the service reads", async () => {
    const mock = await startMockConvertService();
    try {
      const out = (await healthAction.run(ctx({}, mock.baseUrl))) as HealthOut;
      expect(out.ready).toBe(true);
      expect(out.formats).toContain("pdf");
    } finally {
      await mock.close();
    }
  });
});

describe("convert_file", () => {
  it("sends the file's bytes and returns markdown with chunks", async () => {
    const mock = await startMockConvertService();
    try {
      const out = (await convertFileAction.run(
        ctx(
          { file: { filename: "report.pdf", data: Buffer.from("%PDF-1.7 x") } },
          mock.baseUrl,
        ),
      )) as ConvertOut;

      const req = mock.requests.find((r) => r.path === "/convert");
      expect(req?.query.get("filename")).toBe("report.pdf");
      expect(req?.bodyBytes).toBeGreaterThan(0);
      expect(out.markdown).toContain("Mock document");
      expect(out.chunks).toHaveLength(2);
    } finally {
      await mock.close();
    }
  });

  it("asks for OCR and figures when the props are set", async () => {
    const mock = await startMockConvertService();
    try {
      await convertFileAction.run(
        ctx(
          {
            file: { filename: "a.pdf", data: Buffer.from("x") },
            ocr: true,
            figures: true,
          },
          mock.baseUrl,
        ),
      );
      const req = mock.requests.find((r) => r.path === "/convert");
      expect(req?.query.get("ocr")).toBe("1");
      expect(req?.query.get("figures")).toBe("1");
    } finally {
      await mock.close();
    }
  });

  it("rejects a timeout outside the accepted range", async () => {
    await expect(
      convertFileAction.run(
        ctx({ file: { filename: "a.pdf", data: Buffer.from("x") }, timeout_seconds: 2 }),
      ),
    ).rejects.toMatchObject({ kind: "VALIDATION" });
  });
});

describe("filenameFromUrl", () => {
  it("takes the last path segment when it carries an extension", () => {
    expect(filenameFromUrl("https://example.test/docs/report.pdf")).toBe("report.pdf");
    expect(filenameFromUrl("https://example.test/a/b/slides.pptx?v=2")).toBe("slides.pptx");
  });

  // The extension is what the service dispatches on, so a bare id is not a
  // usable name and the action must ask rather than guess.
  it("returns null when there is no extension to go on", () => {
    expect(filenameFromUrl("https://example.test/download/abc123")).toBeNull();
    expect(filenameFromUrl("https://example.test/")).toBeNull();
    expect(filenameFromUrl("not a url")).toBeNull();
  });

  it("decodes a percent-escaped name", () => {
    expect(filenameFromUrl("https://example.test/q1%20report.pdf")).toBe("q1 report.pdf");
  });
});

describe("convert_url", () => {
  it("refuses a URL whose file type cannot be told, naming the fix", async () => {
    const mock = await startMockConvertService();
    try {
      await expect(
        convertUrlAction.run(
          ctx({ url: "https://example.test/download/abc123" }, mock.baseUrl),
        ),
      ).rejects.toMatchObject({ kind: "VALIDATION" });
      // Nothing was downloaded or converted.
      expect(mock.requests.filter((r) => r.path === "/convert")).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it("requires a url", async () => {
    await expect(convertUrlAction.run(ctx({}))).rejects.toMatchObject({
      kind: "VALIDATION",
    });
  });
});
