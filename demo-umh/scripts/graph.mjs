// The workflow that replaces the `umh-order-poller` processor, as data.
//
// Kept apart from the seeding so it can be run against the engine directly:
// test/workflow-graph.test.mjs feeds it a real trigger payload and asserts what
// reaches the ledger. The shape is both the document actions the seed
// dispatches and the engine's own WorkflowDefinition, which is why the test can
// hand it straight to runWorkflow.
import { randomUUID } from "node:crypto";

export const LEDGER_TYPE = "umh/production-ledger";
export const UMH_PIECE = "@powerhousedao/piece-umh";
export const PAPERLESS_PIECE = "@powerhousedao/piece-paperless-ngx";
// The package, and the version-pinned form its block types carry.
//
// A connection stores the PACKAGE: the runtime checks a step's piece against
// its connection's connectorId (packageFromConnectorId strips a "#suffix" and
// nothing else), so a version in there never matches and the step is refused
// its credential — "Connection is not available to this block".
export const OPENROUTER_PIECE = "@activepieces/piece-open-router";
export const OPENROUTER_PINNED = `${OPENROUTER_PIECE}@0.2.0`;
export const REACTOR_PIECE = "@powerhousedao/piece-reactor";

// Package pieces carry no version in a block type: the copy this reactor
// installed is the one that runs, so a workflow naming it survives an upgrade
// (subgraphs/workflow-runtime/local-catalog.ts).
export const TRIGGER_BLOCK = `${UMH_PIECE}#trigger:order_progressed`;
export const FIND_BLOCK = `${REACTOR_PIECE}#document-find`;
export const DISPATCH_BLOCK = `${REACTOR_PIECE}#document-dispatch`;
export const NEW_DOCUMENT_BLOCK = `${PAPERLESS_PIECE}#trigger:new_document`;
export const GET_FILE_BLOCK = `${PAPERLESS_PIECE}#get_document_file`;
export const SCHEMA_BLOCK = `${REACTOR_PIECE}#document-schema`;
export const CREATE_BLOCK = `${REACTOR_PIECE}#document-create`;
export const ASK_LLM_BLOCK = `${OPENROUTER_PINNED}#ask-lmm`;

// The workflow that replaces the processor.
//
//   order progressed ─▶ counted? ─true─▶ find the bound ledger ─▶ open? ─true─▶ snapshot
//
// Two guards, and each one is load-bearing:
//
// `counted` is the piece's own flag for "the floor has counted something".
// Without it the first firing of every order — the PENDING -> RUNNING
// transition, with nothing produced — would write an empty reading at the head
// of the trail, and the ledger's `qualityPct` is non-null, so it would have to
// be given a quality nobody measured.
//
// `open` is the binding the processor did in code: a ledger that is not OPEN
// has either not frozen its baseline yet or has already closed out, and
// evidence appended outside that window is evidence against a commitment that
// was not in force.
export function floorWorkflowGraph(connectionId) {
  const triggerId = randomUUID();
  const counted = randomUUID();
  const find = randomUUID();
  const open = randomUUID();
  const snapshot = randomUUID();
  return {
    trigger: {
      id: triggerId,
      blockType: TRIGGER_BLOCK,
      connectionId,
      config: {
        include_oee: true,
        // Ours, not the piece's: the runtime lifts it out of the config and
        // floors it at 60s (MIN_SCHEDULE_INTERVAL_MS).
        pollEverySeconds: 60,
      },
    },
    steps: [
      {
        id: counted,
        key: "counted",
        name: "Has the floor counted anything?",
        blockType: "core#branch",
        config: { condition: "{{trigger.payload.counted}}" },
        position: { x: 320, y: 0 },
      },
      {
        id: find,
        key: "ledger",
        name: "Find the ledger bound to this order",
        blockType: FIND_BLOCK,
        config: {
          documentType: LEDGER_TYPE,
          // The index cannot query state, so the host matches within the page
          // it read; 100 is its cap.
          matchPath: "orderId",
          matchValue: "{{trigger.payload.orderId}}",
          includeState: true,
          limit: 100,
        },
        position: { x: 640, y: 0 },
      },
      {
        id: open,
        key: "open",
        name: "Is that ledger OPEN?",
        blockType: "core#branch",
        config: {
          condition: "{{steps.ledger.output.documents.0.state.status}}",
          equals: "OPEN",
        },
        position: { x: 960, y: 0 },
      },
      {
        id: snapshot,
        key: "snapshot",
        name: "Append the evidence snapshot",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{steps.ledger.output.documents.0.documentId}}",
          documentType: LEDGER_TYPE,
          // Enforced by the step, not merely suggested: this workflow appends
          // evidence and must not be able to do anything else to the ledger.
          allowedActions: "RECORD_ACTUALS_SNAPSHOT",
          actions: [
            {
              type: "RECORD_ACTUALS_SNAPSHOT",
              input: {
                // Derived rather than random, so replaying a delivery writes
                // the same snapshot id — and the reducer rejects a duplicate
                // instead of appending the same reading twice.
                id: "{{trigger.payload.orderId}}-{{trigger.payload.capturedAt}}",
                capturedAt: "{{trigger.payload.capturedAt}}",
                quantityCompleted: "{{trigger.payload.quantityCompleted}}",
                quantityScrap: "{{trigger.payload.quantityScrap}}",
                // Guaranteed a number by the `counted` guard above.
                qualityPct: "{{trigger.payload.qualityPct}}",
                oeePct: "{{trigger.payload.oeePct}}",
                availabilityPct: "{{trigger.payload.availabilityPct}}",
                performancePct: "{{trigger.payload.performancePct}}",
                floorStatus: "{{trigger.payload.lifecycle}}",
                floorStatusRaw: "{{trigger.payload.statusRaw}}",
                floorCompletedAt: "{{trigger.payload.closedAt}}",
              },
            },
          ],
        },
        position: { x: 1280, y: 0 },
      },
    ],
    edges: [
      { id: randomUUID(), from: triggerId, to: counted, port: "next" },
      { id: randomUUID(), from: counted, to: find, port: "true" },
      { id: randomUUID(), from: find, to: open, port: "next" },
      { id: randomUUID(), from: open, to: snapshot, port: "true" },
    ],
  };
}


