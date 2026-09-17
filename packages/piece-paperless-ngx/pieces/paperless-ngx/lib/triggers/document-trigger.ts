import {
  createTrigger,
  Property,
  TriggerStrategy,
} from "@powerhousedao/pieces-framework";
import { paperlessAuth } from "../auth";
import type { PaperlessClient, QueryValue, UiSettings } from "../common/client";
import { clientFor, type StoreLike } from "../common/context";
import { trimContent } from "../common/documents";
import { PaperlessApiError } from "../common/errors";
import { objectMultiPicker } from "../common/pickers";
import { documentTriggerOutputFields } from "../common/output-schemas";

// WorkflowTrigger.WorkflowTriggerType — only these two carry {{doc_id}};
// consumption-started fires before the document exists, so it has nothing
// useful to hand a workflow.
export const TRIGGER_TYPE = {
  DOCUMENT_ADDED: 2,
  DOCUMENT_UPDATED: 3,
} as const;

// DocumentSource (documents/data_models.py)
const SOURCES = [
  { label: "Consume folder", value: 1 },
  { label: "API upload", value: 2 },
  { label: "Mail fetch", value: 3 },
  { label: "Web UI", value: 4 },
];

// MatchingModel.MATCHING_ALGORITHMS
const MATCHING = [
  { label: "None", value: 0 },
  { label: "Any word", value: 1 },
  { label: "All words", value: 2 },
  { label: "Literal", value: 3 },
  { label: "Regular expression", value: 4 },
  { label: "Fuzzy", value: 5 },
];

const STORE_KEY = "paperless:webhook-registration";
const CURSOR_KEY = "paperless:sweep-cursor";

interface Registration {
  workflow_id: number;
  trigger_id?: number;
  action_id?: number;
  webhook_id?: number;
  url: string;
}

