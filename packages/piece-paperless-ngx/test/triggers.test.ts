import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWebhookParams,
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
  it("interpolates doc_id and nothing else", () => {
    const params = buildWebhookParams("DOCUMENT_ADDED");
    const rendered = JSON.stringify(params);
    const placeholders = rendered.match(/\{\{/g) ?? [];

    expect(params.doc_id).toBe("{{doc_id}}");
    expect(params.event).toBe("DOCUMENT_ADDED");
    expect(placeholders).toHaveLength(1);
    // Every known paperless placeholder renders as a raw string, so any of
    // these would let a document title break the JSON body.
    for (const unsafe of ["doc_title", "correspondent", "filename", "doc_url"]) {
      expect(rendered).not.toContain(unsafe);
    }
  });

  it("carries no GraphQL, since the endpoint is a plain webhook", () => {
    const rendered = JSON.stringify(buildWebhookParams("DOCUMENT_ADDED"));
    expect(rendered).not.toContain("mutation");
    expect(rendered).not.toContain("fireWebhook");
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
    expect(webhook.params).toEqual({
      doc_id: "{{doc_id}}",
      event: "DOCUMENT_ADDED",
    });

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

  it("re-creates a registration whose workflow was deleted in paperless", async () => {
    const store = new MemoryStore();
    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
      store,
    });
    const first = registeredWorkflow();

    // Someone removed it in the paperless UI. The PATCH then 404s, and because
    // onEnable's throw leaves the stale registration in the store, every retry
    // used to PATCH the same dead id with no path back to a create.
    mock.workflows.delete(first.id);

    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
      store,
    });

    expect(mock.workflows.size).toBe(1);
    const recreated = registeredWorkflow();
    expect(recreated.id).not.toBe(first.id);
    expect(webhookOf(recreated).headers).toEqual({
      "X-Powerhouse-Webhook-Token": "tok-abc",
    });
  });

  it("names the paperless workflow without leaking the delivery token", async () => {
    await runHook(newDocument, "onEnable", {
      auth: authFor(mock),
      webhookUrl: WEBHOOK_URL,
      store: new MemoryStore(),
    });
    // The name used to carry the last 8 characters of `${endpoint}#${token}`,
    // i.e. of the raw credential, into a field the paperless UI displays.
    const name = String(registeredWorkflow().name);
    expect(name).not.toContain("tok-abc");
    expect(name).not.toContain("ok-abc");
    expect(name).toMatch(/^Powerhouse: document_added \([0-9a-f]{8}\)$/);
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

  it("advances the cursor by instant when the server answers with an offset", async () => {
    // DRF renders datetimes in the server's TIME_ZONE, so a paperless off UTC
    // answers "…-05:00" while the seeded cursor is a "Z" string. Compared
    // lexically that offset form sorts *below* the cursor, so the cursor never
    // advanced and every sweep re-emitted the same rows forever.
    const store = new MemoryStore();
    // 04:00-05:00 is 09:00Z — later than the cursor as an instant, but lower
    // than it as a string, which is what made the old compare stick.
    await store.put("paperless:sweep-cursor", "2026-09-02T08:30:00.000Z");
    const added = "2026-09-02T04:00:00-05:00";
    const cursor = String(store.entries.get("paperless:sweep-cursor"));
    const later = mock.seedDocument({ added });
    expect(added > cursor).toBe(false);
    expect(Date.parse(added) > Date.parse(cursor)).toBe(true);

    const items = (await runHook(newDocument, "run", {
      auth: authFor(mock),
      store,
    })) as Record<string, unknown>[];
    expect(items.map((item) => item.id)).toEqual([later.id]);
    expect(store.entries.get("paperless:sweep-cursor")).toBe(
      "2026-09-02T04:00:00-05:00",
    );

    // And having advanced, the next sweep is quiet rather than re-emitting.
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