// What the extractor is told. Lifted in substance from the processor this
// replaces (its SYSTEM_PROMPT and the demo's mapping instructions), because the
// rules in it were learned from real scans rather than reasoned about:
//
// - the model's own schema and operation list are handed over at run time by
//   the step before this one, so the prompt cannot drift from the document
//   model the way a hardcoded field list would;
// - OCR text is noisy, and repairing an obvious mis-scan beats refusing;
// - never invent a value — an absent field is absent, and a ledger is a
//   contract;
// - and the human gate: the extractor fills the commitment and stops. A
//   reviewer approves, opens and signs. That last rule is also enforced by the
//   step that dispatches these actions, which accepts SET_COMMITMENT and
//   nothing else, so a model that ignores the instruction still cannot open a
//   ledger.
const EXTRACTION_PROMPT = [
  "You convert OCR text from a scanned purchase order into actions on a Powerhouse document.",
  "",
  "The target document model is umh/production-ledger. Its state schema:",
  "{{steps.model.output.stateSchema}}",
  "",
  "The one operation you may use, with its GraphQL input schema:",
  "{{steps.model.output.actions}}",
  "",
  "The scanned document:",
  "Title: {{trigger.payload.title}}",
  "Created: {{trigger.payload.created}}",
  "OCR text:",
  "{{trigger.payload.content}}",
  "",
  "Respond with a single JSON object and nothing else — no prose, no markdown fences:",
  '{"actions": [{"type": "SET_COMMITMENT", "input": { ... }}]}',
  "",
  "Rules:",
  "- Use SET_COMMITMENT and nothing else. Never approve, open, start, close or sign:",
  "  a human reviews this draft, and the ledger locks its commitment once opened.",
  "- The input must conform to SetCommitmentInput above. Omit every field you have",
  "  no data for. Never invent a value.",
  "- Dates are full ISO 8601 UTC, e.g. 2026-09-30T00:00:00.000Z. Currency is an ISO",
  "  4217 code such as EUR. Amounts are plain JSON numbers.",
  "- Quantities are integers.",
  "- OCR text is noisy (\"fiir\" is \"für\", \"MusterstraBe\" is \"Musterstraße\"):",
  "  repair an obvious mis-scan when the intent is clear.",
  "- Leave orderId unset. Nothing has been dispatched to the floor yet; a reviewer",
  "  approves the ledger and that is what creates the order.",
].join("\n");

