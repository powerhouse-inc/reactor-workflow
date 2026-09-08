import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWebhookQuery,
  documentUpdated,
  newDocument,
  splitWebhookUrl,
} from "../src/lib/triggers/document-trigger";
import type { MockPaperless } from "./mock-paperless";
import { startMockPaperless } from "./mock-paperless";
import { authFor, MemoryStore, runHook } from "./helpers";

const WEBHOOK_URL = "https://switchboard.example.com/graphql/workflow-runtime#tok-abc";

let mock: MockPaperless;

beforeEach(async () => {
  mock = await startMockPaperless();
});

afterEach(async () => {
  await mock.close();
});

function registeredWorkflow() {
  return [...mock.workflows.values()][0];
}

function webhookOf(workflow: { actions: Record<string, unknown>[] }) {
  return workflow.actions[0].webhook as Record<string, unknown>;
}

describe("splitWebhookUrl", () => {
  it("takes the token from the fragment, which never travels on the wire", () => {
    expect(splitWebhookUrl(WEBHOOK_URL)).toEqual({
      endpoint: "https://switchboard.example.com/graphql/workflow-runtime",
      token: "tok-abc",
    });
  });

  it("tolerates a URL with no token", () => {
    expect(splitWebhookUrl("https://x.example.com/graphql")).toEqual({
      endpoint: "https://x.example.com/graphql",
    });
  });
});

describe("the registered Jinja payload", () => {
  it("interpolates doc_id and nothing else, with no accidental brace pair", () => {
    const query = buildWebhookQuery("DOCUMENT_ADDED");
    const placeholders = query.match(/\{\{/g) ?? [];

    expect(placeholders).toHaveLength(1);
    expect(query).toContain("{{doc_id}}");
    // Every known paperless placeholder renders as a raw string, so any of
    // these would let a document title break the JSON body.
    for (const unsafe of ["doc_title", "correspondent", "filename", "doc_url"]) {
      expect(query).not.toContain(unsafe);
    }
  });
});

describe("onEnable", () => {
  it("registers trigger, action and webhook in a single atomic POST", async () => {
    const store = new MemoryStore();

    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
      store,
      props: {
        filter_filename: "*.pdf",
        sources: [2, 3],
        filter_has_tags: [7],
        matching_algorithm: 4,
        match: "invoice",
      },
    });

    const posts = mock.requests.filter(
      (request) => request.method === "POST" && request.path === "/workflows/",
    );
    expect(posts).toHaveLength(1);
    // Nothing else was created: no separate trigger or action requests.
    expect(
      mock.requests.filter((request) =>
        request.path.startsWith("/workflow_"),
      ),
    ).toHaveLength(0);

    const workflow = registeredWorkflow();
    expect(workflow.triggers[0]).toMatchObject({
      type: 2,
      filter_filename: "*.pdf",
      sources: [2, 3],
      filter_has_tags: [7],
      matching_algorithm: 4,
      match: "invoice",
    });

    const webhook = webhookOf(workflow);
    expect(webhook).toMatchObject({
      url: "https://switchboard.example.com/graphql/workflow-runtime",
      use_params: true,
      as_json: true,
      include_document: false,
      headers: { "X-Powerhouse-Webhook-Token": "tok-abc" },
    });
    expect((webhook.params as { query: string }).query).toContain("{{doc_id}}");

    expect(store.entries.get("paperless:webhook-registration")).toMatchObject({
      workflow_id: workflow.id,
      trigger_id: workflow.triggers[0].id,
      action_id: workflow.actions[0].id,
    });
    // The sweep starts from now, so the existing archive does not replay.
    expect(typeof store.entries.get("paperless:sweep-cursor")).toBe("string");
  });

  it("registers the updated trigger as paperless type 3", async () => {
    await runHook(documentUpdated, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
    });
    expect(registeredWorkflow().triggers[0]).toMatchObject({ type: 3 });
  });

  it("updates in place on a republish, which is how a rotated token lands", async () => {
    const store = new MemoryStore();
    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
      store,
    });
    const first = registeredWorkflow();

    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl:
        "https://switchboard.example.com/graphql/workflow-runtime#tok-rotated",
      store,
    });

    expect(mock.workflows.size).toBe(1);
    const patches = mock.requests.filter(
      (request) => request.method === "PATCH",
    );
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe(`/workflows/${first.id}/`);
    expect(webhookOf(registeredWorkflow()).headers).toEqual({
      "X-Powerhouse-Webhook-Token": "tok-rotated",
    });
  });

  it("refuses when no public URL is configured", async () => {
    await expect(
      runHook(newDocument, "onEnable", {
        auth: authFor(mock),
        webhookUrl: "http://localhost:0/v1/webhooks/flow-1",
      }),
    ).rejects.toThrow(/no public webhook URL/);
    expect(mock.workflows.size).toBe(0);
  });

  it("refuses a URL longer than the 256 characters paperless stores", async () => {
    await expect(
      runHook(newDocument, "onEnable", {
        auth: authFor(mock),
        webhookUrl: `https://switchboard.example.com/${"x".repeat(240)}#tok`,
      }),
    ).rejects.toThrow(/at most 256/);
  });

  it("checks the workflow-editing permission, not just read access", async () => {
    await mock.close();
    mock = await startMockPaperless({
      permissions: ["view_document", "view_workflow"],
    });

    await expect(
      runHook(newDocument, "onEnable", {
        auth: authFor(mock),
        webhookUrl: WEBHOOK_URL,
      }),
    ).rejects.toThrow(/add_workflow and change_workflow.*by hand/s);
    expect(mock.workflows.size).toBe(0);
  });
});

