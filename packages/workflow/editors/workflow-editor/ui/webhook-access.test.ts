import { describe, expect, it } from "vitest";
import {
  addAddress,
  addressMark,
  checkAddress,
  readWebhookAccess,
  removeAddress,
  sameAddress,
  truncateAddress,
  withAllowed,
  withAuthMethod,
  withGroups,
  withoutInvalid,
  toggleGroup,
  type AddressCheck,
} from "./webhook-access.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const MIXED = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

/** Fails loudly if the check passed: a refusal message is what is under test. */
function refusal(check: AddressCheck): string {
  if (check.ok) throw new Error(`expected a refusal, got ${check.address}`);
  return check.message;
}

describe("readWebhookAccess", () => {
  it("reads the path token for a config that predates the choice", () => {
    expect(readWebhookAccess({ scheme: "none" })).toEqual({
      method: "path",
      allowed: [],
      invalid: [],
      groups: [],
    });
  });

  it("reads the list lowercased", () => {
    expect(
      readWebhookAccess({ auth: "renown", allowedAddresses: [MIXED] }),
    ).toEqual({
      method: "renown",
      allowed: [MIXED.toLowerCase()],
      invalid: [],
      groups: [],
    });
  });

  it("renders a half-written config rather than throwing", () => {
    // The config is an opaque document value: the panel has to draw whatever
    // is there, including nothing at all.
    expect(readWebhookAccess(undefined).method).toBe("path");
    expect(readWebhookAccess("nonsense").allowed).toEqual([]);
    expect(
      readWebhookAccess({ auth: "renown", allowedAddresses: [ALICE, 7, "x"] })
        .allowed,
    ).toEqual([ALICE]);
  });
});

describe("editing the config", () => {
  it("keeps the rest of the trigger config when the method changes", () => {
    expect(
      withAuthMethod({ scheme: "hmac", header: "x-sig" }, "renown"),
    ).toEqual({ scheme: "hmac", header: "x-sig", auth: "renown" });
  });

  it("keeps the list when the author switches back to the path token", () => {
    // Comparing the two methods should not cost the author the whole list.
    const renown = withAllowed(withAuthMethod({}, "renown"), [ALICE]);
    expect(readWebhookAccess(withAuthMethod(renown, "path"))).toEqual({
      method: "path",
      allowed: [ALICE],
      invalid: [],
      groups: [],
    });
  });

  it("adds, de-duplicates and removes case-insensitively", () => {
    expect(addAddress([], MIXED)).toEqual([MIXED.toLowerCase()]);
    expect(
      addAddress([ALICE], ALICE.toUpperCase().replace("0X", "0x")),
    ).toEqual([ALICE]);
    expect(
      removeAddress([ALICE, BOB], BOB.toUpperCase().replace("0X", "0x")),
    ).toEqual([ALICE]);
  });
});

describe("checkAddress", () => {
  it("accepts an address and normalises its case", () => {
    expect(checkAddress(` ${MIXED} `, [])).toEqual({
      ok: true,
      address: MIXED.toLowerCase(),
    });
  });

  it("says what to fix for each way of getting it wrong", () => {
    expect(refusal(checkAddress("", []))).toContain("Paste");
    expect(refusal(checkAddress("vitalik.eth", []))).toContain("ENS");
    expect(refusal(checkAddress("1111", []))).toContain("0x");
    expect(refusal(checkAddress("0xabc", []))).toContain("40");
  });

  it("refuses an identity that already has access", () => {
    expect(refusal(checkAddress(MIXED, [MIXED.toLowerCase()]))).toContain(
      "already",
    );
  });
});

describe("presentation", () => {
  it("truncates from both ends so two entries do not read as one", () => {
    expect(truncateAddress(ALICE)).toBe("0x1111…1111");
    expect(truncateAddress("0xabc")).toBe("0xabc");
  });

  it("matches addresses regardless of case, and never matches nothing", () => {
    expect(sameAddress(MIXED, MIXED.toLowerCase())).toBe(true);
    expect(sameAddress(undefined, ALICE)).toBe(false);
    expect(sameAddress(undefined, undefined)).toBe(false);
  });

  it("derives a stable 5x5 mirrored mark from the address alone", () => {
    const mark = addressMark(ALICE);
    expect(mark.cells).toHaveLength(25);
    expect(mark.hue).toBeGreaterThanOrEqual(0);
    expect(mark.hue).toBeLessThan(360);
    for (let row = 0; row < 5; row += 1) {
      expect(mark.cells[row * 5]).toBe(mark.cells[row * 5 + 4]);
      expect(mark.cells[row * 5 + 1]).toBe(mark.cells[row * 5 + 3]);
    }
    expect(addressMark(ALICE)).toEqual(
      addressMark(ALICE.toUpperCase().replace("0X", "0x")),
    );
    expect(addressMark(BOB).cells).not.toEqual(mark.cells);
  });
});

describe("a config the runtime would refuse", () => {
  it("surfaces malformed entries instead of rendering a healthy list", () => {
    // The runtime's parser throws on one bad address and drops the whole
    // registration, so filtering them away would show access that is not live.
    const access = readWebhookAccess({
      auth: "renown",
      allowedAddresses: [ALICE, "alice.eth", 7],
    });
    expect(access.allowed).toEqual([ALICE]);
    expect(access.invalid).toEqual(["alice.eth", "7"]);
  });

  it("clears them without touching the rest of the config", () => {
    const cleared = withoutInvalid({
      auth: "renown",
      scheme: "hmac",
      allowedAddresses: [ALICE, "nope"],
    });
    expect(readWebhookAccess(cleared).invalid).toEqual([]);
    expect((cleared as { scheme: string }).scheme).toBe("hmac");
  });

  it("parses a config stored as a JSON string, as the runtime does", () => {
    // Treating one as empty would let the next click replace a whole signed
    // config with two access fields.
    const stored = JSON.stringify({ scheme: "hmac", secretRef: "secret://v1" });
    expect(readWebhookAccess(stored).method).toBe("path");
    const next = withAuthMethod(stored, "renown") as Record<string, unknown>;
    expect(next.scheme).toBe("hmac");
    expect(next.secretRef).toBe("secret://v1");
  });
});

describe("groups in the allow-list", () => {
  it("reads, de-duplicates and toggles group references", () => {
    const config = withGroups({}, ["g1", "g1", "g2"]);
    expect(readWebhookAccess(config).groups).toEqual(["g1", "g2"]);
    expect(toggleGroup(["g1", "g2"], "g1")).toEqual(["g2"]);
    expect(toggleGroup(["g1"], "g2")).toEqual(["g1", "g2"]);
  });

  it("keeps addresses and groups independent", () => {
    const config = withGroups(withAllowed({}, [ALICE]), ["g1"]);
    const access = readWebhookAccess(config);
    expect(access.allowed).toEqual([ALICE]);
    expect(access.groups).toEqual(["g1"]);
  });
});
