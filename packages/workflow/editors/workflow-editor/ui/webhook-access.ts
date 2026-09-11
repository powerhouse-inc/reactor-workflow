// Reading and editing the access half of a core#webhook trigger's config.
// Kept out of the component so the rules are testable without rendering.

// Powerhouse has no user directory: there is no query anywhere in the stack
// that lists identities, and a Renown identity is an address. So access is

// granted by address, and the only name the editor can put next to one is the
// signed-in user's own. See WebhookAccessSection for how that is presented.

/** Mirrors WEBHOOK_AUTH_METHODS in the runtime's webhook.ts. */
export type WebhookAuthMethod = "path" | "renown";

export interface WebhookAccess {
  method: WebhookAuthMethod;
  allowed: string[];
  // Entries the runtime's parser would reject. It drops the whole registration
  // over one, so rendering them as absent would read as a healthy allow-list.
  invalid: string[];
  // powerhouse/reactor-group document ids. Held as references: the runtime
  // resolves them per delivery, so editing a group needs no workflow re-saved.
  groups: string[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// The config arrives from the document as an opaque value, so every read is
// defensive: a half-written config must render, not throw. A string is parsed

// exactly as the runtime's own parser does — treating one as empty would let
// the next edit replace a whole signed config with two access fields.
function asRecord(config: unknown): Record<string, unknown> {
  if (config && typeof config === "object" && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  if (typeof config === "string") {
    try {
      return asRecord(JSON.parse(config));
    } catch {
      return {};
    }
  }
  return {};
}

export function readWebhookAccess(config: unknown): WebhookAccess {
  const record = asRecord(config);
  const entries = Array.isArray(record.allowedAddresses)
    ? record.allowedAddresses
    : [];
  const allowed: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && ADDRESS.test(entry.trim())) {
      allowed.push(entry.trim().toLowerCase());
    } else {
      invalid.push(typeof entry === "string" ? entry : JSON.stringify(entry));
    }
  }
  const groups = Array.isArray(record.allowedGroups)
    ? record.allowedGroups.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim() !== "",
      )
    : [];
  return {
    method: record.auth === "renown" ? "renown" : "path",
    allowed,
    invalid,
    groups: [...new Set(groups.map((entry) => entry.trim()))],
  };
}

/** Drops entries the runtime would refuse, so the author can clear a config
 * that is keeping the trigger from arming. */
export function withoutInvalid(config: unknown): unknown {
  return withAllowed(config, readWebhookAccess(config).allowed);
}

// The list survives a switch back to the path token: an author comparing the
// two methods should not have to retype everyone to undo a click.
export function withAuthMethod(
  config: unknown,
  method: WebhookAuthMethod,
): unknown {
  return { ...asRecord(config), auth: method };
}

export function withAllowed(config: unknown, allowed: string[]): unknown {
  return { ...asRecord(config), allowedAddresses: allowed };
}

export function withGroups(config: unknown, groups: string[]): unknown {
  return { ...asRecord(config), allowedGroups: groups };
}

export function toggleGroup(groups: readonly string[], id: string): string[] {
  return groups.includes(id)
    ? groups.filter((entry) => entry !== id)
    : [...groups, id];
}

export type AddressCheck =
  | { ok: true; address: string }
  | { ok: false; message: string };

/** What the author typed, or why it cannot be added. The messages name the one
 * thing to fix, since there is no directory to search instead. */
export function checkAddress(
  input: string,
  existing: readonly string[],
): AddressCheck {
  const text = input.trim();
  if (!text) return { ok: false, message: "Paste an address to add it." };
  if (text.endsWith(".eth")) {
    return {
      ok: false,
      message: "ENS names cannot be resolved here yet — paste the address.",
    };
  }
  if (!text.startsWith("0x")) {
    return { ok: false, message: "An address starts with 0x." };
  }
  if (!ADDRESS.test(text)) {
    return {
      ok: false,
      message: `That is ${text.length - 2} hex characters; an address has 40.`,
    };
  }
  const address = text.toLowerCase();
  if (existing.includes(address)) {
    return { ok: false, message: "That identity already has access." };
  }
  return { ok: true, address };
}

export function addAddress(
  allowed: readonly string[],
  address: string,
): string[] {
  const normalized = address.trim().toLowerCase();
  return allowed.includes(normalized) ? [...allowed] : [...allowed, normalized];
}

export function removeAddress(
  allowed: readonly string[],
  address: string,
): string[] {
  const normalized = address.trim().toLowerCase();
  return allowed.filter((entry) => entry !== normalized);
}

export function sameAddress(
  a: string | undefined,
  b: string | undefined,
): boolean {
  return (
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
  );
}

/** Enough of the address to recognise, from both ends: the leading digits alone
 * collide often enough that two allowed identities can read as one. */
export function truncateAddress(address: string): string {
  return address.length <= 13
    ? address
    : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export interface AddressMark {
  /** Row-major 5x5, mirrored left-to-right, so the mark reads as a face. */
  cells: boolean[];
  hue: number;
}

// A deterministic mark for an address. Not an avatar and not claiming to be
// one: it is a function of the address, which is all the editor actually knows,

// and it is what lets an author tell two truncated addresses apart at a glance
// instead of reading twelve hex characters.
export function addressMark(address: string): AddressMark {
  const hex = address.replace(/^0x/, "").toLowerCase();
  const nibbles: number[] = [];
  for (let index = 0; index < hex.length; index += 1) {
    nibbles.push(parseInt(hex.charAt(index), 16) || 0);
  }
  const cells: boolean[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const mirrored = column > 2 ? 4 - column : column;
      cells.push(nibbles[(row * 3 + mirrored) % nibbles.length] % 2 === 1);
    }
  }
  const hue = nibbles
    .slice(0, 8)
    .reduce((total, nibble) => (total * 16 + nibble) % 360, 0);
  return { cells, hue };
}