// The workflow that replaces the `paperless-sync` processor.
//
//   new document ─▶ purchase order? ─true─▶ read the model ─▶ extract
//                                              ─▶ draft ─▶ commitment ─▶ fetch scan ─▶ attach
//
// The processor did this with an engine: an LLM client, an import store, a
// safe-merge, a paperless client and a docling client. The same result here is
// seven blocks, and three of them are the reactor's own.
//
// Why the draft and the commitment are separate steps: `document-create` will
// dispatch the actions in a payload, but only `document-dispatch` enforces an
// allow-list. Creating the document empty and dispatching into it is what makes
// "SET_COMMITMENT and nothing else" a rule rather than a request, which matters
// when the actions were written by a model.
export function purchaseOrderWorkflowGraph({
  paperlessConnectionId,
  aiConnectionId,
  ledgerDriveId,
  documentTypeId,
  model,
}) {
  const triggerId = randomUUID();
  const kind = randomUUID();
  const schema = randomUUID();
  const extract = randomUUID();
  const draft = randomUUID();
  const commit = randomUUID();
  const file = randomUUID();
  const attach = randomUUID();
  return {
    trigger: {
      id: triggerId,
      blockType: NEW_DOCUMENT_BLOCK,
      connectionId: paperlessConnectionId,
      config: {
        // The piece sends paperless 3.x's `filter_has_any_document_types`,
        // and this demo pins 2.18.4, whose trigger field is the singular
        // `filter_has_document_type`. Paperless accepts the unknown field and
        // ignores it, so the delivery is NOT filtered at the source here — the
        // guard below is what actually decides. Kept anyway: on 3.x it is the
        // filter, and it costs nothing where it is ignored.
        ...(documentTypeId ? { filter_has_any_document_types: [documentTypeId] } : {}),
        // The OCR text is the input to the extraction; without this the
        // trigger omits it, and it is usually the largest field paperless has.
        include_content: true,
      },
    },
    steps: [
      {
        id: kind,
        key: "purchase_order",
        name: "Is it a purchase order?",
        blockType: "core#branch",
        config: {
          condition: "{{trigger.payload.document_type}}",
          // Compared as text: every expression resolves to a string, and the
          // branch normalises both sides before comparing.
          equals: documentTypeId === undefined ? "" : String(documentTypeId),
        },
        position: { x: 320, y: 0 },
      },
      {
        id: schema,
        key: "model",
        name: "Read the ledger's own schema",
        blockType: SCHEMA_BLOCK,
        config: {
          documentType: LEDGER_TYPE,
          // Narrowed to the one operation the extractor may use. The whole
          // list is eleven operations of GraphQL input schema, most of which
          // exist to close out or sign a ledger — sending them invites a model
          // to reach for one, and makes the prompt several times larger than
          // the document it is reading.
          actionType: "SET_COMMITMENT",
        },
        position: { x: 640, y: 0 },
      },
      {
        id: extract,
        key: "extract",
        name: "Extract the commitment",
        blockType: ASK_LLM_BLOCK,
        connectionId: aiConnectionId,
        config: { model, prompt: EXTRACTION_PROMPT, temperature: 0 },
        // The host's default is 30s, and a model reading a page of OCR and
        // answering with JSON regularly takes longer — especially a large one
        // behind a router that may queue the request.
        timeoutSeconds: 180,
        position: { x: 960, y: 0 },
      },
      {
        id: draft,
        key: "draft",
        name: "Create the draft ledger",
        blockType: CREATE_BLOCK,
        config: {
          documentType: LEDGER_TYPE,
          parentId: ledgerDriveId,
          // The scan's own title, not the model's: a reviewer looking for this
          // ledger is looking for the purchase order it came from.
          name: "{{trigger.payload.title}}",
        },
        position: { x: 1280, y: 0 },
      },
      {
        id: commit,
        key: "commitment",
        name: "Apply the extracted commitment",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{steps.draft.output.documentId}}",
          documentType: LEDGER_TYPE,
          // The gate, enforced rather than requested.
          allowedActions: "SET_COMMITMENT",
          actions: "{{steps.extract.output}}",
        },
        position: { x: 1600, y: 0 },
      },
      {
        id: file,
        key: "scan",
        name: "Fetch the original scan",
        blockType: GET_FILE_BLOCK,
        connectionId: paperlessConnectionId,
        config: {
          id: "{{trigger.payload.id}}",
          // The archived copy is the OCR'd PDF; it is what a reviewer wants to
          // read beside the extraction.
          variant: "archive",
        },
        position: { x: 1920, y: 0 },
      },
      {
        id: attach,
        key: "attach",
        name: "Attach the scan to the ledger",
        blockType: DISPATCH_BLOCK,
        config: {
          documentId: "{{steps.draft.output.documentId}}",
          documentType: LEDGER_TYPE,
          allowedActions: "SET_SOURCE_DOCUMENT",
          actions: [
            {
              type: "SET_SOURCE_DOCUMENT",
              input: {
                // An attachment reference, not bytes: the file lives in the
                // attachment store and only the reference enters the journal.
                sourceDocument: "{{steps.scan.output.ref}}",
                fileName: "{{steps.scan.output.filename}}",
              },
            },
          ],
        },
        position: { x: 2240, y: 0 },
      },
    ],
    edges: [
      { id: randomUUID(), from: triggerId, to: kind, port: "next" },
      { id: randomUUID(), from: kind, to: schema, port: "true" },
      { id: randomUUID(), from: schema, to: extract, port: "next" },
      { id: randomUUID(), from: extract, to: draft, port: "next" },
      { id: randomUUID(), from: draft, to: commit, port: "next" },
      { id: randomUUID(), from: commit, to: file, port: "next" },
      { id: randomUUID(), from: file, to: attach, port: "next" },
    ],
  };
}
