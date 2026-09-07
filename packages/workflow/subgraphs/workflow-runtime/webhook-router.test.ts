import type { BaseSubgraph } from "@powerhousedao/reactor-api";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountWebhookRoutes,
  resetWebhookRoutes,
  type WebhookRequest,
} from "./webhook-router.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

// Only the handles the router reaches for; everything else is unused here.
const fakeSubgraph = (manager: Record<string, unknown>) =>
  ({ graphqlManager: manager }) as unknown as BaseSubgraph;

interface Harness {
  server: Server;
  base: string;
  downstream: ReturnType<typeof vi.fn>;
}

const started: Server[] = [];

async function startHarness(): Promise<Harness> {
  const downstream = vi.fn(
    (_req: IncomingMessage, res: ServerResponse): void => {
      res.statusCode = 200;
      res.end("downstream");
    },
  );
  const server = createServer(downstream);
  started.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}`, downstream };
}

afterEach(async () => {
  resetWebhookRoutes();
  delete process.env.WORKFLOW_WEBHOOK_MAX_BODY_BYTES;
  while (started.length > 0) {
    const server = started.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("server transport", () => {
  it("answers the endpoint with byte-exact bodies and leaves other paths alone", async () => {
    const harness = await startHarness();
    const seen: WebhookRequest[] = [];
    const mount = mountWebhookRoutes(
      fakeSubgraph({ httpServer: harness.server, port: 4001 }),
      (request) => {
        seen.push(request);
        return Promise.resolve({ status: 202 });
      },
    );
    expect(mount).toEqual({
      transport: "server",
      baseUrl: "http://localhost:4001",
      rawExact: true,
    });

    // Whitespace a re-encode would drop is what a signature is computed over.
    const body = '{ "id" :  "evt_1" }';
    const response = await fetch(
      `${harness.base}/workflows/hooks/${TOKEN}?source=github`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "X-Custom": "kept" },
        body,
      },
    );

    expect(response.status).toBe(202);
    expect(harness.downstream).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0].token).toBe(TOKEN);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].path).toBe(`/workflows/hooks/${TOKEN}`);
    expect(seen[0].queryParams).toEqual({ source: "github" });
    expect(seen[0].headers["x-custom"]).toBe("kept");
    expect(seen[0].rawExact).toBe(true);
    expect(seen[0].raw.toString("utf8")).toBe(body);

    const passthrough = await fetch(`${harness.base}/graphql`);
    expect(await passthrough.text()).toBe("downstream");
    expect(harness.downstream).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed token without consulting the handler", async () => {
    const harness = await startHarness();
    const deliver = vi.fn(() => Promise.resolve({ status: 202 }));
    mountWebhookRoutes(fakeSubgraph({ httpServer: harness.server }), deliver);

    const response = await fetch(`${harness.base}/workflows/hooks/nope`, {
      method: "POST",
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
    expect(deliver).not.toHaveBeenCalled();
    expect(harness.downstream).not.toHaveBeenCalled();
  });

  it("cuts an oversized body off rather than buffering it", async () => {
    process.env.WORKFLOW_WEBHOOK_MAX_BODY_BYTES = "16";
    const harness = await startHarness();
    const deliver = vi.fn(() => Promise.resolve({ status: 202 }));
    mountWebhookRoutes(fakeSubgraph({ httpServer: harness.server }), deliver);

    const response = await fetch(`${harness.base}/workflows/hooks/${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(64) }),
    }).catch(() => undefined);

    // The socket is destroyed, so a 413 or a transport error both count.
    expect(response === undefined || response.status === 413).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("returns the handler's body and status", async () => {
    const harness = await startHarness();
    mountWebhookRoutes(fakeSubgraph({ httpServer: harness.server }), () =>
      Promise.resolve({
        status: 200,
        body: "challenge-value",
        contentType: "text/plain; charset=utf-8",
      }),
    );

    const response = await fetch(`${harness.base}/workflows/hooks/${TOKEN}`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await response.text()).toBe("challenge-value");
  });

  it("answers 500 when the handler throws", async () => {
    const harness = await startHarness();
    mountWebhookRoutes(fakeSubgraph({ httpServer: harness.server }), () =>
      Promise.reject(new Error("boom")),
    );

    const response = await fetch(`${harness.base}/workflows/hooks/${TOKEN}`, {
      method: "POST",
    });
    expect(response.status).toBe(500);
  });

  it("wraps once and swaps the handler on a second mount", async () => {
    const harness = await startHarness();
    const first = vi.fn(() => Promise.resolve({ status: 202 }));
    const second = vi.fn(() => Promise.resolve({ status: 204 }));
    mountWebhookRoutes(fakeSubgraph({ httpServer: harness.server }), first);
    mountWebhookRoutes(fakeSubgraph({ httpServer: harness.server }), second);

    const response = await fetch(`${harness.base}/workflows/hooks/${TOKEN}`, {
      method: "POST",
    });
    expect(response.status).toBe(204);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("fallbacks", () => {
  it("uses the adapter when no server handle is reachable, without raw bytes", () => {
    const mountNodeRoute = vi.fn();
    const mount = mountWebhookRoutes(
      fakeSubgraph({ httpAdapter: { mountNodeRoute }, port: 4001 }),
      () => Promise.resolve({ status: 202 }),
    );
    expect(mount.transport).toBe("adapter");
    expect(mount.rawExact).toBe(false);
    expect(mountNodeRoute).toHaveBeenCalledTimes(5);
    expect(mountNodeRoute.mock.calls[0][1]).toBe("/workflows/hooks/:token");
  });

  it("reports no transport when neither handle is present", () => {
    const mount = mountWebhookRoutes(fakeSubgraph({}), () =>
      Promise.resolve({ status: 202 }),
    );
    expect(mount.transport).toBe("none");
  });
});
