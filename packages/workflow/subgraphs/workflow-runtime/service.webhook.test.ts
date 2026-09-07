// Delivery path for core#webhook: token lookup, verification, dedup and the
// two response modes. The HTTP transport itself is covered by webhook-router.
import type { OperationWithContext } from "document-model";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRuntimeService } from "./service.js";
import type { WebhookEndpointRow, WorkflowRunStore } from "./store.js";
import type { WebhookRequest } from "./webhook-router.js";

const WORKFLOW_TYPE = "powerhouse/workflow";
const WORKFLOW = "wf-hook";
const TOKEN = "0123456789abcdef0123456789abcdef";
const SECRET_REF = "secret://v1:00112233445566778899aabbccddeeff";
const SECRET = "s3cret";

let ordinal = 0;

function workflowOp(state: Record<string, unknown>): OperationWithContext {
  ordinal += 1;
  return {
    operation: {
      index: ordinal,
      timestampUtcMs: `${ordinal}`,
      action: { type: "SET_WORKFLOW_NAME", input: {} },
      resultingState: JSON.stringify(state),
    },
    context: {
      documentId: WORKFLOW,
      documentType: WORKFLOW_TYPE,
      scope: "global",
      branch: "main",
      ordinal,
    },
  } as unknown as OperationWithContext;
}

const request = (overrides: Partial<WebhookRequest> = {}): WebhookRequest => ({
  token: TOKEN,
  method: "POST",
  path: `/workflows/hooks/${TOKEN}`,
  queryParams: {},
  headers: { "content-type": "application/json" },
  raw: Buffer.from('{"id":"evt_1"}', "utf8"),
  rawExact: true,
  ...overrides,
});

