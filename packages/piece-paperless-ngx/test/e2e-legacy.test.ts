// The other half of the live suite: a pre-3.0 paperless, whose API tops out at
// version 9. This is what the version negotiation exists for — a client that
// pinned 10 outright would 406 on every request here. Skipped unless
// PAPERLESS_LEGACY_E2E_URL is set:
//
//   docker compose -f test/e2e-legacy-compose.yml up -d
//   PAPERLESS_LEGACY_E2E_URL=http://localhost:18001 \
//   pnpm vitest run test/e2e-legacy.test.ts
import { describe, expect, it } from "vitest";
import { customApiCall } from "../pieces/paperless-ngx/lib/actions/custom-api-call";
import { getTask } from "../pieces/paperless-ngx/lib/actions/get-task";
import { uploadDocument } from "../pieces/paperless-ngx/lib/actions/upload-document";
import { checkPaperlessConnection } from "../pieces/paperless-ngx/lib/auth";
import { newDocument } from "../pieces/paperless-ngx/lib/triggers/document-trigger";
import { MemoryStore, runAction, runHook } from "./helpers";

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

  // The reason the trigger asks what version it is talking to. 3.0 renamed
  // these filters, and DRF drops a field it does not know without a word — so
  // the 3.x spelling registers a trigger that fires on every document, and
  // nothing anywhere says so. This asserts what paperless kept.
  it("registers the document-type filter under the name 2.18 understands", async () => {
    const auth = await authFor();
    const store = new MemoryStore();

    const created = (await runAction(customApiCall, {
      auth,
      props: {
        method: "POST",
        path: "document_types/",
        body: { name: `legacy-type-${stamp}`, matching_algorithm: 0 },
      },
    })) as { body: { id: number } };
    const typeId = created.body.id;

    try {
      await runHook(newDocument, "onEnable", {
        auth,
        store,
        webhookUrl: `https://example.invalid/hook/${stamp}#tok-${stamp}`,
        props: { filter_has_any_document_types: [typeId] },
      });

      const registration = store.entries.get(
        "paperless:webhook-registration",
      ) as { workflow_id: number };
      const workflow = (await runAction(customApiCall, {
        auth,
        props: { method: "GET", path: `workflows/${registration.workflow_id}/` },
      })) as { body: { triggers: Record<string, unknown>[] } };

      const trigger = workflow.body.triggers[0];
      expect(trigger.filter_has_document_type).toBe(typeId);
      expect(trigger).not.toHaveProperty("filter_has_any_document_types");
    } finally {
      await runHook(newDocument, "onDisable", { auth, store });
      await runAction(customApiCall, {
        auth,
        props: { method: "DELETE", path: `document_types/${typeId}/` },
      });
    }
  }, 60_000);

  it("refuses a filter 2.18 cannot express, rather than dropping it", async () => {
    const auth = await authFor();

    await expect(
      runHook(newDocument, "onEnable", {
        auth,
        store: new MemoryStore(),
        webhookUrl: `https://example.invalid/hook/${stamp}-b#tok-${stamp}`,
        props: { filter_has_any_storage_paths: [1] },
      }),
    ).rejects.toThrow(/"Storage path is any of".*3\.0/s);
  }, 60_000);
});