export interface WebhookPayload {
  docId?: number | string;
  doc_id?: number | string;
  event?: string;
  // The runtime hands a webhook trigger the request envelope, the way
  // Activepieces does — `{ method, path, headers, queryParams, body }` — so
  // what paperless posted is one level down.
  body?: unknown;
  queryParams?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// The supervisor hands the piece one URL that carries the endpoint and the
// delivery token, the token in the fragment: a fragment is never sent on the
// wire and never reaches a server log, and the piece moves it into a header
// where paperless can send it (paperless does not sign its webhooks, so the
// token *is* the credential).
export function splitWebhookUrl(webhookUrl: string | undefined): {
  endpoint: string;
  token?: string;
} {
  if (!webhookUrl) return { endpoint: "" };
  const hash = webhookUrl.indexOf("#");
  if (hash === -1) return { endpoint: webhookUrl };
  return {
    endpoint: webhookUrl.slice(0, hash),
    token: webhookUrl.slice(hash + 1) || undefined,
  };
}

// WorkflowActionWebhook.url is a CharField(max_length=256).
const URL_MAX = 256;

function assertUsableUrl(endpoint: string): void {
  if (endpoint === "" || /^https?:\/\/localhost:0\b/.test(endpoint)) {
    throw new PaperlessApiError(
      "This reactor has no public webhook URL configured, so paperless-ngx would have nowhere to deliver to. " +
        "Configure one, or use a polling trigger instead.",
      { category: "config" },
    );
  }
  if (endpoint.length > URL_MAX) {
    throw new PaperlessApiError(
      `The webhook URL is ${endpoint.length} characters; paperless-ngx stores at most ${URL_MAX}`,
      { category: "config" },
    );
  }
}

// Only {{doc_id}} is interpolated, and only the id: Jinja renders every
// placeholder as a raw string, so a document titled `Invoice "Q3"` would break
// a payload that carried the title. Everything else is hydrated on our side.
//
// Paperless substitutes into the param's value, so the id arrives as a string
// even though it is numeric; `run` accepts either.
export function buildWebhookParams(event: string): Record<string, string> {
  return { doc_id: "{{doc_id}}", event };
}

function asDocId(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return undefined;
}

/**
 * The id paperless named, from wherever this delivery carries it.
 *
 * `body` is where a real delivery puts it: the runtime passes the request
 * envelope through untouched, and paperless posts `{doc_id, event}` as the
 * JSON body. `queryParams` covers a registration made by hand with `as_json`
 * off, where the params ride the query string instead. The flat spellings are
 * the older GraphQL ingress, and `docId` its camelCase.
 *
 * Reading only the flat shape is how this came to fall through to the
 * reconciliation sweep on every delivery — which works, because the supervisor
 * rewinds the cursor before a delivery, but it emits everything since that
 * cursor rather than the one document paperless pointed at, and a document
 * older than the rewind window is missed outright.
 */
function readDocId(payload: WebhookPayload | undefined): number | undefined {
  const nested = [payload?.body, payload?.queryParams].filter(isRecord);
  for (const source of nested) {
    const id = asDocId(source.docId ?? source.doc_id);
    if (id !== undefined) return id;
  }
  return asDocId(payload?.docId ?? payload?.doc_id);
}

// paperless-ngx 3.0 — API version 10 — replaced the workflow trigger's
// single-valued correspondent and document-type filters with multi-valued ones
// and added the "all of" / "none of" variants. Version 9, the 2.18 line, has
// only `filter_has_tags`, `filter_has_correspondent` and
// `filter_has_document_type`: OPTIONS /api/workflows/ against 2.18.4 lists
// exactly those.
//
// The rename matters more than a rename usually would. DRF drops unknown
// fields without a word, so a 3.x-shaped body registers a trigger carrying no
// document-type filter at all, and a workflow meant to fire on purchase orders
// fires on every document that lands.
const MULTI_VALUED_FILTER_API_VERSION = 10;

// Only these two need translating: `filter_has_tags` is an intersection on
// both lines ("any of"). matching.py compares each of these with `!=` against
// one id.
const SINGLE_VALUED_FILTERS = [
  {
    prop: "filter_has_any_correspondents",
    field: "filter_has_correspondent",
    noun: "correspondent",
  },
  {
    prop: "filter_has_any_document_types",
    field: "filter_has_document_type",
    noun: "document type",
  },
] as const;

// Filters that arrived with 3.0, labelled the way the props present them.
const FILTERS_ADDED_IN_V10: Record<string, string> = {
  filter_has_all_tags: "Has all of these tags",
  filter_has_not_tags: "Has none of these tags",
  filter_has_not_correspondents: "Correspondent is none of",
  filter_has_not_document_types: "Document type is none of",
  filter_has_any_storage_paths: "Storage path is any of",
  filter_has_not_storage_paths: "Storage path is none of",
};

// The document-list query param that means the same as each trigger filter.
// These are stable across both lines — 3.0 changed the trigger serializer, not
// the document filterset.
const SWEEP_FILTERS: Record<string, string> = {
  filter_has_tags: "tags__id__in",
  filter_has_all_tags: "tags__id__all",
  filter_has_not_tags: "tags__id__none",
  filter_has_any_correspondents: "correspondent__id__in",
  filter_has_not_correspondents: "correspondent__id__none",
  filter_has_any_document_types: "document_type__id__in",
  filter_has_not_document_types: "document_type__id__none",
  filter_has_any_storage_paths: "storage_path__id__in",
  filter_has_not_storage_paths: "storage_path__id__none",
};

function isFilterSet(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

function idList(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry));
}

/**
 * Rewrites the props for a pre-3.0 trigger serializer, refusing what that line
 * cannot express rather than dropping it. Paperless ignores a filter it does
 * not know, which widens the trigger instead of narrowing it — the opposite of
 * what was asked for, and silent either way.
 */
