import { submitJobAction } from "../src/lib/actions/submit-job.js";
import { getResultAction } from "../src/lib/actions/get-result.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling } from "./mock-docling-serve.js";

const AUTH = { type: "CUSTOM_AUTH", props: { base_url: "http://127.0.0.1:1", api_key: "k-test" } };
const ctx = (props: Record<string, unknown>) => makeActionContext(props, AUTH) as never;

describe("submit_job + get_result", () => {
  it("submits, then get_result polls to success and returns the document", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      (AUTH.props as { base_url: string }).base_url = mock.baseUrl;
      const sub = await submitJobAction.run(
        ctx({ url: "https://example.com/x.pdf", ocr: true, table_mode: "accurate", image_mode: "placeholder" }),
      ) as { task_id: string; task_status: string };
      expect(sub.task_status).toBe("pending");
      const r1 = await getResultAction.run(ctx({ task_id: sub.task_id, wait_seconds: 0 })) as Record<string, unknown>;
      // first poll → started (mock finishes after one poll)
      const r2 = await getResultAction.run(ctx({ task_id: sub.task_id, wait_seconds: 0 })) as { document?: { md_content?: string }; done?: boolean };
      if (r2.done === false) {
        const r3 = await getResultAction.run(ctx({ task_id: sub.task_id, wait_seconds: 0 })) as { document?: { md_content?: string } };
        expect(r3.document?.md_content).toBeTruthy();
      } else {
        expect(r2.document?.md_content).toBeTruthy();
      }
    } finally { await mock.close(); }
  });

  it("submit rejects when neither file nor url is given", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      (AUTH.props as { base_url: string }).base_url = mock.baseUrl;
      await expect(submitJobAction.run(ctx({}))).rejects.toMatchObject({ kind: "VALIDATION" });
    } finally { await mock.close(); }
  });

  it("get_result on a failed job throws the typed failure", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
    try {
      (AUTH.props as { base_url: string }).base_url = mock.baseUrl;
      const sub = await submitJobAction.run(
        ctx({ file: { filename: "bad.pdf", data: Buffer.from("x") } }),
      ) as { task_id: string };
      await expect(getResultAction.run(ctx({ task_id: sub.task_id }))).rejects.toMatchObject({
        kind: "JOB_FAILED",
        // vitest's stringContaining factory is any; suppression is line-scoped (R16)
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        message: expect.stringContaining("mock inference failure"),
      });
    } finally { await mock.close(); }
  });
});
