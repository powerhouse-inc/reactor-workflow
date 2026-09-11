// Resolving `powerhouse/reactor-group` references to the addresses they stand
// for, at delivery time rather than when the workflow was saved.

// A group exists so membership is managed in one place. Snapshotting its
// members into the trigger config would make it a one-time copy: removing

// someone from the group would leave them able to trigger every workflow that
// ever referenced it, silently, until each was opened and re-saved. That is the

// failure a group is meant to prevent, so the reference stays a reference and
// the read is cached instead — invalidated by the group's own operations, with

// a TTL as the backstop for an edit made on another node.
import { childLogger } from "document-model";

const logger = childLogger(["workflow", "group-members"]);

export const GROUP_DOCUMENT_TYPE = "powerhouse/reactor-group";

export interface GroupRecord {
  id: string;
  members: string[];
}

/** Loads the named groups. A group that does not come back does not exist, or
 * is not readable by the runtime; either way it grants nobody. */
export type GroupLoader = (ids: readonly string[]) => Promise<GroupRecord[]>;

export interface GroupResolution {
  /** Lowercased member addresses across every group that resolved. */
  members: string[];
  /** Referenced groups that did not resolve. Reported, never fatal. */
  missing: string[];
}

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  members: string[] | undefined;
  expiresAt: number;
}

export class GroupMembers {
  readonly #load: GroupLoader;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(
    load: GroupLoader,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#load = load;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Drops a group's cached membership, so the next delivery re-reads it. The
   * runtime sees every document's operations, so an edit lands here at once. */
  invalidate(documentId: string): void {
    this.#cache.delete(documentId);
  }

  clear(): void {
    this.#cache.clear();
  }

  async resolve(groupIds: readonly string[]): Promise<GroupResolution> {
    if (groupIds.length === 0) return { members: [], missing: [] };
    const now = this.#now();
    const stale = groupIds.filter((id) => {
      const entry = this.#cache.get(id);
      return !entry || entry.expiresAt <= now;
    });

    if (stale.length > 0) {
      // One read for every stale group, not one per group: a trigger naming
      // several groups must not cost several round trips per delivery.
      const loaded = await this.#loadInto(stale, now);
      if (!loaded) {
        // A failed read must not widen access, and must not narrow it to
        // nothing on a blip either: whatever is still cached stands.
        for (const id of stale) {
          this.#cache.set(id, {
            members: this.#cache.get(id)?.members,
            expiresAt: now + this.#ttlMs,
          });
        }
      }
    }

    const members = new Set<string>();
    const missing: string[] = [];
    for (const id of groupIds) {
      const entry = this.#cache.get(id);
      if (!entry?.members) {
        missing.push(id);
        continue;
      }
      for (const member of entry.members) members.add(member);
    }
    return { members: [...members], missing };
  }

  async #loadInto(ids: string[], now: number): Promise<boolean> {
    let records: GroupRecord[];
    try {
      records = await this.#load(ids);
    } catch (error) {
      logger.warn(
        "Could not read group membership for @count group(s); the last known members stand until the next delivery",
        ids.length,
        error,
      );
      return false;
    }
    const byId = new Map(records.map((record) => [record.id, record.members]));
    for (const id of ids) {
      const members = byId.get(id);
      this.#cache.set(id, {
        members: members?.map((member) => member.trim().toLowerCase()),
        expiresAt: now + this.#ttlMs,
      });
    }
    return true;
  }
}

/** Reads a group document's members defensively: the runtime holds a PHDocument
 * of a model it does not own, so a shape it does not recognise grants nobody. */
export function groupRecordFrom(document: unknown): GroupRecord | undefined {
  const header = (document as { header?: { id?: unknown } } | undefined)
    ?.header;
  const id = typeof header?.id === "string" ? header.id : undefined;
  if (!id) return undefined;
  const global = (
    document as { state?: { global?: { members?: unknown } } } | undefined
  )?.state?.global;
  const members = Array.isArray(global?.members)
    ? global.members.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  return { id, members };
}