function downgradeFilters(
  props: Record<string, unknown>,
  serverVersion: string | undefined,
): Record<string, unknown> {
  const line = serverVersion
    ? `paperless-ngx ${serverVersion} speaks API version 9, whose workflow triggers`
    : "This paperless-ngx speaks API version 9, whose workflow triggers";
  const downgraded: Record<string, unknown> = { ...props };

  for (const { prop, field, noun } of SINGLE_VALUED_FILTERS) {
    delete downgraded[prop];
    if (!isFilterSet(props[prop])) continue;
    const ids = idList(props[prop]);
    if (ids.length > 1) {
      throw new PaperlessApiError(
        `${line} match a single ${noun}, not several. Pick one, or leave the ` +
          "filter empty and decide in the workflow.",
        { category: "config" },
      );
    }
    if (ids.length === 1) downgraded[field] = ids[0];
  }

  for (const [prop, label] of Object.entries(FILTERS_ADDED_IN_V10)) {
    if (!isFilterSet(props[prop])) continue;
    throw new PaperlessApiError(
      `${line} have no "${label}" filter — it arrived in paperless-ngx 3.0. ` +
        "Clear it, or filter in the workflow instead.",
      { category: "config" },
    );
  }

  return downgraded;
}

function triggerBody(
  type: number,
  props: Record<string, unknown>,
  apiVersion: number,
  serverVersion?: string,
): Record<string, unknown> {
  const fields =
    apiVersion >= MULTI_VALUED_FILTER_API_VERSION
      ? props
      : downgradeFilters(props, serverVersion);
  const body: Record<string, unknown> = { type };
  const copy = (key: string) => {
    const value = fields[key];
    if (value !== undefined && value !== null && value !== "") {
      body[key] = value;
    }
  };
  copy("filter_filename");
  copy("filter_path");
  copy("matching_algorithm");
  copy("match");
  copy("is_insensitive");
  copy("filter_has_tags");
  copy("filter_has_all_tags");
  copy("filter_has_not_tags");
  // The version 9 spellings, present only after a downgrade.
  copy("filter_has_correspondent");
  copy("filter_has_document_type");
  copy("filter_has_any_correspondents");
  copy("filter_has_not_correspondents");
  copy("filter_has_any_document_types");
  copy("filter_has_not_document_types");
  copy("filter_has_any_storage_paths");
  copy("filter_has_not_storage_paths");
  if (Array.isArray(fields.sources) && fields.sources.length > 0) {
    body.sources = fields.sources;
  }
  return body;
}

/**
 * The same filters as query params, for the reconciliation sweep — which asks
 * the documents endpoint rather than being delivered to, and so is not covered
 * by the filters registered in paperless. Without these the sweep emits every
 * document added since the cursor whatever the trigger was configured to
 * watch, so a filtered trigger fires on everything the moment one webhook
 * delivery is missed.
 *
 * Ids go as one comma-joined value: the `in` lookups split on commas, and
 * repeated params would leave Django reading only the last. A non-integer
 * makes ObjectFilter hand back the queryset untouched, so non-integers are
 * dropped here rather than quietly widening the sweep.
 *
 * `sources`, `match` and `matching_algorithm` have no document-list
 * equivalent; paperless leaves them out of its own scheduled-trigger sweep
 * (`filter_documents`) for the same reason.
 */
function sweepFilters(
  props: Record<string, unknown>,
): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {};
  for (const [prop, param] of Object.entries(SWEEP_FILTERS)) {
    if (!isFilterSet(props[prop])) continue;
    const ids = idList(props[prop]);
    if (ids.length > 0) query[param] = ids.join(",");
  }
  return query;
}

// fnmatch, as paperless applies `filter_filename` — against the original
// filename, case-insensitively. The documents endpoint has no glob lookup
// (CHAR_KWARGS is istartswith/iendswith/icontains/iexact), so the sweep
// matches here instead. Everything but `*`, `?` and a `[set]` is escaped, so
// no pattern can throw on construction.
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      out += ".*";
      continue;
    }
    if (char === "?") {
      out += ".";
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close !== -1) {
        const set = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
        // fnmatch spells negation "!", a regex spells it "^".
        out += `[${set.startsWith("!") ? `^${set.slice(1)}` : set}]`;
        i = close;
        continue;
      }
      // An unclosed "[" is a literal, in fnmatch too.
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

// A row with no filename passes, exactly as it does in matching.py.
function filenameMatches(
  row: Record<string, unknown>,
  pattern: unknown,
): boolean {
  if (typeof pattern !== "string" || pattern === "") return true;
  const name = row.original_file_name;
  if (typeof name !== "string") return true;
  return globToRegExp(pattern).test(name);
}