describe("WorkflowRuntimeService.deliverWebhook", () => {
  let service: WorkflowRuntimeService;
  let fired: { workflowId: string; payload: unknown; kind: string }[];
  let claimed: Set<string>;
  let endpoints: Map<string, WebhookEndpointRow>;

  function useStore(): void {
    endpoints = new Map([
      [
        TOKEN,
        {
          token: TOKEN,
          workflow_id: WORKFLOW,
          block_type: "core#webhook",
          created_at: "2026-09-07T00:00:00.000Z",
        },
      ],
    ]);
    claimed = new Set();
    const store = {
      getWebhookEndpoint: (token: string) =>
        Promise.resolve(endpoints.get(token)),
      getWebhookEndpointForWorkflow: (workflowId: string) =>
        Promise.resolve(
          [...endpoints.values()].find((row) => row.workflow_id === workflowId),
        ),
      ensureWebhookEndpoint: (workflowId: string) =>
        Promise.resolve(
          [...endpoints.values()].find(
            (row) => row.workflow_id === workflowId,
          )!,
        ),
      claimDedupe: (workflowId: string, key: string) => {
        const composite = `${workflowId}:${key}`;
        if (claimed.has(composite)) return Promise.resolve(false);
        claimed.add(composite);
        return Promise.resolve(true);
      },
    };
    (service as unknown as { storePromise: unknown }).storePromise =
      Promise.resolve(store as unknown as WorkflowRunStore);
  }

  async function arm(config: Record<string, unknown>): Promise<void> {
    await service.onOperations([
      workflowOp({
        name: "Hook",
        status: "ENABLED",
        version: 1,
        trigger: { id: "t1", blockType: "core#webhook", config },
        steps: [],
        edges: [],
        variables: [],
      }),
    ]);
    fired.length = 0;
  }

  async function disarm(): Promise<void> {
    await service.onOperations([
      workflowOp({
        name: "Hook",
        status: "DISABLED",
        version: 2,
        trigger: { id: "t1", blockType: "core#webhook", config: {} },
        steps: [],
        edges: [],
        variables: [],
      }),
    ]);
  }

  beforeEach(() => {
    service = new WorkflowRuntimeService();
    fired = [];
    (service as unknown as { subgraph: unknown }).subgraph = {
      reactorClient: { get: () => Promise.reject(new Error("not used")) },
    };
    (service as unknown as { secretsPromise: unknown }).secretsPromise =
      Promise.resolve({
        get: (ref: string) =>
          ref === SECRET_REF
            ? Promise.resolve(SECRET)
            : Promise.reject(new Error(`No secret found for ref "${ref}"`)),
      });
    vi.spyOn(service, "fire").mockImplementation(
      (workflowId: string, payload?: unknown, kind = "manual") => {
        fired.push({ workflowId, payload, kind });
        return Promise.resolve({
          runId: "run-1",
          status: "SUCCEEDED",
          steps: [],
        } as never);
      },
    );
    useStore();
  });

  it("accepts an unsigned delivery and fires with the request payload", async () => {
    await arm({});
    const reply = await service.deliverWebhook(
      request({ queryParams: { source: "github" } }),
    );

    expect(reply).toEqual({ status: 202 });
    expect(fired).toEqual([
      {
        workflowId: WORKFLOW,
        kind: "webhook",
        payload: {
          method: "POST",
          path: `/workflows/hooks/${TOKEN}`,
          headers: { "content-type": "application/json" },
          queryParams: { source: "github" },
          body: { id: "evt_1" },
        },
      },
    ]);
  });

  it("answers a bare 401 for an unknown token", async () => {
    await arm({});
    const reply = await service.deliverWebhook(
      request({ token: "f".repeat(32) }),
    );
    expect(reply).toEqual({ status: 401 });
    expect(fired).toHaveLength(0);
  });

  it("answers the same 401 once the workflow is disabled", async () => {
    await arm({});
    await disarm();
    expect(await service.deliverWebhook(request())).toEqual({ status: 401 });
    expect(fired).toHaveLength(0);
  });

  it("refuses a workflow whose webhook config does not parse", async () => {
    await arm({ scheme: "github" });
    expect(await service.deliverWebhook(request())).toEqual({ status: 401 });
    expect(fired).toHaveLength(0);
  });

  it("rejects a method the trigger does not accept", async () => {
    await arm({ methods: "POST" });
    const reply = await service.deliverWebhook(request({ method: "GET" }));
    expect(reply).toEqual({ status: 405 });
    expect(fired).toHaveLength(0);
  });

  describe("signed endpoints", () => {
    const body = '{"id":"evt_1"}';
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");

    it("fires on a matching HMAC and redacts the signature header", async () => {
      await arm({ scheme: "hmac-sha256", secretRef: SECRET_REF });
      const reply = await service.deliverWebhook(
        request({
          headers: {
            "content-type": "application/json",
            "x-signature": signature,
          },
        }),
      );

      expect(reply).toEqual({ status: 202 });
      expect(fired).toHaveLength(1);
      const payload = fired[0].payload as { headers: Record<string, string> };
      expect(payload.headers["x-signature"]).toBe("[redacted]");
    });

    it("rejects a body that no longer matches its signature", async () => {
      await arm({ scheme: "hmac-sha256", secretRef: SECRET_REF });
      const reply = await service.deliverWebhook(
        request({
          headers: {
            "content-type": "application/json",
            "x-signature": signature,
          },
          raw: Buffer.from('{"id":"evt_2"}', "utf8"),
        }),
      );
      expect(reply).toEqual({ status: 401 });
      expect(fired).toHaveLength(0);
    });

    it("rejects when the secret has been deleted", async () => {
      await arm({
        scheme: "hmac-sha256",
        secretRef: "secret://v1:ffffffffffffffffffffffffffffffff",
      });
      const reply = await service.deliverWebhook(
        request({
          headers: {
            "content-type": "application/json",
            "x-signature": signature,
          },
        }),
      );
      expect(reply).toEqual({ status: 401 });
      expect(fired).toHaveLength(0);
    });

    it("refuses rather than verify a re-encoded body", async () => {
      await arm({ scheme: "hmac-sha256", secretRef: SECRET_REF });
      const reply = await service.deliverWebhook(
        request({
          headers: {
            "content-type": "application/json",
            "x-signature": signature,
          },
          rawExact: false,
        }),
      );
      expect(reply).toEqual({ status: 503 });
      expect(fired).toHaveLength(0);
    });
  });

  it("echoes a challenge instead of starting a run", async () => {
    await arm({ challengeField: "challenge" });
    const reply = await service.deliverWebhook(
      request({ raw: Buffer.from('{"challenge":"abc"}', "utf8") }),
    );
    expect(reply).toEqual({
      status: 200,
      body: "abc",
      contentType: "text/plain; charset=utf-8",
    });
    expect(fired).toHaveLength(0);
  });

  it("accepts a redelivery once and answers the second as success", async () => {
    await arm({ dedupeField: "id" });
    expect(await service.deliverWebhook(request())).toEqual({ status: 202 });
    expect(await service.deliverWebhook(request())).toEqual({ status: 202 });
    expect(fired).toHaveLength(1);
  });

  it("still fires twice when no event-id field is configured", async () => {
    await arm({});
    await service.deliverWebhook(request());
    await service.deliverWebhook(request());
    expect(fired).toHaveLength(2);
  });

  describe("sync mode", () => {
    it("reports the run outcome in the body", async () => {
      await arm({ responseMode: "sync" });
      const reply = await service.deliverWebhook(request());
      expect(reply.status).toBe(200);
      expect(JSON.parse(reply.body!)).toEqual({
        runId: "run-1",
        status: "SUCCEEDED",
        error: null,
      });
    });

    it("answers 500 for a failed run", async () => {
      await arm({ responseMode: "sync" });
      vi.spyOn(service, "fire").mockResolvedValue({
        runId: "run-2",
        status: "FAILED",
        error: "step blew up",
        steps: [],
      } as never);
      const reply = await service.deliverWebhook(request());
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.body!)).toEqual({
        runId: "run-2",
        status: "FAILED",
        error: "step blew up",
      });
    });

    it("answers 500 when the run throws", async () => {
      await arm({ responseMode: "sync" });
      vi.spyOn(service, "fire").mockRejectedValue(new Error("no such step"));
      const reply = await service.deliverWebhook(request());
      expect(reply.status).toBe(500);
      expect(JSON.parse(reply.body!)).toEqual({ error: "no such step" });
    });
  });

  it("rate limits a flood on one token", async () => {
    await arm({});
    const limiter = (
      service as unknown as { webhookLimiter: { allow: () => boolean } }
    ).webhookLimiter;
    vi.spyOn(limiter, "allow").mockReturnValue(false);
    expect(await service.deliverWebhook(request())).toEqual({ status: 429 });
    expect(fired).toHaveLength(0);
  });
});

