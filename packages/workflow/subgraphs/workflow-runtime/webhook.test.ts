import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildWebhookPayload,
  challengeResponse,
  dedupeKeyFor,
  isEndpointToken,
  methodAllowed,
  newEndpointToken,
  parseWebhookBody,
  parseWebhookConfig,
  redactHeaders,
  REDACTED,
  resolveWebhookBaseUrl,
  tokenFromPath,
  verifyWebhookRequest,
  webhookUrl,
  WebhookRateLimiter,
  type WebhookConfig,
} from "./webhook.js";

const raw = (text: string) => Buffer.from(text, "utf8");
const hmac = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(payload).digest("hex");

describe("parseWebhookConfig", () => {
  it("defaults to an unsigned async endpoint accepting any method", () => {
    expect(parseWebhookConfig({})).toEqual({
      methods: undefined,
      scheme: "none",
      header: "",
      secretRef: undefined,
      toleranceSeconds: 300,
      responseMode: "async",
      responseStatus: 202,
      challengeField: undefined,
      dedupeField: undefined,
      dedupeTtlSeconds: 300,
    });
  });

  it("fills in the header each scheme reads and accepts an override", () => {
    const ref = "secret://v1:00112233445566778899aabbccddeeff";
    expect(
      parseWebhookConfig({ scheme: "github", secretRef: ref }).header,
    ).toBe("x-hub-signature-256");
    expect(
      parseWebhookConfig({ scheme: "stripe", secretRef: ref }).header,
    ).toBe("stripe-signature");
    expect(
      parseWebhookConfig({ scheme: "token", secretRef: ref, header: "X-Auth" })
        .header,
    ).toBe("x-auth");
  });

  it("normalises methods and treats ANY as unrestricted", () => {
    expect(parseWebhookConfig({ methods: "post" }).methods).toEqual(["POST"]);
    expect(parseWebhookConfig({ methods: ["get", "PUT"] }).methods).toEqual([
      "GET",
      "PUT",
    ]);
    expect(parseWebhookConfig({ methods: "ANY" }).methods).toBeUndefined();
    expect(parseWebhookConfig({ methods: "" }).methods).toBeUndefined();
  });

  it("switches the default status with the response mode", () => {
    expect(parseWebhookConfig({ responseMode: "sync" }).responseStatus).toBe(
      200,
    );
    expect(
      parseWebhookConfig({ responseMode: "sync", responseStatus: 201 })
        .responseStatus,
    ).toBe(201);
  });

  it("accepts a JSON-encoded config, as the document may hold one", () => {
    expect(parseWebhookConfig('{"methods":"POST"}').methods).toEqual(["POST"]);
  });

  it("rejects a signed scheme with no secret", () => {
    expect(() => parseWebhookConfig({ scheme: "github" })).toThrow(
      /needs a "secretRef"/,
    );
  });

  it("rejects unknown schemes, methods and out-of-range statuses", () => {
    expect(() => parseWebhookConfig({ scheme: "sha1" })).toThrow(/"scheme"/);
    expect(() => parseWebhookConfig({ methods: "TRACE" })).toThrow(/TRACE/);
    expect(() => parseWebhookConfig({ responseStatus: 700 })).toThrow(
      /responseStatus/,
    );
    expect(() => parseWebhookConfig({ toleranceSeconds: 0 })).toThrow(
      /toleranceSeconds/,
    );
    expect(() => parseWebhookConfig({ dedupeTtlSeconds: -1 })).toThrow(
      /dedupeTtlSeconds/,
    );
  });
});

describe("endpoint tokens", () => {
  it("mints 128 bits of hex", () => {
    const token = newEndpointToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(isEndpointToken(token)).toBe(true);
    expect(newEndpointToken()).not.toBe(token);
  });

  it("reads a token off the endpoint path and nothing else", () => {
    const token = "0".repeat(32);
    expect(tokenFromPath(`/workflows/hooks/${token}`)).toBe(token);
    expect(tokenFromPath(`/workflows/hooks/${token}/extra`)).toBeUndefined();
    expect(tokenFromPath("/workflows/hooks/short")).toBeUndefined();
    expect(tokenFromPath(`/graphql/${token}`)).toBeUndefined();
  });

  it("joins the base URL without doubling the slash", () => {
    expect(webhookUrl("http://localhost:4001/", "ab")).toBe(
      "http://localhost:4001/workflows/hooks/ab",
    );
  });
});

