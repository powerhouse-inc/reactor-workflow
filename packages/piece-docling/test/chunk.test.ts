import { chunkAction } from "../src/lib/actions/chunk.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling, MOCK_CHUNKS } from "./mock-docling-serve.js";

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
});