describe("piece WEBHOOK-strategy triggers", () => {
  const PIECE_BLOCK = "@acme/piece-x@1.0.0#trigger:new_thing";
  let service: WorkflowRuntimeService;
  let endpoints: Map<string, WebhookEndpointRow>;
  let upserted: unknown[];
  let delivered: { payload: unknown }[];

  function armPiece(): Promise<void> {
    return service.onOperations([
      workflowOp({
        name: "Piece hook",
        status: "ENABLED",
        version: 1,
        trigger: { id: "t1", blockType: PIECE_BLOCK, config: {} },
        steps: [],
        edges: [],
        variables: [],
      }),
    ]);
  }

  beforeEach(() => {
    service = new WorkflowRuntimeService();
    endpoints = new Map();
    upserted = [];
    delivered = [];
    (service as unknown as { subgraph: unknown }).subgraph = {
      reactorClient: { get: () => Promise.reject(new Error("not used")) },
    };
    (service as unknown as { storePromise: unknown }).storePromise =
      Promise.resolve({
        getWebhookEndpoint: (token: string) =>
          Promise.resolve(endpoints.get(token)),
        getWebhookEndpointForWorkflow: (workflowId: string) =>
          Promise.resolve(
            [...endpoints.values()].find(
              (row) => row.workflow_id === workflowId,
            ),
          ),
        ensureWebhookEndpoint: (
          workflowId: string,
          blockType: string,
          mint: () => string,
        ) => {
          const existing = [...endpoints.values()].find(
            (row) => row.workflow_id === workflowId,
          );
          if (existing) return Promise.resolve(existing);
          const created: WebhookEndpointRow = {
            token: mint(),
            workflow_id: workflowId,
            block_type: blockType,
            created_at: "2026-09-07T00:00:00.000Z",
          };
          endpoints.set(created.token, created);
          return Promise.resolve(created);
        },
      } as unknown as WorkflowRunStore);
    // The strategy lookup is the piece catalog, not the network.
    vi.spyOn(
      service as unknown as {
        pieceDelivery: () => Promise<"poll" | "webhook">;
      },
      "pieceDelivery",
    ).mockResolvedValue("webhook");
    const supervisor = service.supervisor();
    vi.spyOn(supervisor, "upsert").mockImplementation((binding) => {
      upserted.push(binding);
      return Promise.resolve();
    });
    vi.spyOn(supervisor, "deliver").mockImplementation((_binding, payload) => {
      delivered.push({ payload });
      return Promise.resolve(1);
    });
  });

  it("mints the endpoint before arming, so onEnable can register it", async () => {
    await armPiece();
    // Ordering matters: the piece registers this URL from inside onEnable.
    expect([...endpoints.values()]).toHaveLength(1);
    expect([...endpoints.values()][0].block_type).toBe(PIECE_BLOCK);
    expect(upserted).toEqual([
      expect.objectContaining({ blockType: PIECE_BLOCK, delivery: "webhook" }),
    ]);
  });

  it("reports the endpoint as armed for the piece's block type", async () => {
    await armPiece();
    const endpoint = await service.webhookEndpoint(WORKFLOW);
    expect(endpoint?.armed).toBe(true);
    expect(endpoint?.url).toContain([...endpoints.keys()][0]);
  });

  it("hands an inbound request to the piece instead of firing directly", async () => {
    await armPiece();
    const token = [...endpoints.keys()][0];
    const reply = await service.deliverWebhook(
      request({ token, path: `/workflows/hooks/${token}` }),
    );

    // Answered before the piece runs, as Activepieces does.
    expect(reply).toEqual({ status: 200 });
    expect(delivered).toEqual([
      {
        payload: {
          method: "POST",
          path: `/workflows/hooks/${token}`,
          headers: { "content-type": "application/json" },
          queryParams: {},
          body: { id: "evt_1" },
        },
      },
    ]);
  });

  it("does not require raw bytes: the piece owns verification", async () => {
    await armPiece();
    const token = [...endpoints.keys()][0];
    const reply = await service.deliverWebhook(
      request({ token, path: `/workflows/hooks/${token}`, rawExact: false }),
    );
    expect(reply).toEqual({ status: 200 });
    expect(delivered).toHaveLength(1);
  });
});

describe("WorkflowRuntimeService.webhookEndpoint", () => {
  it("reports the URL, its transport and whether it is armed", async () => {
    const service = new WorkflowRuntimeService();
    const row: WebhookEndpointRow = {
      token: TOKEN,
      workflow_id: WORKFLOW,
      block_type: "core#webhook",
      created_at: "2026-09-07T00:00:00.000Z",
    };
    (service as unknown as { storePromise: unknown }).storePromise =
      Promise.resolve({
        getWebhookEndpointForWorkflow: () => Promise.resolve(row),
        ensureWebhookEndpoint: () => Promise.resolve(row),
      } as unknown as WorkflowRunStore);
    (service as unknown as { webhookMount: unknown }).webhookMount = {
      transport: "server",
      baseUrl: "https://hooks.example.com",
      rawExact: true,
    };

    expect(await service.webhookEndpoint(WORKFLOW)).toEqual({
      workflowId: WORKFLOW,
      url: `https://hooks.example.com/workflows/hooks/${TOKEN}`,
      transport: "server",
      rawBodyVerification: true,
      // No registration was seeded, so nothing is accepting deliveries.
      armed: false,
      createdAt: "2026-09-07T00:00:00.000Z",
    });
  });
});
