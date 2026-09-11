import {
  createTrigger,
  Property,
  TriggerStrategy,
} from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import type { PaperlessClient, QueryValue } from "../common/client";
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

// `docId` from the older GraphQL ingress, `doc_id` from a paperless param,
// which substitutes placeholders as strings.
function readDocId(payload: WebhookPayload | undefined): number | undefined {
  const raw = payload?.docId ?? payload?.doc_id;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return Number(raw.trim());
  }
  return undefined;
}

function triggerBody(
  type: number,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { type };
  const copy = (key: string) => {
    const value = props[key];
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
  copy("filter_has_any_correspondents");
  copy("filter_has_not_correspondents");
  copy("filter_has_any_document_types");
  copy("filter_has_not_document_types");
  copy("filter_has_any_storage_paths");
  copy("filter_has_not_storage_paths");
  if (Array.isArray(props.sources) && props.sources.length > 0) {
    body.sources = props.sources;
  }
  return body;
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

async function preflight(client: PaperlessClient): Promise<void> {
  const settings = await client.uiSettings();
  if (settings.isSuperuser) return;
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
      await preflight(client);

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
            ...triggerBody(options.type, props),
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
      const props = context.propsValue as { include_content?: boolean };
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
      return rows.map((row) => emit(row, options.event, includeContent));
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
