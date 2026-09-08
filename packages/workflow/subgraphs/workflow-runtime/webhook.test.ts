// Config parsing for the core#webhook trigger block. Verification, tokens,
// redaction, dedupe keys, the challenge round and rate limiting are the
// reactor's webhook service and are covered by its own tests.
import { describe, expect, it } from "vitest";
import { parseWebhookConfig } from "./webhook.js";

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
