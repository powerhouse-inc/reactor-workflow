// The other half of the live suite: a pre-3.0 paperless, whose API tops out at
// version 9. This is what the version negotiation exists for — a client that
// pinned 10 outright would 406 on every request here. Skipped unless
// PAPERLESS_LEGACY_E2E_URL is set:
//
//   docker compose -f test/e2e-legacy-compose.yml up -d
//   PAPERLESS_LEGACY_E2E_URL=http://localhost:18001 \
//   pnpm vitest run test/e2e-legacy.test.ts
import { describe, expect, it } from "vitest";
import { customApiCall } from "../src/lib/actions/custom-api-call";
import { getTask } from "../src/lib/actions/get-task";
import { uploadDocument } from "../src/lib/actions/upload-document";
import { checkPaperlessConnection } from "../src/lib/auth";
import { MemoryStore, runAction } from "./helpers";

const baseUrl = process.env.PAPERLESS_LEGACY_E2E_URL;
const username = process.env.PAPERLESS_E2E_USER ?? "admin";
const password = process.env.PAPERLESS_E2E_PASSWORD ?? "paperless-e2e";

const stamp = Date.now();

async function authFor(): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) {
    throw new Error(`Could not mint an API token: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { token: string };
  return { type: "CUSTOM_AUTH", props: { base_url: baseUrl, token: body.token } };
}

describe.skipIf(!baseUrl)("live paperless-ngx 2.18", () => {
  it("negotiates down to version 9 instead of failing", async () => {
    const auth = await authFor();
    const identity = await checkPaperlessConnection({ auth });

    expect(identity.apiVersion).toBe(9);
    expect(identity.serverVersion).toMatch(/^2\.18\./);
    console.log(`connected: ${identity.name}`);
  }, 60_000);

  it("caches the negotiated version, so the 406 happens once", async () => {
    const auth = await authFor();
    const store = new MemoryStore();

    await runAction(customApiCall, {
      auth,
      props: { method: "GET", path: "tags/" },
      store,
    });

    const host = new URL(baseUrl!).host;
    expect(store.entries.get(`paperless:api-version:${host}`)).toBe(9);
  }, 60_000);

  it("reads the v9 tasks list, which is not paginated", async () => {
    const auth = await authFor();
    const raw = (await runAction(customApiCall, {
      auth,
      props: { method: "GET", path: "tasks/" },
    })) as { status: number; body: unknown };

    // v10 wraps this in {count, results}; v9 answers with a bare array, which
    // is the second divergence the negotiation has to absorb.
    expect(raw.status).toBe(200);
    expect(Array.isArray(raw.body)).toBe(true);
  }, 60_000);

  it("normalizes a v9 task row to the same fields as v10", async () => {
    const auth = await authFor();
    const result = (await runAction(uploadDocument, {
      auth,
      props: {
        file: {
          filename: `legacy-${stamp}.txt`,
          data: Buffer.from(`Legacy consumption ${stamp}\n`, "utf8"),
        },
        title: `Legacy ${stamp}`,
        wait_for_consumption: true,
        timeout_seconds: 300,
      },
    })) as { status: string; document_id: number; task_id: string };

    expect(result.status).toBe("success");
    expect(typeof result.document_id).toBe("number");

    // v9 reports `related_document` and `task_file_name`; the normaliser maps
    // both onto the v10 field names the actions use.
    const task = (await runAction(getTask, {
      auth,
      props: { task_id: result.task_id },
    })) as Record<string, unknown>;
    expect(task.document_id).toBe(result.document_id);
    expect(task.filename).toBe(`legacy-${stamp}.txt`);
    expect(task.raw).toHaveProperty("related_document");
    expect(task.raw).not.toHaveProperty("related_document_ids");
  }, 420_000);
});