describe("onDisable", () => {
  it("deletes the workflow, the action and the trigger", async () => {
    const store = new MemoryStore();
    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
      store,
    });
    const workflow = registeredWorkflow();

    await runHook(newDocument, "onDisable", { auth: authFor(mock), store });

    const deletes = mock.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.path);
    expect(deletes).toEqual([
      `/workflows/${workflow.id}/`,
      `/workflow_actions/${workflow.actions[0].id as number}/`,
      `/workflow_triggers/${workflow.triggers[0].id as number}/`,
    ]);
    expect(mock.workflows.size).toBe(0);
    expect(store.entries.get("paperless:webhook-registration")).toBeNull();
  });

  it("tolerates pieces a user already removed by hand", async () => {
    const store = new MemoryStore();
    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
      store,
    });
    const workflow = registeredWorkflow();
    mock.failOnce(
      `DELETE /workflow_actions/${workflow.actions[0].id as number}/`,
      404,
      { detail: "Not found." },
    );

    await expect(
      runHook(newDocument, "onDisable", { auth: authFor(mock), store }),
    ).resolves.toBeUndefined();
  });

  it("does nothing when there is no registration", async () => {
    await expect(
      runHook(newDocument, "onDisable", { auth: authFor(mock) }),
    ).resolves.toBeUndefined();
    expect(mock.requests).toHaveLength(0);
  });
});

describe("run", () => {
  it("hydrates the document a delivery points at", async () => {
    const document = mock.seedDocument({
      title: 'Invoice "Q3"',
      content: "y".repeat(4000),
      modified: "2026-09-05T08:00:00.000Z",
    });

    const items = (await runHook(newDocument, "run", {
      auth: authFor(mock),
      payload: { docId: document.id, event: "DOCUMENT_ADDED" },
    })) as Record<string, unknown>[];

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Invoice "Q3"');
    expect(items[0]).not.toHaveProperty("content");
    expect(items[0]._dedupe_key).toBe(
      `${document.id}:DOCUMENT_ADDED:2026-09-05T08:00:00.000Z`,
    );
  });

  it("keeps the OCR text when the trigger asks for it", async () => {
    const document = mock.seedDocument({ content: "scanned words" });

    const items = (await runHook(newDocument, "run", {
      auth: authFor(mock),
      props: { include_content: true },
      payload: { docId: document.id },
    })) as Record<string, unknown>[];

    expect(items[0].content).toBe("scanned words");
  });

  it("sweeps from the cursor when there is no payload, then advances it", async () => {
    const store = new MemoryStore();
    await store.put("paperless:sweep-cursor", "2026-09-01T00:00:00.000Z");
    mock.seedDocument({ added: "2026-08-01T00:00:00.000Z" }); // before cursor
    const second = mock.seedDocument({ added: "2026-09-02T00:00:00.000Z" });
    const third = mock.seedDocument({ added: "2026-09-03T00:00:00.000Z" });

    const items = (await runHook(newDocument, "run", {
      auth: authFor(mock),
      store,
    })) as Record<string, unknown>[];

    expect(items.map((item) => item.id)).toEqual([second.id, third.id]);
    expect(store.entries.get("paperless:sweep-cursor")).toBe(
      "2026-09-03T00:00:00.000Z",
    );

    // Nothing new: the recovery sweep is quiet when the webhook kept up.
    const again = (await runHook(newDocument, "run", {
      auth: authFor(mock),
      store,
    })) as Record<string, unknown>[];
    expect(again).toEqual([]);
  });

  it("sweeps the updated trigger by modified, not added", async () => {
    const store = new MemoryStore();
    await store.put("paperless:sweep-cursor", "2026-09-01T00:00:00.000Z");
    mock.seedDocument({
      added: "2026-08-01T00:00:00.000Z",
      modified: "2026-09-04T00:00:00.000Z",
    });

    const items = (await runHook(documentUpdated, "run", {
      auth: authFor(mock),
      store,
    })) as Record<string, unknown>[];

    expect(items).toHaveLength(1);
    expect(mock.requests.at(-1)?.query.modified__gt).toEqual([
      "2026-09-01T00:00:00.000Z",
    ]);
  });
});