function actionBody(
  endpoint: string,
  token: string | undefined,
  event: string,
): Record<string, unknown> {
  return {
    // WorkflowActionType.WEBHOOK
    type: 4,
    webhook: {
      url: endpoint,
      // use_params + as_json is the only combination that yields a real JSON
      // object body: with `body` set, as_json JSON-encodes a *string*.
      use_params: true,
      as_json: true,
      params: buildWebhookParams(event),
      ...(token ? { headers: { "X-Powerhouse-Webhook-Token": token } } : {}),
      // Would populate httpx's `files=`, which wins over `json=` in
      // encode_request — the params would vanish and paperless would POST a
      // bare multipart file instead.
      include_document: false,
    },
  };
}

async function preflight(client: PaperlessClient): Promise<UiSettings> {
  const settings = await client.uiSettings();
  if (settings.isSuperuser) return settings;
  const required = ["add_workflow", "change_workflow"];
  const missing = required.filter(
    (permission) => !settings.permissions.includes(permission),
  );
  if (missing.length > 0) {
    throw new PaperlessApiError(
      `The API token's user lacks the ${missing.join(" and ")} permission, so the piece cannot register its webhook. ` +
        "Grant it in paperless (Admin -> Users), or create the workflow by hand: " +
        "a Document Added/Updated trigger plus a Webhook action posting the JSON body this piece would register.",
      { category: "permission" },
    );
  }
  return settings;
}

// A stable, non-secret discriminator so two triggers on the same paperless do
// not share a workflow name. FNV-1a: nothing here needs to resist an attacker,
// only to be the same string on every republish of the same endpoint.
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function readRegistration(value: unknown): Registration | undefined {
  if (!isRecord(value) || typeof value.workflow_id !== "number") {
    return undefined;
  }
  return value as unknown as Registration;
}

export interface DocumentTriggerOptions {
  name: string;
  displayName: string;
  description: string;
  event: "DOCUMENT_ADDED" | "DOCUMENT_UPDATED";
  type: number;
  // Which timestamp the reconciliation sweep walks.
  cursorField: "added" | "modified";
}

