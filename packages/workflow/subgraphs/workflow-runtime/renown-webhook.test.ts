// The Renown face of a webhook trigger: who is let in, what a refusal says,
// and that the path-token face is untouched by any of it.
import type { WebhookRequest } from "@powerhousedao/reactor-api";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { GroupMembers } from "./group-members.js";
import {
  decideRenownDelivery,
  MISS_TTL_MS,
  REFRESH_FLOOR_MS,
  RENOWN_WEBHOOK_PATH,
  RenownWebhookRoute,
  TOKEN_TTL_MS,
  type NodeRouteContext,
  type RenownAccess,
  type RenownWebhookPort,
} from "./renown-webhook.js";
import { parseWebhookConfig } from "./webhook.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";

const renown = (allowedAddresses: string[], methods?: string[]): RenownAccess =>
  ({ auth: "renown", allowedAddresses, methods }) as const;

const decide = (params: {
  access: RenownAccess;
  method?: string;
  address?: string;
  identityResolved?: boolean;
}) =>
  decideRenownDelivery({
    access: params.access,
    method: params.method ?? "POST",
    address: params.address,
    identityResolved: params.identityResolved ?? true,
  });

describe("decideRenownDelivery", () => {
  it("lets a verified signer on the list through", () => {
    expect(decide({ access: renown([ALICE]), address: ALICE })).toBeUndefined();
  });

  it("matches the list case-insensitively", () => {
    expect(
      decide({
        access: renown([ALICE]),
        address: ALICE.toUpperCase().replace("0X", "0x"),
      }),
    ).toBeUndefined();
  });

  it("refuses a verified signer who is not on the list with 403", () => {
    const refusal = decide({ access: renown([ALICE]), address: BOB });
    expect(refusal?.status).toBe(403);
    // The refusal says what to fix without naming anyone who is allowed.
    expect(refusal?.message).not.toContain(ALICE);
  });

  it("refuses an unverified caller with 401", () => {
    expect(decide({ access: renown([ALICE]) })?.status).toBe(401);
  });

  it("answers 503, not 401, on a host that resolves no identity", () => {
    // Nobody can fix this from the caller's side: the reactor verifies no
    // bearer at all, so the endpoint can admit nobody.
    const refusal = decide({
      access: renown([ALICE]),
      address: ALICE,
      identityResolved: false,
    });
    expect(refusal?.status).toBe(503);
    expect(refusal?.reason).toContain("resolveIdentity");
  });

  it("allows nobody when the list is empty", () => {
    expect(decide({ access: renown([]), address: ALICE })?.status).toBe(403);
  });

  it("answers a path-token or unarmed endpoint as an unknown one", () => {
    // A prober must not be able to tell a live Renown endpoint from a token
    // that was never minted, so both answer the same 404.
    expect(
      decide({
        access: { auth: "path", allowedAddresses: [], methods: undefined },
        address: ALICE,
      })?.status,
    ).toBe(404);
    expect(decide({ access: undefined, address: ALICE })?.status).toBe(404);
  });

  it("gates the identity before the method", () => {
    // Otherwise a caller holding only the token can tell an armed endpoint
    // from an unknown one, and enumerate the methods it accepts.
    expect(
      decide({ access: renown([ALICE], ["POST"]), method: "GET" })?.status,
    ).toBe(401);
    expect(
      decide({ access: renown([ALICE], ["POST"]), method: "GET", address: BOB })
        ?.status,
    ).toBe(403);
    expect(
      decide({
        access: renown([ALICE], ["POST"]),
        method: "GET",
        address: ALICE,
      })?.status,
    ).toBe(405);
  });
});

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function request(options: {
  method?: string;
  url?: string;
  body?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const stream = Readable.from([
    Buffer.from(options.body ?? "", "utf8"),
  ]) as unknown as IncomingMessage;
  stream.method = options.method ?? "POST";
  stream.url = options.url ?? "/webhooks/tok";
  stream.headers = options.headers ?? {};
  stream.destroy = () => stream;
  return stream;
}

function response(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    set statusCode(value: number) {
      captured.status = value;
    },
    get statusCode() {
      return captured.status;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    once() {
      return res;
    },
    end(body?: string) {
      captured.body = body ?? "";
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function ctx(
  params: Record<string, string>,
  address?: string,
): NodeRouteContext {
  return {
    params,
    user: address
      ? { address, chainId: 1, networkId: "eip155", appKey: "did:key:z" }
      : undefined,
    authEnabled: true,
    transport: {
      proto: "https",
      host: "host",
      prefix: "",
      baseUrl: "https://host",
    },
  };
}

function port(overrides: Partial<RenownWebhookPort> = {}): RenownWebhookPort {
  return {
    endpoints: () =>
      Promise.resolve({
        endpointFor: () =>
          Promise.resolve({ token: "tok", url: "u", createdAt: "now" }),
        revoke: () => Promise.resolve(),
        list: () =>
          Promise.resolve([
            { key: "workflow-1", token: "tok", url: "u", createdAt: "now" },
          ]),
      }),
    accessFor: () => Promise.resolve(renown([ALICE])),
    deliver: () => Promise.resolve({ status: 202 }),
    ...overrides,
  };
}

function scope() {
  const captured: { path?: string; auth?: string } = {};
  return {
    baseUrl: "https://host/api/workflow",
    nodeRoute: (spec: { path: string; auth: string }) => {
      captured.path = spec.path;
      captured.auth = spec.auth;
      return undefined;
    },
    captured,
  };
}

async function deliverTo(
  route: RenownWebhookRoute,
  options: {
    address?: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    token?: string;
  } = {},
): Promise<Captured> {
  const { res, captured } = response();
  await route.handle(
    request({
      method: options.method,
      body: options.body,
      headers: options.headers,
    }),
    res,
    ctx({ token: options.token ?? "tok" }, options.address),
  );
  return captured;
}

describe("RenownWebhookRoute", () => {
  it("registers one identity-resolving node route under its own scope", () => {
    const harness = scope();
    new RenownWebhookRoute(port()).register(harness);
    expect(harness.captured.path).toBe(RENOWN_WEBHOOK_PATH);
    // "renown-optional", not "renown": the allow-list is the trigger's policy,
    // and this face has to see a tokenless caller to answer it properly.
    expect(harness.captured.auth).toBe("renown-optional");
  });

  it("advertises no URL until the scope accepted the route", () => {
    const route = new RenownWebhookRoute(port());
    expect(route.registered).toBe(false);
    expect(route.urlFor("tok")).toBeUndefined();
    route.register(scope());
    expect(route.registered).toBe(true);
    expect(route.urlFor("tok")).toBe("https://host/api/workflow/webhooks/tok");
  });

  it("stays unregistered when the scope refuses the route", () => {
    // Latching on the attempt would leave both faces dead for the process's
    // life, with no retry and a URL the editor would still advertise.
    const route = new RenownWebhookRoute(port());
    expect(() =>
      route.register({
        baseUrl: "https://host/api/workflow",
        nodeRoute: () => {
          throw new Error("unroutable scope");
        },
      }),
    ).toThrow();
    expect(route.registered).toBe(false);
  });

  it("delivers for an allowed signer and answers with the trigger's status", async () => {
    const deliver = vi.fn((_request: WebhookRequest) =>
      Promise.resolve({ status: 202 }),
    );
    const route = new RenownWebhookRoute(port({ deliver }));
    const captured = await deliverTo(route, {
      address: ALICE,
      body: "{}",
      headers: {
        authorization: "Bearer jwt",
        "content-type": "application/json",
      },
    });
    expect(captured.status).toBe(202);
    const sent = deliver.mock.calls[0][0];
    expect(sent.key).toBe("workflow-1");
    // The bearer proved who is calling; it has no business reaching an
    // authored expression, so it is redacted exactly as the reactor does it.
    expect(sent.headers.authorization).not.toContain("jwt");
  });

  it("reads a body on every method, GET included", async () => {
    // The fetch scope buffers none for GET, which would hand the trigger an
    // empty payload where the reactor's own face hands it the bytes.
    const deliver = vi.fn((_request: WebhookRequest) =>
      Promise.resolve({ status: 202 }),
    );
    const route = new RenownWebhookRoute(port({ deliver }));
    await deliverTo(route, {
      address: ALICE,
      method: "GET",
      body: '{"id":"evt_1"}',
      headers: { "content-type": "application/json" },
    });
    expect(deliver.mock.calls[0][0].body).toEqual({ id: "evt_1" });
  });

  it("passes the query through and keeps the request's origin out of it", async () => {
    const deliver = vi.fn((_request: WebhookRequest) =>
      Promise.resolve({ status: 202 }),
    );
    const route = new RenownWebhookRoute(port({ deliver }));
    const { res, captured } = response();
    await route.handle(
      request({ url: "/webhooks/tok?source=github" }),
      res,
      ctx({ token: "tok" }, ALICE),
    );
    expect(captured.status).toBe(202);
    expect(deliver.mock.calls[0][0].queryParams).toEqual({ source: "github" });
    expect(deliver.mock.calls[0][0].path).toBe("/webhooks/tok");
  });

  it("refuses a signer who is not on the list without delivering", async () => {
    const deliver = vi.fn((_request: WebhookRequest) =>
      Promise.resolve({ status: 202 }),
    );
    const route = new RenownWebhookRoute(port({ deliver }));
    expect((await deliverTo(route, { address: BOB })).status).toBe(403);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses a caller whose bearer did not verify", async () => {
    expect((await deliverTo(new RenownWebhookRoute(port()))).status).toBe(401);
  });

  it("answers an unknown token as an unknown endpoint", async () => {
    const captured = await deliverTo(new RenownWebhookRoute(port()), {
      address: ALICE,
      token: "nope",
    });
    expect(captured.status).toBe(404);
  });

  it("reports a host that resolves no identity, once it has seen one", async () => {
    const route = new RenownWebhookRoute(port());
    expect(route.identityResolution).toBe("unknown");
    const { res } = response();
    await route.handle(request({}), res, {
      ...ctx({ token: "tok" }, ALICE),
      authEnabled: false,
    });
    expect(route.identityResolution).toBe("off");
  });
});

describe("signature verification on the Renown face", () => {
  const SECRET = "s3cret";
  const body = '{"id":"evt_1"}';
  const digest = createHmac("sha256", SECRET).update(body).digest("hex");
  const access: RenownAccess = {
    auth: "renown",
    allowedAddresses: [ALICE],
    methods: undefined,
    verify: { scheme: "hmac", header: "x-acme-token", secret: SECRET },
  };

  it("still verifies the author's signature for an allowed identity", async () => {
    // Choosing Renown must not quietly drop a control the author configured:
    // otherwise any allowed identity could forge a body.
    const deliver = vi.fn((_request: WebhookRequest) =>
      Promise.resolve({ status: 202 }),
    );
    const route = new RenownWebhookRoute(
      port({ deliver, accessFor: () => Promise.resolve(access) }),
    );
    expect(
      (
        await deliverTo(route, {
          address: ALICE,
          body,
          headers: { "x-acme-token": "wrong" },
        })
      ).status,
    ).toBe(401);
    expect(deliver).not.toHaveBeenCalled();

    expect(
      (
        await deliverTo(route, {
          address: ALICE,
          body,
          headers: { "x-acme-token": digest },
        })
      ).status,
    ).toBe(202);
  });

  it("redacts the author's own signature header from the payload", async () => {
    // A custom header is not in the reactor's redaction set, so the shared
    // secret would otherwise reach an authored expression.
    const deliver = vi.fn((_request: WebhookRequest) =>
      Promise.resolve({ status: 202 }),
    );
    const route = new RenownWebhookRoute(
      port({ deliver, accessFor: () => Promise.resolve(access) }),
    );
    await deliverTo(route, {
      address: ALICE,
      body,
      headers: { "x-acme-token": digest },
    });
    expect(deliver.mock.calls[0][0].headers["x-acme-token"]).not.toBe(digest);
  });
});

/** Lets the code under test reach its next await point, without a timer. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 100 && !condition(); tick += 1) {
    await Promise.resolve();
  }
}

describe("the token index", () => {
  function listing(rows: { key: string; token: string }[]) {
    return vi.fn(() =>
      Promise.resolve(
        rows.map((row) => ({ ...row, url: "u", createdAt: "now" })),
      ),
    );
  }

  function routeWith(list: () => Promise<unknown[]>, now: () => number) {
    return new RenownWebhookRoute(
      port({
        endpoints: () =>
          Promise.resolve({
            endpointFor: () =>
              Promise.resolve({ token: "tok", url: "u", createdAt: "now" }),
            revoke: () => Promise.resolve(),
            list,
          } as never),
      }),
      now,
    );
  }

  it("re-reads for a token minted since the last listing", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { key: "workflow-1", token: "tok", url: "u", createdAt: "now" },
      ]);
    let clock = 0;
    const route = routeWith(list as never, () => clock);
    expect((await deliverTo(route, { address: ALICE })).status).toBe(404);
    clock = MISS_TTL_MS + 1;
    expect((await deliverTo(route, { address: ALICE })).status).toBe(202);
  });

  it("does not answer a fresh call from a listing that predates it", async () => {
    // A miss on a refresh we merely joined may come from a listing older than
    // the token; it is retried against a listing of our own.
    const pending: ((rows: unknown[]) => void)[] = [];
    const list = vi.fn(
      () => new Promise<unknown[]>((resolve) => pending.push(resolve)),
    );
    let clock = 0;
    const route = routeWith(list as never, () => clock);

    const first = deliverTo(route, { address: ALICE });
    await waitFor(() => pending.length === 1);

    // Minted after that listing began, and asked for after it too.
    clock = 1;
    const second = deliverTo(route, { address: ALICE });
    pending[0]([]);
    expect((await first).status).toBe(404);

    await waitFor(() => pending.length === 2);
    pending[1]([{ key: "workflow-1", token: "tok", url: "u", createdAt: "n" }]);
    expect((await second).status).toBe(202);
  });

  it("does not list the store again for a token it just missed", async () => {
    // An unauthenticated route: a stream of invented tokens must not become a
    // store-wide listing per request.
    const list = listing([]);
    let clock = 0;
    const route = routeWith(list as never, () => clock);
    await deliverTo(route, { address: ALICE, token: "ghost" });
    await deliverTo(route, { address: ALICE, token: "ghost" });
    expect(list).toHaveBeenCalledTimes(1);

    clock = MISS_TTL_MS + 1;
    await deliverTo(route, { address: ALICE, token: "ghost" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not list the store once per invented token", async () => {
    // The miss table only stops one token repeating. A caller sending a fresh
    // token each time would otherwise buy a store-wide listing per request.
    const list = listing([]);
    let clock = 0;
    const route = routeWith(list as never, () => clock);
    for (let i = 0; i < 20; i++) {
      clock = i;
      await deliverTo(route, { address: ALICE, token: `ghost-${i}` });
    }
    expect(list).toHaveBeenCalledTimes(1);

    // The floor is a delay, not a refusal: a token minted meanwhile resolves.
    clock = REFRESH_FLOOR_MS + 1;
    await deliverTo(route, { address: ALICE, token: "ghost-fresh" });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("stops resolving a token the store no longer holds", async () => {
    // A revoked or rotated token must not keep working for the life of the
    // process because it was cached once.
    const rows = [{ key: "workflow-1", token: "tok" }];
    const list = vi.fn(() =>
      Promise.resolve(
        rows.map((row) => ({ ...row, url: "u", createdAt: "n" })),
      ),
    );
    let clock = 0;
    const route = routeWith(list as never, () => clock);
    expect((await deliverTo(route, { address: ALICE })).status).toBe(202);

    rows.pop();
    clock = TOKEN_TTL_MS + 1;
    expect((await deliverTo(route, { address: ALICE })).status).toBe(404);
  });
});

describe("groups at the delivery path", () => {
  // The route sees one resolved list; the service unions the trigger's
  // addresses with its groups' members before handing it over.
  function routeOver(groups: GroupMembers, allowedAddresses: string[]) {
    return new RenownWebhookRoute(
      port({
        accessFor: async () => ({
          auth: "renown",
          methods: undefined,
          allowedAddresses: [
            ...allowedAddresses,
            ...(await groups.resolve(["eng"])).members,
          ],
        }),
      }),
    );
  }

  function membersOf(initial: Record<string, string[]>) {
    const groups = new Map(Object.entries(initial));
    return {
      groups,
      members: new GroupMembers((ids) =>
        Promise.resolve(
          ids
            .filter((id) => groups.has(id))
            .map((id) => ({ id, members: groups.get(id) ?? [] })),
        ),
      ),
    };
  }

  it("lets an address and a group member both through", async () => {
    const { members } = membersOf({ eng: [CAROL] });
    const route = routeOver(members, [ALICE]);
    expect((await deliverTo(route, { address: ALICE })).status).toBe(202);
    expect((await deliverTo(route, { address: CAROL })).status).toBe(202);
    expect((await deliverTo(route, { address: BOB })).status).toBe(403);
  });

  it("refuses a member dropped from the group, with no workflow re-saved", async () => {
    const { groups, members } = membersOf({ eng: [CAROL] });
    const route = routeOver(members, []);
    expect((await deliverTo(route, { address: CAROL })).status).toBe(202);

    groups.set("eng", []);
    members.invalidate("eng");

    expect((await deliverTo(route, { address: CAROL })).status).toBe(403);
  });

  it("refuses everyone once the only group named is deleted", async () => {
    const { groups, members } = membersOf({ eng: [CAROL] });
    const route = routeOver(members, []);
    expect((await deliverTo(route, { address: CAROL })).status).toBe(202);

    groups.delete("eng");
    members.invalidate("eng");

    expect((await deliverTo(route, { address: CAROL })).status).toBe(403);
  });
});

describe("the allow-list through the document's trigger config", () => {
  it("round-trips addresses lowercased and de-duplicated", () => {
    const config = parseWebhookConfig({
      auth: "renown",
      allowedAddresses: [ALICE.toUpperCase().replace("0X", "0x"), ALICE, BOB],
    });
    expect(config.auth).toBe("renown");
    expect(config.allowedAddresses).toEqual([ALICE, BOB]);
  });

  it("round-trips group references as given", () => {
    const config = parseWebhookConfig({
      auth: "renown",
      allowedGroups: ["group-1", "group-1", "group-2"],
    });
    expect(config.allowedGroups).toEqual(["group-1", "group-2"]);
  });

  it("defaults to the path token, so an existing trigger is unchanged", () => {
    const config = parseWebhookConfig({ scheme: "none" });
    expect(config.auth).toBe("path");
    expect(config.allowedAddresses).toEqual([]);
    expect(config.allowedGroups).toEqual([]);
  });

  it("rejects something that is not an address rather than dropping it", () => {
    // A silently discarded entry reads, in the editor, as access that was
    // never granted; the trigger refuses to arm instead.
    expect(() =>
      parseWebhookConfig({ auth: "renown", allowedAddresses: ["alice.eth"] }),
    ).toThrow(/not a 0x-prefixed/);
  });

  it("rejects an unknown auth method", () => {
    expect(() => parseWebhookConfig({ auth: "basic" })).toThrow(/"auth"/);
  });

  it("refuses Renown with a handshake or a dedupe field", () => {
    // Neither is applied on this face, and dropping them in silence breaks
    // provider registration and double-fires every redelivery.
    expect(() =>
      parseWebhookConfig({ auth: "renown", challengeField: "challenge" }),
    ).toThrow(/challengeField/);
    expect(() =>
      parseWebhookConfig({ auth: "renown", dedupeField: "id" }),
    ).toThrow(/dedupeField/);
    expect(() =>
      parseWebhookConfig({ auth: "path", dedupeField: "id" }),
    ).not.toThrow();
  });
});
