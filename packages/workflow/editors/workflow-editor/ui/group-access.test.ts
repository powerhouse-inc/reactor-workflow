import { describe, expect, it } from "vitest";
import {
  danglingGroups,
  defaultGroupName,
  groupSummaries,
  groupSummaryFrom,
  memberCountLabel,
  orderGroups,
  type GroupSummary,
} from "./group-access.js";

const ALICE = "0x1111111111111111111111111111111111111111";

const group = (id: string, name: string, members: string[] = []) =>
  ({ id, name, members }) satisfies GroupSummary;

const document = (id: string, name: string, members: unknown[]) => ({
  header: { id },
  state: { global: { name, members } },
});

describe("groupSummaryFrom", () => {
  it("reads a group document's id, name and members", () => {
    expect(
      groupSummaryFrom(document("g1", "Engineering", [ALICE.toUpperCase()])),
    ).toEqual({ id: "g1", name: "Engineering", members: [ALICE] });
  });

  it("names a group with no name rather than drawing a gap", () => {
    expect(groupSummaryFrom(document("g1", "   ", []))?.name).toBe(
      "Untitled group",
    );
  });

  it("skips a shape the picker does not recognise", () => {
    // These come back from the reactor, so an unfamiliar one is dropped
    // instead of rendered half-empty.
    expect(groupSummaryFrom(undefined)).toBeUndefined();
    expect(
      groupSummaryFrom({ state: { global: { name: "x" } } }),
    ).toBeUndefined();
    expect(groupSummaryFrom({ header: { id: "g1" } })?.members).toEqual([]);
    expect(
      groupSummaryFrom(document("g1", "Eng", [ALICE, 7, null]))?.members,
    ).toEqual([ALICE]);
  });

  it("keeps only the documents it could read", () => {
    expect(
      groupSummaries([document("g1", "Eng", []), undefined, "junk"]),
    ).toHaveLength(1);
  });
});

describe("ordering and naming", () => {
  it("puts the granting groups first, then sorts by name", () => {
    const groups = [group("c", "Ops"), group("a", "Eng"), group("b", "Admin")];
    expect(orderGroups(groups, ["c"]).map((entry) => entry.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("proposes a name that does not collide with an existing one", () => {
    expect(defaultGroupName([])).toBe("New group");
    expect(defaultGroupName([group("a", "New group")])).toBe("New group 2");
    expect(
      defaultGroupName([group("a", "new group"), group("b", "New group 2")]),
    ).toBe("New group 3");
  });

  it("counts members in words a row can carry", () => {
    expect(memberCountLabel(0)).toBe("0 members");
    expect(memberCountLabel(1)).toBe("1 member");
    expect(memberCountLabel(4)).toBe("4 members");
  });
});

describe("danglingGroups", () => {
  it("reports references the picker cannot resolve", () => {
    // Deleted, or in a drive this user cannot read. Dropping them silently
    // would read as access that was never granted.
    expect(danglingGroups(["a", "ghost"], [group("a", "Eng")])).toEqual([
      "ghost",
    ]);
    expect(danglingGroups([], [group("a", "Eng")])).toEqual([]);
  });
});
