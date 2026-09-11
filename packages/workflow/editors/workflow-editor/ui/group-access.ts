// Reading `powerhouse/reactor-group` documents for the allow-list picker.
// Kept out of the components so the rules are testable without rendering.
export const GROUP_DOCUMENT_TYPE = "powerhouse/reactor-group";

export interface GroupSummary {
  id: string;
  name: string;
  members: string[];
}

// The picker renders documents the reactor handed back, so every read is
// defensive: an unfamiliar shape is skipped rather than drawn half-empty.
export function groupSummaryFrom(document: unknown): GroupSummary | undefined {
  const id = (document as { header?: { id?: unknown } } | undefined)?.header
    ?.id;
  if (typeof id !== "string" || id === "") return undefined;
  const global = (
    document as
      | { state?: { global?: { name?: unknown; members?: unknown } } }
      | undefined
  )?.state?.global;
  const members = Array.isArray(global?.members)
    ? global.members.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  const name = typeof global?.name === "string" ? global.name.trim() : "";
  return {
    id,
    name: name === "" ? "Untitled group" : name,
    members: members.map((entry) => entry.trim().toLowerCase()),
  };
}

export function groupSummaries(documents: readonly unknown[]): GroupSummary[] {
  const summaries: GroupSummary[] = [];
  for (const document of documents) {
    const summary = groupSummaryFrom(document);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** Selected first, then alphabetical: the groups already granting access are
 * what the author came to check, and the rest is a list to scan. */
export function orderGroups(
  groups: readonly GroupSummary[],
  selected: readonly string[],
): GroupSummary[] {
  return [...groups].sort((left, right) => {
    const leftSelected = selected.includes(left.id);
    const rightSelected = selected.includes(right.id);
    if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

/** A name that does not collide, so two groups are never indistinguishable in
 * a list whose only other column is a member count. */
export function defaultGroupName(existing: readonly GroupSummary[]): string {
  const taken = new Set(existing.map((group) => group.name.toLowerCase()));
  const base = "New group";
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

// Groups still named in the allow-list that no longer exist, or that this user
// cannot read. Shown as such rather than dropped: removing a reference in

// silence would read as access that was never granted.
export function danglingGroups(
  selected: readonly string[],
  groups: readonly GroupSummary[],
): string[] {
  const known = new Set(groups.map((group) => group.id));
  return selected.filter((id) => !known.has(id));
}

export function memberCountLabel(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}