describe("resolveWebhookBaseUrl", () => {
  it("prefers the explicit override", () => {
    expect(
      resolveWebhookBaseUrl(4001, {
        WORKFLOW_WEBHOOK_BASE_URL: "https://hooks.example.com/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://hooks.example.com");
  });

  it("falls back to the Heroku domain, then the listening port", () => {
    expect(
      resolveWebhookBaseUrl(4001, {
        HEROKU_APP_DEFAULT_DOMAIN_NAME: "app.herokuapp.com",
      } as NodeJS.ProcessEnv),
    ).toBe("https://app.herokuapp.com");
    expect(resolveWebhookBaseUrl(9000, {} as NodeJS.ProcessEnv)).toBe(
      "http://localhost:9000",
    );
  });
});

const signed = (
  scheme: WebhookConfig["scheme"],
  extra: Record<string, unknown> = {},
): WebhookConfig =>
  parseWebhookConfig({
    scheme,
    secretRef: "secret://v1:00112233445566778899aabbccddeeff",
    ...extra,
  });

describe("verifyWebhookRequest", () => {
  const body = '{"id":"evt_1"}';

  it("passes everything through when no scheme is configured", () => {
    expect(
      verifyWebhookRequest({
        config: parseWebhookConfig({}),
        headers: {},
        raw: raw(body),
      }),
    ).toEqual({ ok: true });
  });

  it("refuses when the secret could not be resolved", () => {
    expect(
      verifyWebhookRequest({
        config: signed("hmac-sha256"),
        headers: { "x-signature": hmac("s3cret", body) },
        raw: raw(body),
      }),
    ).toEqual({ ok: false, reason: "signing secret missing" });
  });

  it("refuses when the configured header is absent", () => {
    const result = verifyWebhookRequest({
      config: signed("hmac-sha256"),
      headers: {},
      raw: raw(body),
      secret: "s3cret",
    });
    expect(result).toEqual({
      ok: false,
      reason: 'header "x-signature" absent',
    });
  });

  it("compares a shared token", () => {
    const config = signed("token");
    expect(
      verifyWebhookRequest({
        config,
        headers: { "x-webhook-token": "s3cret" },
        raw: raw(body),
        secret: "s3cret",
      }).ok,
    ).toBe(true);
    expect(
      verifyWebhookRequest({
        config,
        headers: { "x-webhook-token": "wrong" },
        raw: raw(body),
        secret: "s3cret",
      }).ok,
    ).toBe(false);
  });

  it("verifies a bare hex HMAC over the exact bytes", () => {
    const config = signed("hmac-sha256");
    expect(
      verifyWebhookRequest({
        config,
        headers: { "x-signature": hmac("s3cret", body).toUpperCase() },
        raw: raw(body),
        secret: "s3cret",
      }).ok,
    ).toBe(true);
    // Re-encoding the body is exactly what breaks a signature.
    expect(
      verifyWebhookRequest({
        config,
        headers: { "x-signature": hmac("s3cret", body) },
        raw: raw(JSON.stringify(JSON.parse(body))),
        secret: "s3cret",
      }).ok,
    ).toBe(true);
    expect(
      verifyWebhookRequest({
        config,
        headers: { "x-signature": hmac("s3cret", body) },
        raw: raw('{"id": "evt_1"}'),
        secret: "s3cret",
      }).ok,
    ).toBe(false);
  });

  it("verifies GitHub's sha256= prefix", () => {
    const config = signed("github");
    expect(
      verifyWebhookRequest({
        config,
        headers: { "x-hub-signature-256": `sha256=${hmac("s3cret", body)}` },
        raw: raw(body),
        secret: "s3cret",
      }).ok,
    ).toBe(true);
    expect(
      verifyWebhookRequest({
        config,
        headers: { "x-hub-signature-256": hmac("s3cret", body) },
        raw: raw(body),
        secret: "s3cret",
      }).ok,
    ).toBe(false);
  });

  describe("stripe", () => {
    const now = new Date("2026-09-07T12:00:00.000Z");
    const timestamp = Math.floor(now.getTime() / 1000);
    const config = signed("stripe");
    const header = (t: number, ...signatures: string[]) =>
      `t=${t},${signatures.map((s) => `v1=${s}`).join(",")}`;

    it("signs the timestamp and body together", () => {
      const signature = hmac("s3cret", `${timestamp}.${body}`);
      expect(
        verifyWebhookRequest({
          config,
          headers: { "stripe-signature": header(timestamp, signature) },
          raw: raw(body),
          secret: "s3cret",
          now,
        }).ok,
      ).toBe(true);
    });

    it("accepts any candidate, which is how key rotation works", () => {
      const signature = hmac("s3cret", `${timestamp}.${body}`);
      expect(
        verifyWebhookRequest({
          config,
          headers: {
            "stripe-signature": header(timestamp, "deadbeef", signature),
          },
          raw: raw(body),
          secret: "s3cret",
          now,
        }).ok,
      ).toBe(true);
    });

    it("rejects a replay outside the window", () => {
      const stale = timestamp - 3600;
      const signature = hmac("s3cret", `${stale}.${body}`);
      expect(
        verifyWebhookRequest({
          config,
          headers: { "stripe-signature": header(stale, signature) },
          raw: raw(body),
          secret: "s3cret",
          now,
        }),
      ).toEqual({
        ok: false,
        reason: "timestamp outside the replay window",
      });
    });

    it("rejects a header with no timestamp or no signature", () => {
      expect(
        verifyWebhookRequest({
          config,
          headers: { "stripe-signature": `v1=${hmac("s3cret", body)}` },
          raw: raw(body),
          secret: "s3cret",
          now,
        }).ok,
      ).toBe(false);
      expect(
        verifyWebhookRequest({
          config,
          headers: { "stripe-signature": `t=${timestamp}` },
          raw: raw(body),
          secret: "s3cret",
          now,
        }).ok,
      ).toBe(false);
    });
  });
});

describe("methodAllowed", () => {
  it("accepts every method when none are configured", () => {
    expect(methodAllowed(parseWebhookConfig({}), "delete")).toBe(true);
  });

  it("matches case-insensitively against the configured list", () => {
    const config = parseWebhookConfig({ methods: ["POST"] });
    expect(methodAllowed(config, "post")).toBe(true);
    expect(methodAllowed(config, "GET")).toBe(false);
  });
});

describe("parseWebhookBody", () => {
  it("parses JSON, including vendor +json types", () => {
    expect(parseWebhookBody(raw('{"a":1}'), "application/json")).toEqual({
      a: 1,
    });
    expect(
      parseWebhookBody(raw('{"a":1}'), "application/vnd.api+json; charset=x"),
    ).toEqual({ a: 1 });
  });

  it("parses form encoding and leaves anything else as text", () => {
    expect(
      parseWebhookBody(raw("a=1&b=2"), "application/x-www-form-urlencoded"),
    ).toEqual({ a: "1", b: "2" });
    expect(parseWebhookBody(raw("<x/>"), "application/xml")).toBe("<x/>");
    expect(parseWebhookBody(raw(""), "application/json")).toBeUndefined();
  });

  it("keeps malformed JSON as text rather than losing the evidence", () => {
    expect(parseWebhookBody(raw("{oops"), "application/json")).toBe("{oops");
  });
});

describe("redactHeaders", () => {
  it("hides credential headers and the configured signature header", () => {
    expect(
      redactHeaders(
        {
          Authorization: "Bearer x",
          "X-Hub-Signature-256": "sha256=x",
          "X-Auth": "token",
          "content-type": "application/json",
        },
        "x-auth",
      ),
    ).toEqual({
      authorization: REDACTED,
      "x-hub-signature-256": REDACTED,
      "x-auth": REDACTED,
      "content-type": "application/json",
    });
  });
});

describe("buildWebhookPayload", () => {
  it("shapes the Activepieces catch-webhook contract", () => {
    expect(
      buildWebhookPayload({
        method: "post",
        path: "/workflows/hooks/abc",
        headers: { "content-type": "application/json", authorization: "x" },
        queryParams: { source: "github" },
        raw: raw('{"id":"evt_1"}'),
      }),
    ).toEqual({
      method: "POST",
      path: "/workflows/hooks/abc",
      headers: { "content-type": "application/json", authorization: REDACTED },
      queryParams: { source: "github" },
      body: { id: "evt_1" },
    });
  });
});

describe("challengeResponse", () => {
  const payload = (body: unknown, queryParams: Record<string, string> = {}) =>
    buildWebhookPayload({
      method: "POST",
      path: "/workflows/hooks/abc",
      headers: { "content-type": "application/json" },
      queryParams,
      raw: raw(JSON.stringify(body)),
    });

  it("is absent unless the author named a field", () => {
    expect(
      challengeResponse(parseWebhookConfig({}), payload({ challenge: "c" })),
    ).toBeUndefined();
  });

  it("prefers the query param, then the body field", () => {
    const config = parseWebhookConfig({ challengeField: "challenge" });
    expect(
      challengeResponse(
        config,
        payload(
          { challenge: "body" },
          {
            challenge: "query",
          },
        ),
      ),
    ).toBe("query");
    expect(challengeResponse(config, payload({ challenge: "body" }))).toBe(
      "body",
    );
    expect(challengeResponse(config, payload({ other: 1 }))).toBeUndefined();
  });
});

describe("dedupeKeyFor", () => {
  const payload = (body: unknown) =>
    buildWebhookPayload({
      method: "POST",
      path: "/workflows/hooks/abc",
      headers: { "content-type": "application/json" },
      queryParams: {},
      raw: raw(JSON.stringify(body)),
    });

  it("reads the named field, stringifying a numeric id", () => {
    const config = parseWebhookConfig({ dedupeField: "id" });
    expect(dedupeKeyFor(config, payload({ id: "evt_1" }))).toBe("evt_1");
    expect(dedupeKeyFor(config, payload({ id: 42 }))).toBe("42");
  });

  it("is absent for an unnamed field or a non-scalar value", () => {
    expect(
      dedupeKeyFor(parseWebhookConfig({}), payload({ id: "x" })),
    ).toBeUndefined();
    const config = parseWebhookConfig({ dedupeField: "id" });
    expect(
      dedupeKeyFor(config, payload({ id: { nested: true } })),
    ).toBeUndefined();
    expect(dedupeKeyFor(config, payload("text"))).toBeUndefined();
  });
});

describe("WebhookRateLimiter", () => {
  it("allows a burst up to the capacity, then refuses", () => {
    const limiter = new WebhookRateLimiter(60, 3);
    expect(limiter.allow("t", 0)).toBe(true);
    expect(limiter.allow("t", 0)).toBe(true);
    expect(limiter.allow("t", 0)).toBe(true);
    expect(limiter.allow("t", 0)).toBe(false);
  });

  it("refills over time and keeps buckets per token", () => {
    const limiter = new WebhookRateLimiter(60, 1);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 0)).toBe(false);
    expect(limiter.allow("b", 0)).toBe(true);
    // 60/minute means one token per second.
    expect(limiter.allow("a", 1_000)).toBe(true);
  });

  it("clears rather than growing without bound", () => {
    const limiter = new WebhookRateLimiter(60, 1, 2);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("b", 0)).toBe(true);
    expect(limiter.allow("c", 0)).toBe(true);
    // "a" was evicted with the clear, so its bucket starts fresh.
    expect(limiter.allow("a", 0)).toBe(true);
  });
});
