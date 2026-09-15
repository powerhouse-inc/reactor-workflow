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
export const REACTOR_PIECE = "@powerhousedao/piece-reactor";

// Package pieces carry no version in a block type: the copy this reactor
// installed is the one that runs, so a workflow naming it survives an upgrade
// (subgraphs/workflow-runtime/local-catalog.ts).
export const TRIGGER_BLOCK = `${UMH_PIECE}#trigger:order_progressed`;
export const FIND_BLOCK = `${REACTOR_PIECE}#document-find`;
export const DISPATCH_BLOCK = `${REACTOR_PIECE}#document-dispatch`;

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
