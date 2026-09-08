import { convertFileAction } from "../src/lib/actions/convert-file.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling, MOCK_MD } from "./mock-docling-serve.js";
import { DoclingError } from "../src/lib/errors.js";
import { convertUrlAction } from "../src/lib/actions/convert-url.js";

function ctx(props: Record<string, unknown>, baseUrl = "http://127.0.0.1:1") {
  return makeActionContext(props, {
    type: "CUSTOM_AUTH",
    props: { base_url: baseUrl, api_key: "k-test" },
  }) as never;
}

describe("convert_file", () => {
  it("converts an ApFile (Buffer) to markdown via async by default", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertFileAction.run(
        ctx({
          file: { filename: "a.pdf", data: Buffer.from("x"), extension: "pdf" },
          format: "markdown",
          ocr: true,
          table_mode: "accurate",
          image_mode: "placeholder",
          execution: "async",
        }, mock.baseUrl),
      ) as { document: { md_content: string }; status: string };
      expect(out.status).toBe("success");
      expect(out.document.md_content).toBe(MOCK_MD);
      expect(JSON.parse(mock.requestBodies[0])).toMatchObject({ sources: [{ kind: "file", base64_string: "eA==", filename: "a.pdf" }] });
    } finally { await mock.close(); }
  });

  it("converts a data-URI string file (reactor config shape)", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertFileAction.run(
        ctx({
          file: "data:application/pdf;base64," + Buffer.from("x").toString("base64"),
          execution: "async",
        }, mock.baseUrl),
      ) as { document: { md_content: string } };
      expect(out.document.md_content).toBe(MOCK_MD);
    } finally { await mock.close(); }
  });

  it("sends json_content when the markdown+json preset is chosen", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertFileAction.run(
        ctx({ file: { filename: "a.pdf", data: Buffer.from("x") }, format: "markdown+json", execution: "async" }, mock.baseUrl),
      ) as { document: { json_content: unknown } };
      expect(out.document.json_content).toBeTruthy();
    } finally { await mock.close(); }
  });

  it("maps a failing job to a typed error", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
    try {
      await expect(
        convertFileAction.run(
          ctx({ file: { filename: "bad.pdf", data: Buffer.from("x") }, execution: "async" }, mock.baseUrl),
        ),
      ).rejects.toMatchObject({ kind: "JOB_FAILED", name: "DoclingError" });
    } finally { await mock.close(); }
  });

  it("rejects a missing file", async () => {
    await expect(convertFileAction.run(ctx({}))).rejects.toMatchObject({ kind: "BAD_FILE" });
  });
});

describe("convert_url", () => {
  it("converts an http source (sync mode)", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertUrlAction.run(
        ctx({ url: "https://example.com/x.pdf", execution: "sync" }, mock.baseUrl),
      ) as { document: { md_content: string }; status: string };
      expect(out.status).toBe("success");
      expect(out.document.md_content).toBe(MOCK_MD);
    } finally { await mock.close(); }
  });

  it("rejects zip URLs before hitting the server", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await expect(
        convertUrlAction.run(ctx({ url: "https://example.com/x.zip", execution: "sync" })),
      // vitest's stringMatching factory is any; suppression is line-scoped (R14)
      // oxlint-disable-next-line typescript/no-unsafe-assignment
      ).rejects.toMatchObject({ kind: "VALIDATION", message: expect.stringMatching(/zip/) });
      expect(mock.requests.length).toBe(0);
    } finally { await mock.close(); }
  });
});
