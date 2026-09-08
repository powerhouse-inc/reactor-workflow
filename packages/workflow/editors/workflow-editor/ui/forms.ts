// Form descriptors driving property panels; pure data, mirrors the
// ConnectorPropDescriptor shape from reactor-connectors.

export interface BlockFormProp {
  name: string;
  displayName: string;
  type: string;
  required: boolean;
  defaultValue?: unknown;
  staticOptions?: { label: string; value: unknown }[];
  hasDynamicResolver?: boolean;
  description?: string;
  placeholder?: string;
  // Sibling prop names whose values feed the resolver; a change re-runs it.
  refreshers?: string[];
  // Nested shape: ARRAY item fields, or what a DYNAMIC resolver produced.
  properties?: BlockFormProp[];
}

export interface BlockForm {
  title: string;
  requireAuth: boolean;
  // Whether the block takes a connection: none hides the field entirely.
  auth?: "none" | "optional" | "required";
  props: BlockFormProp[];
  // Piece triggers only: POLLING | WEBHOOK | APP_WEBHOOK. WEBHOOK triggers
  // are fed by a request, so the panel shows their endpoint URL.
  triggerStrategy?: string;
}

export interface ConnectionSummary {
  id: string;
  name: string;
  connectorId: string;
  authType: string;
  status: string;
  accountLabel: string | null;
}