export function createDocumentTrigger(options: DocumentTriggerOptions) {
  return createTrigger({
    auth: paperlessAuth,
    name: options.name,
    displayName: options.displayName,
    description: options.description,
    type: TriggerStrategy.WEBHOOK,
    outputSchema: { fields: documentTriggerOutputFields },
    props: {
      filter_filename: Property.ShortText({
        displayName: "Filename filter",
        description: "Wildcards allowed, e.g. *.pdf",
        required: false,
      }),
      sources: Property.StaticMultiSelectDropdown({
        displayName: "Sources",
        description: "Where the document came from. Empty means any source.",
        required: false,
        options: { options: SOURCES },
      }),
      filter_has_tags: objectMultiPicker("tags", {
        displayName: "Has any of these tags",
      }),
      filter_has_all_tags: objectMultiPicker("tags", {
        displayName: "Has all of these tags",
      }),
      filter_has_not_tags: objectMultiPicker("tags", {
        displayName: "Has none of these tags",
      }),
      filter_has_any_correspondents: objectMultiPicker("correspondents", {
        displayName: "Correspondent is any of",
      }),
      filter_has_any_document_types: objectMultiPicker("document_types", {
        displayName: "Document type is any of",
      }),
      filter_has_any_storage_paths: objectMultiPicker("storage_paths", {
        displayName: "Storage path is any of",
      }),
      matching_algorithm: Property.StaticDropdown({
        displayName: "Content matching",
        required: false,
        options: { options: MATCHING },
      }),
      match: Property.ShortText({
        displayName: "Match",
        description: "The words, phrase or expression to match against.",
        required: false,
      }),
      include_content: Property.Checkbox({
        displayName: "Include OCR text",
        description:
          "The full extracted text of every document that fires this trigger. Off by default because it lands in the run journal.",
        required: false,
        defaultValue: false,
      }),
    },

    // Filters live in paperless, so we are never delivered events to discard.
    // Registration is one POST: WorkflowSerializer takes nested triggers and
    // actions, which also means no half-registered leftovers to clean up.
    async onEnable(context) {
      const client = clientFor(context.auth, context.store as StoreLike);
      const { endpoint, token } = splitWebhookUrl(context.webhookUrl);
      assertUsableUrl(endpoint);
      const settings = await preflight(client);
      // preflight's ui_settings call has already negotiated, so this is the
      // version the registration is about to be serialized against.
      const apiVersion = await client.apiVersion();

      const props = context.propsValue as Record<string, unknown>;
      const existing = readRegistration(await context.store.get(STORE_KEY));

      // Named after the endpoint, never the webhookUrl: that carries the
      // delivery token in its fragment, and a slice of its tail would have put
      // 8 characters of the raw credential into a Workflow.name that is
      // visible in the paperless UI and its database.
      const payloadFor = (
        registration: Registration | undefined,
      ): Record<string, unknown> => ({
        name: `Powerhouse: ${options.event.toLowerCase()} (${shortHash(endpoint)})`,
        enabled: true,
        triggers: [
          {
            ...(registration?.trigger_id ? { id: registration.trigger_id } : {}),
            ...triggerBody(options.type, props, apiVersion, settings.serverVersion),
          },
        ],
        actions: [
          {
            ...(registration?.action_id ? { id: registration.action_id } : {}),
            ...actionBody(endpoint, token, options.event),
            ...(registration?.webhook_id
              ? { webhook: { id: registration.webhook_id, ...(actionBody(endpoint, token, options.event).webhook as Record<string, unknown>) } }
              : {}),
          },
        ],
      });

      // update_or_create on the nested ids makes a republish an in-place
      // update — which is also how a rotated token reaches paperless.
      let response: { data: Record<string, unknown> } | undefined;
      if (existing) {
        try {
          response = await client.request<Record<string, unknown>>({
            method: "PATCH",
            path: `workflows/${existing.workflow_id}/`,
            json: payloadFor(existing),
          });
        } catch (error) {
          // Someone deleted the workflow in the paperless UI. Without this the
          // PATCH 404s on every retry forever, because onEnable's error leaves
          // the stale registration in the store for the next attempt to reuse.
          // The nested ids go with it — they belonged to that workflow.
          if (
            !(error instanceof PaperlessApiError) ||
            error.category !== "not_found"
          ) {
            throw error;
          }
        }
      }
      response ??= await client.request<Record<string, unknown>>({
        method: "POST",
        path: "workflows/",
        json: payloadFor(undefined),
      });

      const workflow = response.data;
      const trigger = Array.isArray(workflow.triggers)
        ? (workflow.triggers[0] as Record<string, unknown> | undefined)
        : undefined;
      const action = Array.isArray(workflow.actions)
        ? (workflow.actions[0] as Record<string, unknown> | undefined)
        : undefined;
      const webhook = isRecord(action?.webhook) ? action.webhook : undefined;

      await context.store.put(STORE_KEY, {
        workflow_id: workflow.id,
        trigger_id: trigger?.id,
        action_id: action?.id,
        webhook_id: webhook?.id,
        url: endpoint,
      } satisfies Record<string, unknown>);

      // Anything already in the archive is not this trigger's business; the
      // sweep starts from now.
      if (!existing) {
        await context.store.put(CURSOR_KEY, new Date().toISOString());
      }
    },

    async onDisable(context) {
      const registration = readRegistration(await context.store.get(STORE_KEY));
      if (!registration) return;
      const client = clientFor(context.auth, context.store as StoreLike);
      // The workflow's triggers and actions are M2M, so deleting the workflow
      // leaves them behind; each delete tolerates a 404 because a user may
      // have removed them by hand.
      const paths = [
        `workflows/${registration.workflow_id}/`,
        registration.action_id
          ? `workflow_actions/${registration.action_id}/`
          : undefined,
        registration.trigger_id
          ? `workflow_triggers/${registration.trigger_id}/`
          : undefined,
      ].filter((path): path is string => path !== undefined);
      for (const path of paths) {
        try {
          await client.request({ method: "DELETE", path });
        } catch (error) {
          if (
            error instanceof PaperlessApiError &&
            error.category === "not_found"
          ) {
            continue;
          }
          throw error;
        }
      }
      await context.store.put(STORE_KEY, null);
    },

    // Two jobs in one hook. With a payload it is a webhook delivery: hydrate
    // the document the id points at. Without one it is the reconciliation
    // sweep, which is what makes the trigger survive paperless dropping a
    // delivery — a transport error or a response slower than its 5s timeout is
    // never retried (autoretry_for covers HTTPStatusError only), so the
    // webhook alone would lose events silently.
    async run(context) {
      const client = clientFor(context.auth, context.store as StoreLike);
      const props = context.propsValue as Record<string, unknown>;
      const includeContent = props.include_content === true;
      const payload = context.payload as WebhookPayload | undefined;
      const docId = readDocId(payload);

      if (docId !== undefined) {
        const document = await client.request<Record<string, unknown>>({
          path: `documents/${docId}/`,
        });
        return [emit(document.data, options.event, includeContent)];
      }

      const cursorValue = await context.store.get(CURSOR_KEY);
      const cursor =
        typeof cursorValue === "string" ? cursorValue : new Date(0).toISOString();
      const query: Record<string, QueryValue> = {
        [`${options.cursorField}__gt`]: cursor,
        ordering: options.cursorField,
        page_size: 100,
        ...sweepFilters(props),
      };
      const rows = await client.listAll<Record<string, unknown>>(
        "documents/",
        query,
        200,
      );
      // Compared as instants, not strings. DRF renders datetimes in the
      // server's TIME_ZONE, so a paperless configured off UTC answers
      // "2026-09-09T04:00:00-05:00" while the seeded cursor is a "Z" string —
      // and lexically that offset form sorts *below* the cursor, which would
      // pin the cursor forever and re-emit the same rows on every sweep.
      const newest = rows.reduce<string>((latest, row) => {
        const value = row[options.cursorField];
        if (typeof value !== "string") return latest;
        return Date.parse(value) > Date.parse(latest) ? value : latest;
      }, cursor);
      await context.store.put(CURSOR_KEY, newest);
      return rows
        .filter((row) => filenameMatches(row, props.filter_filename))
        .map((row) => emit(row, options.event, includeContent));
    },

    // Design-time sample: the newest document, shaped exactly as a delivery.
    async test(context) {
      const client = clientFor(context.auth, context.store as StoreLike);
      const rows = await client.listAll<Record<string, unknown>>(
        "documents/",
        { ordering: `-${options.cursorField}`, page_size: 1 },
        1,
      );
      const includeContent =
        (context.propsValue as { include_content?: boolean }).include_content ===
        true;
      return rows.map((row) => emit(row, options.event, includeContent));
    },

    sampleData: {},
  });
}

// `modified` in the key is what lets a genuine second edit through while a
// paperless retry of the same event is suppressed: the supervisor claims
// _dedupe_key for 30s, which covers the celery retry window.
function emit(
  document: Record<string, unknown>,
  event: string,
  includeContent: boolean,
): Record<string, unknown> {
  const trimmed = trimContent(document, includeContent);
  const id = typeof document.id === "number" ? document.id : "unknown";
  const modified =
    typeof document.modified === "string" ? document.modified : "";
  return {
    ...trimmed,
    event,
    _dedupe_key: `${id}:${event}:${modified}`,
  };
}

export const newDocument = createDocumentTrigger({
  name: "new_document",
  displayName: "New document",
  description:
    "Fires when paperless-ngx finishes adding a document, with the server-side filters applied.",
  event: "DOCUMENT_ADDED",
  type: TRIGGER_TYPE.DOCUMENT_ADDED,
  cursorField: "added",
});

export const documentUpdated = createDocumentTrigger({
  name: "document_updated",
  displayName: "Document updated",
  description: "Fires when a document's metadata or content changes.",
  event: "DOCUMENT_UPDATED",
  type: TRIGGER_TYPE.DOCUMENT_UPDATED,
  cursorField: "modified",
});
