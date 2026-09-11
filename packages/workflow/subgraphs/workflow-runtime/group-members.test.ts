// Group references resolved at delivery: the point of a group is that editing
// it changes who may deliver, without re-saving a single workflow.
import { describe, expect, it, vi } from "vitest";
import {
  GroupMembers,
  groupRecordFrom,
  type GroupRecord,
} from "./group-members.js";

const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const CAROL = "0x3333333333333333333333333333333333333333";

/** A loader over a mutable store, so a test can edit a group mid-flight. */
function store(initial: Record<string, string[]>) {
  const groups = new Map(Object.entries(initial));
  const load = vi.fn((ids: readonly string[]) =>
    Promise.resolve(
      ids
        .filter((id) => groups.has(id))
        .map((id): GroupRecord => ({ id, members: groups.get(id) ?? [] })),
    ),
  );
  return { groups, load };
}

describe("GroupMembers", () => {
  it("resolves a group to its members, lowercased and de-duplicated", async () => {
    const { load } = store({ eng: [ALICE.toUpperCase(), BOB], ops: [BOB] });
    const members = new GroupMembers(load);
    const resolved = await members.resolve(["eng", "ops"]);
    expect(resolved.members.sort()).toEqual([ALICE.toLowerCase(), BOB].sort());
    expect(resolved.missing).toEqual([]);
  });

  it("reads every stale group in one call", async () => {
    const { load } = store({ eng: [ALICE], ops: [BOB] });
    await new GroupMembers(load).resolve(["eng", "ops"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toEqual(["eng", "ops"]);
  });

  it("serves a cached group without reading again", async () => {
    const { load } = store({ eng: [ALICE] });
    const members = new GroupMembers(load);
    await members.resolve(["eng"]);
    await members.resolve(["eng"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("picks up a membership change with no workflow re-saved", async () => {
    // This is the whole reason references are resolved rather than snapshotted.
    const { groups, load } = store({ eng: [ALICE] });
    const members = new GroupMembers(load);
    expect((await members.resolve(["eng"])).members).toEqual([ALICE]);

    groups.set("eng", [ALICE, CAROL]);
    members.invalidate("eng");

    expect((await members.resolve(["eng"])).members.sort()).toEqual(
      [ALICE, CAROL].sort(),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("re-reads once the TTL lapses, for an edit made on another node", async () => {
    const { groups, load } = store({ eng: [ALICE] });
    let clock = 0;
    const members = new GroupMembers(load, { ttlMs: 1000, now: () => clock });
    await members.resolve(["eng"]);
    groups.set("eng", [CAROL]);
    clock = 500;
    expect((await members.resolve(["eng"])).members).toEqual([ALICE]);
    clock = 1500;
    expect((await members.resolve(["eng"])).members).toEqual([CAROL]);
  });

  it("grants nobody for a group that has been deleted", async () => {
    const { groups, load } = store({ eng: [ALICE] });
    const members = new GroupMembers(load);
    await members.resolve(["eng"]);

    groups.delete("eng");
    members.invalidate("eng");

    const resolved = await members.resolve(["eng"]);
    expect(resolved.members).toEqual([]);
    expect(resolved.missing).toEqual(["eng"]);
  });

  it("keeps the last known members when the read after an edit fails", async () => {
    // The invalidation is what makes this the dangerous case: without members
    // to fall back on, one failed read would revoke the whole group.
    const { load } = store({ eng: [ALICE] });
    const members = new GroupMembers(load);
    expect((await members.resolve(["eng"])).members).toEqual([ALICE]);

    members.invalidate("eng");
    load.mockRejectedValueOnce(new Error("reactor unreachable"));

    const resolved = await members.resolve(["eng"]);
    expect(resolved.members).toEqual([ALICE]);
    expect(resolved.missing).toEqual([]);
  });

  it("discards a read that began before the edit that invalidated it", async () => {
    const { groups, load } = store({ eng: [ALICE, CAROL] });
    const members = new GroupMembers(load);
    await members.resolve(["eng"]);

    // Reads the group when the call is made, not when it is released, so the
    // result carries the membership as it stood before the edit below.
    let release: (() => void) | undefined;
    load.mockImplementationOnce(() => {
      const snapshot = [...(groups.get("eng") ?? [])];
      return new Promise((resolve) => {
        release = () => resolve([{ id: "eng", members: snapshot }]);
      });
    });

    members.invalidate("eng");
    const pending = members.resolve(["eng"]);
    await vi.waitFor(() => expect(release).toBeDefined());

    // Carol is removed while that read is in flight; its snapshot still has her.
    groups.set("eng", [ALICE]);
    members.invalidate("eng");
    release?.();

    expect((await pending).members).toEqual([ALICE]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("reports a group that never existed without failing the others", async () => {
    const { load } = store({ eng: [ALICE] });
    const resolved = await new GroupMembers(load).resolve(["eng", "ghost"]);
    expect(resolved.members).toEqual([ALICE]);
    expect(resolved.missing).toEqual(["ghost"]);
  });

  it("keeps the last known members when the read fails", async () => {
    // A blip must neither widen access nor silently revoke everyone's.
    const load = vi
      .fn<(ids: readonly string[]) => Promise<GroupRecord[]>>()
      .mockResolvedValueOnce([{ id: "eng", members: [ALICE] }])
      .mockRejectedValue(new Error("reactor unreachable"));
    let clock = 0;
    const members = new GroupMembers(load, { ttlMs: 100, now: () => clock });
    await members.resolve(["eng"]);
    clock = 200;
    expect((await members.resolve(["eng"])).members).toEqual([ALICE]);
  });

  it("grants nobody when the very first read fails", async () => {
    const load = vi
      .fn<(ids: readonly string[]) => Promise<GroupRecord[]>>()
      .mockRejectedValue(new Error("reactor unreachable"));
    const resolved = await new GroupMembers(load).resolve(["eng"]);
    expect(resolved.members).toEqual([]);
    expect(resolved.missing).toEqual(["eng"]);
  });

  it("costs nothing when a trigger names no groups", async () => {
    const { load } = store({});
    expect(await new GroupMembers(load).resolve([])).toEqual({
      members: [],
      missing: [],
    });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("groupRecordFrom", () => {
  it("reads a group document's id and members", () => {
    expect(
      groupRecordFrom({
        header: { id: "eng" },
        state: { global: { name: "Engineering", members: [ALICE] } },
      }),
    ).toEqual({ id: "eng", members: [ALICE] });
  });

  it("grants nobody for a shape the runtime does not recognise", () => {
    // The runtime holds a document of a model it does not own, so a surprise
    // has to read as an empty group rather than as a crash or a wildcard.
    expect(groupRecordFrom(undefined)).toBeUndefined();
    expect(
      groupRecordFrom({ state: { global: { members: [ALICE] } } }),
    ).toBeUndefined();
    expect(groupRecordFrom({ header: { id: "eng" } })).toEqual({
      id: "eng",
      members: [],
    });
    expect(
      groupRecordFrom({
        header: { id: "eng" },
        state: { global: { members: [ALICE, 7, null] } },
      }),
    ).toEqual({ id: "eng", members: [ALICE] });
  });
});