export interface SecretStat {
  ref: string;
  label: string | null;
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// Minting seam for PH_SECRET_REF props: the field takes a value and the
// document only ever receives the ref that comes back.
export interface SecretFormService {
  save: (input: {
    ref?: string;
    value: string;
    label: string;
  }) => Promise<SecretStat>;
  stat: (ref: string) => Promise<SecretStat | null>;
}

export interface WebhookEndpoint {
  workflowId: string;
  url: string;
  armed: boolean;
  createdAt: string;
}

export interface DesignTimeService {
  getBlockForm: (blockType: string) => Promise<BlockForm | null>;
  loadOptions: (
    blockType: string,
    propName: string,
    input: Record<string, unknown>,
    connectionId?: string,
  ) => Promise<unknown>;
  // Runs the current workflow's piece trigger test hook; sample items back.
  testTrigger?: () => Promise<unknown>;
  // The current workflow's webhook endpoint, for core#webhook triggers.
  webhookEndpoint?: () => Promise<WebhookEndpoint | null>;
  // Backs PH_SECRET_REF props; absent when the runtime refuses secret writes.
  secrets?: SecretFormService;
  // powerhouse/connection documents for the connection picker.
  listConnections?: () => Promise<ConnectionSummary[]>;
  // Drops the cached listing after the picker creates a connection.
  refreshConnections?: () => void;
}

// Ours, not the piece's: the reactor's poll cadence for a piece trigger.
// Appended to every piece trigger's form; see splitPollInterval in the runtime.
export const POLL_INTERVAL_PROP: BlockFormProp = {
  name: "pollEverySeconds",
  displayName: "Poll every (seconds)",
  type: "NUMBER",
  required: false,
  description:
    "How often the reactor checks this trigger; 60 at the least. Omit to follow the piece's own cadence.",
};

const text = (
  name: string,
  displayName: string,
  required = false,
  description?: string,
): BlockFormProp => ({
  name,
  displayName,
  type: "SHORT_TEXT",
  required,
  description,
});

// Reactor-backed autocomplete: options load from the runtime subgraph.
const autocomplete = (
  name: string,
  displayName: string,
  required = false,
  description?: string,
): BlockFormProp => ({
  name,
  displayName,
  type: "PH_AUTOCOMPLETE",
  required,
  description,
  hasDynamicResolver: true,
});

// Action list whose action types adapt to the target document type.
const documentActions = (
  displayName: string,
  required = false,
  description?: string,
): BlockFormProp => ({
  name: "actions",
  displayName,
  type: "PH_ACTIONS",
  required,
  description,
  hasDynamicResolver: true,
});

// Takes a secret VALUE and commits only the minted ref, the way the
// connection editor's SecretField does; the document never holds the value.
const secretRef = (
  name: string,
  displayName: string,
  required = false,
  description?: string,
): BlockFormProp => ({
  name,
  displayName,
  type: "PH_SECRET_REF",
  required,
  description,
});

const number = (
  name: string,
  displayName: string,
  required = false,
  description?: string,
): BlockFormProp => ({
  name,
  displayName,
  type: "NUMBER",
  required,
  description,
});

const dropdown = (
  name: string,
  displayName: string,
  options: { label: string; value: unknown }[],
  required = false,
  description?: string,
): BlockFormProp => ({
  name,
  displayName,
  type: "STATIC_DROPDOWN",
  required,
  description,
  staticOptions: options,
});

// Hand-written forms for core blocks and triggers.
export const CORE_FORMS: Record<string, BlockForm> = {
  "core#manual": {
    title: "Manual trigger",
    requireAuth: false,
    auth: "none",
    props: [],
  },
  "core#schedule": {
    title: "Schedule",
    requireAuth: false,
    auth: "none",
    props: [
      dropdown(
        "mode",
        "Mode",
        [
          { label: "Cron expression", value: "cron" },
          { label: "Fixed interval", value: "interval" },
        ],
        true,
      ),
      text(
        "cron",
        "Cron expression",
        false,
        "Five fields, e.g. 0 9 * * 1-5 (09:00 on weekdays); cron mode only",
      ),
      number(
        "every",
        "Every",
        false,
        "Interval mode only; at least one minute",
      ),
      dropdown("unit", "Unit", [
        { label: "Minutes", value: "minutes" },
        { label: "Hours", value: "hours" },
        { label: "Days", value: "days" },
      ]),
      text(
        "timezone",
        "Timezone",
        false,
        "IANA name, e.g. Europe/Lisbon; defaults to UTC",
      ),
    ],
  },
  "core#webhook": {
    title: "Webhook",
    requireAuth: false,
    auth: "none",
    props: [
      dropdown(
        "methods",
        "Method",
        [
          { label: "POST", value: "POST" },
          { label: "Any", value: "ANY" },
          { label: "GET", value: "GET" },
          { label: "PUT", value: "PUT" },
          { label: "PATCH", value: "PATCH" },
          { label: "DELETE", value: "DELETE" },
        ],
        true,
      ),
      dropdown(
        "scheme",
        "Verification",
        [
          { label: "None (token in the URL only)", value: "none" },
          { label: "Shared token header", value: "token" },
          { label: "HMAC-SHA256 hex", value: "hmac-sha256" },
          { label: "GitHub (sha256=…)", value: "github" },
          { label: "Stripe (t=…,v1=…)", value: "stripe" },
        ],
        true,
        "Everything but None needs a signing secret",
      ),
      secretRef(
        "secretRef",
        "Signing secret",
        false,
        "The provider's signing secret; only the minted ref is stored",
      ),
      text(
        "header",
        "Signature header",
        false,
        "Defaults per scheme: x-webhook-token, x-signature, x-hub-signature-256, stripe-signature",
      ),
      number(
        "toleranceSeconds",
        "Replay window (seconds)",
        false,
        "Stripe only; rejects timestamps older than this. Default 300",
      ),
      text(
        "dedupeField",
        "Event id field",
        false,
        "Body field holding the provider's event id; a redelivery is then accepted without a second run",
      ),
      number(
        "dedupeTtlSeconds",
        "Dedupe window (seconds)",
        false,
        "How long an event id is remembered. Default 300",
      ),
      text(
        "challengeField",
        "Challenge field",
        false,
        "Echo this query param or body field back instead of running, for endpoint verification (e.g. challenge, hub.challenge)",
      ),
      dropdown(
        "responseMode",
        "Response",
        [
          { label: "Answer immediately (202)", value: "async" },
          { label: "Wait for the run (200)", value: "sync" },
        ],
        false,
        "Waiting holds the provider's socket for the whole run",
      ),
      number(
        "responseStatus",
        "Success status",
        false,
        "Status returned on acceptance. Default 202 async, 200 sync",
      ),
    ],
  },
  "core#document-event": {
    title: "Document event",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete(
        "documentType",
        "Document type",
        false,
        "e.g. powerhouse/connection",
      ),
      autocomplete(
        "documentId",
        "Document id",
        false,
        "Omit to match any document",
      ),
      autocomplete(
        "actionType",
        "Action type",
        false,
        "Omit to match any action",
      ),
    ],
  },
  "core#document-created": {
    title: "Document created",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete(
        "documentType",
        "Document type",
        false,
        "Type of the created document; omit to match any",
      ),
      autocomplete(
        "driveId",
        "Drive",
        false,
        "Omit to match documents outside every drive too",
      ),
    ],
  },
  "core#document-deleted": {
    title: "Document deleted",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete(
        "documentType",
        "Document type",
        false,
        "Type of the deleted document; omit to match any",
      ),
      autocomplete(
        "driveId",
        "Drive",
        false,
        "Omit to match documents outside every drive too",
      ),
    ],
  },
  "core#branch": {
    title: "Branch",
    requireAuth: false,
    auth: "none",
    props: [
      text(
        "condition",
        "Condition",
        true,
        "e.g. {{steps.fetch.output.body.ok}}",
      ),
      text(
        "equals",
        "Equals",
        false,
        "Take the true port only when the condition matches this; omit for truthiness",
      ),
    ],
  },
  "core#assert": {
    title: "Assert",
    requireAuth: false,
    auth: "none",
    props: [
      text(
        "value",
        "Value",
        true,
        "e.g. {{steps.describe.output}} - the run fails when it is blank",
      ),
      {
        name: "rejectValues",
        displayName: "Rejected values",
        type: "ARRAY",
        required: false,
        description:
          "One per line; the run fails when the value matches any of them",
      },
      {
        name: "allowValues",
        displayName: "Allowed values",
        type: "ARRAY",
        required: false,
        description:
          "One per line; when set, anything else fails. Safer than a reject list for model output",
      },
      {
        name: "allowEmpty",
        displayName: "Allow empty",
        type: "CHECKBOX",
        required: false,
        description: "Accept a blank value instead of failing",
      },
      text("message", "Failure message", false, "Replaces the default error"),
    ],
  },
  "core#document-create": {
    title: "Create document",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete("documentType", "Document type", false),
      text("name", "Document name"),
      text("parentId", "Parent drive/folder id"),
      documentActions("Initial actions"),
      text(
        "payload",
        "Payload",
        false,
        "JSON {documentType, name, actions?}, e.g. {{steps.draft.output}}",
      ),
    ],
  },
  "core#document-dispatch": {
    title: "Dispatch actions",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete(
        "documentId",
        "Document id",
        true,
        "e.g. {{steps.create.output.documentId}}",
      ),
      autocomplete(
        "documentType",
        "Document type",
        false,
        "Design-time hint when the document id is an expression",
      ),
      documentActions("Actions", true),
      text(
        "allowedActions",
        "Allowed action types",
        false,
        "Comma-separated whitelist; enforced when set",
      ),
    ],
  },
  "core#document-get": {
    title: "Get document",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete(
        "documentId",
        "Document id",
        true,
        "e.g. {{steps.find.output.documents.0.documentId}}",
      ),
      autocomplete(
        "documentType",
        "Document type",
        false,
        "Design-time hint when the document id is an expression",
      ),
    ],
  },
  "core#document-find": {
    title: "Find documents",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete("documentType", "Document type", false, "Omit for any type"),
      autocomplete(
        "parentId",
        "In drive/folder",
        false,
        "Omit for the whole reactor",
      ),
      text("name", "Name contains", false, "Case-insensitive match"),
      text("limit", "Max results", false, "Defaults to 25"),
    ],
  },
  "core#document-types": {
    title: "List document types",
    requireAuth: false,
    auth: "none",
    props: [],
  },
  "core#document-schema": {
    title: "Get document schema",
    requireAuth: false,
    auth: "none",
    props: [
      autocomplete(
        "documentType",
        "Document type",
        false,
        "Required unless a document id is given",
      ),
      autocomplete(
        "documentId",
        "Document id",
        false,
        "Resolves the type from this document instead",
      ),
      autocomplete(
        "actionType",
        "Only this action",
        false,
        "Omit to list every action",
      ),
    ],
  },
};
