// What is left of the webhook path once the reactor's webhook service owns the
// transport: the policy this service hands over for one workflow, and what a
// verified delivery means. Token lookup, signature schemes, dedupe, the
// challenge round, redaction and rate limiting are covered by reactor-api.
import type { WebhookRequest } from "@powerhousedao/reactor-api";
import type { OperationWithContext } from "document-model";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRuntimeService } from "./service.js";

const WORKFLOW_TYPE = "powerhouse/workflow";
const WORKFLOW = "wf-hook";
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
  key: WORKFLOW,
  method: "POST",
  path: "/webhooks/0123456789abcdef0123456789abcdef",
  queryParams: {},
  headers: { "content-type": "application/json" },
  raw: Buffer.from('{"id":"evt_1"}', "utf8"),
  body: { id: "evt_1" },
  ...overrides,
});

describe("WorkflowRuntimeService webhooks", () => {
  let service: WorkflowRuntimeService;
  let fired: { workflowId: string; payload: unknown; kind: string }[];

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

  const policy = () =>
    (
      service as unknown as {
        webhookPolicy: (id: string) => Promise<unknown>;
      }
    ).webhookPolicy(WORKFLOW);

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
  });

  // ── the policy handed to the webhook service ─────────────────────────────

  describe("policy", () => {
    it("is absent for a workflow that is not armed", async () => {
      // The service answers this exactly as it answers an unknown token, so a
      // prober cannot tell a disabled workflow from one that never existed.
      expect(await policy()).toBeUndefined();
      await arm({});
      expect(await policy()).toBeDefined();
      await disarm();
      expect(await policy()).toBeUndefined();
    });

    it("is absent when the trigger config does not parse", async () => {
      // A signed scheme with no secret ref cannot be honoured, so the endpoint
      // must not be armed at all.
      await arm({ scheme: "github" });
      expect(await policy()).toBeUndefined();
    });

    it("declares no verification for an unsigned endpoint", async () => {
      await arm({});
      expect(await policy()).toMatchObject({ verify: undefined });
    });

    it("resolves the signing secret through the secret store", async () => {
      await arm({ scheme: "hmac-sha256", secretRef: SECRET_REF });
      expect(await policy()).toMatchObject({
        verify: {
          scheme: "hmac-sha256",
          header: "x-signature",
          secret: SECRET,
        },
      });
    });

    it("declares a deleted secret as absent rather than failing", async () => {
      // The webhook service refuses a signed endpoint with no secret, which is
      // the same answer as a bad signature.
      await arm({
        scheme: "hmac-sha256",
        secretRef: "secret://v1:ffffffffffffffffffffffffffffffff",
      });
      expect(await policy()).toMatchObject({
        verify: { scheme: "hmac-sha256", secret: undefined },
      });
    });

    it("passes the author's methods, dedupe field and challenge field", async () => {
      await arm({
        methods: "POST",
        dedupeField: "id",
        dedupeTtlSeconds: 60,
        challengeField: "challenge",
      });
      expect(await policy()).toMatchObject({
        methods: ["POST"],
        dedupe: { field: "id", ttlSeconds: 60 },
        challengeField: "challenge",
      });
    });

    it("declares no dedupe when the author named no field", async () => {
      await arm({});
      expect(await policy()).toMatchObject({ dedupe: undefined });
    });
  });

  // ── what a verified delivery means ───────────────────────────────────────

  describe("delivery", () => {
    it("fires with the request as the trigger payload", async () => {
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
            path: "/webhooks/0123456789abcdef0123456789abcdef",
            headers: { "content-type": "application/json" },
            queryParams: { source: "github" },
            body: { id: "evt_1" },
          },
        },
      ]);
    });

    it("refuses a delivery for a workflow that is no longer armed", async () => {
      await arm({});
      await disarm();
      expect(await service.deliverWebhook(request())).toEqual({ status: 401 });
      expect(fired).toHaveLength(0);
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

    it("answers async mode before the run finishes", async () => {
      await arm({ responseMode: "async", responseStatus: 204 });
      const reply = await service.deliverWebhook(request());
      expect(reply).toEqual({ status: 204 });
    });
  });
});
