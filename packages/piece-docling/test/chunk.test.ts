import { chunkAction } from "../pieces/docling/lib/actions/chunk.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling, MOCK_CHUNKS } from "./mock-docling-serve.js";
import { convertProps } from "../pieces/docling/lib/options.js";

describe("chunk", () => {
  it("chunks a url via /v1/chunk/hybrid/source (async)", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await chunkAction.run(
        makeActionContext(
          { url: "https://example.com/c.pdf", chunker: "hybrid", ocr: true, table_mode: "accurate", image_mode: "placeholder", execution: "async" },
          { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
        ) as never,
      ) as { chunks: unknown[] };
      expect(out.chunks).toEqual(MOCK_CHUNKS);
      const submit = mock.requests.find((r) => r.path === "/v1/chunk/hybrid/source/async");
      expect(submit).toBeTruthy();
    } finally { await mock.close(); }
  });

  it("uses the hierarchical endpoint when selected", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await chunkAction.run(
        makeActionContext(
          { file: "data:application/pdf;base64,QQ==", chunker: "hierarchical", execution: "async" },
          { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
        ) as never,
      );
      expect(mock.requests.some((r) => r.path === "/v1/chunk/hierarchical/source/async")).toBe(true);
    } finally { await mock.close(); }
  });

  it("requires one of file/url", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await expect(
        chunkAction.run(makeActionContext({ chunker: "hybrid", execution: "async" }, { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } }) as never),
      ).rejects.toMatchObject({ kind: "VALIDATION" });
    } finally { await mock.close(); }
  });

  it("sends conversion settings under convert_options (not options) in the chunk body", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await chunkAction.run(
        makeActionContext(
          { url: "https://example.com/c.pdf", chunker: "hybrid", execution: "async" },
          { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
        ) as never,
      );
      const posts = mock.requests.filter((r) => r.method === "POST");
      const idx = posts.findIndex((r) => r.path === "/v1/chunk/hybrid/source/async");
      expect(idx).toBeGreaterThanOrEqual(0);
      // The docling-serve chunk request model (BaseChunkDocumentsRequest)
      // names the conversion settings convert_options; the convert key
      // options is silently ignored server-side (settings would fall back
      // to defaults). Assert on the raw wire body — the quotes keep the
      // two key checks mutually exclusive.
      const raw = mock.requestBodies[idx];
      expect(raw).toContain('"convert_options"');
      expect(raw).not.toContain('"options"');
    } finally { await mock.close(); }
  });

  it("rejects when both file and url are provided", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await expect(
        chunkAction.run(
          makeActionContext(
            { file: "data:application/pdf;base64,QQ==", url: "https://example.com/c.pdf", chunker: "hybrid", execution: "async" },
            { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
          ) as never,
        ),
      ).rejects.toMatchObject({
        kind: "VALIDATION",
        // vitest's stringContaining factory is any; suppression is line-scoped
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        message: expect.stringContaining("not both"),
      });
    } finally { await mock.close(); }
  });
});

// chunk converts before it chunks, so every conversion control applies to it
// too. It used to list them one by one, which silently dropped each new
// option as it was added; it now takes all of them but `format`, whose
// output formats chunking replaces.
describe("chunk conversion props", () => {
  it("offers the same conversion controls as the convert actions", () => {
    const props = chunkAction.props as Record<string, unknown>;
    for (const key of Object.keys(convertProps)) {
      if (key === "format") continue;
      expect(props).toHaveProperty(key);
    }
  });

  it("does not offer an output format, which chunking replaces", () => {
    expect(chunkAction.props as Record<string, unknown>).not.toHaveProperty(
      "format",
    );
  });
});
