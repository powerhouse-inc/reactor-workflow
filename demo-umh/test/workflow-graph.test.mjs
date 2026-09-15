// What the demo's floor workflow actually does with a real trigger payload.
//
// The graph is run through the engine's own coordinator, with the piece blocks
// faked: this is about the routing and the expressions — which guard stops
// what, and exactly what reaches the ledger — rather than about the pieces,
// which have their own suites.
//
// The payload below is a capture from a running simulator, not a fixture
// written to suit the assertions.
import {
  CompositeBlockExecutor,
  runWorkflow,
} from "@powerhousedao/reactor-connectors";
import { describe, expect, it } from "vitest";
import {
  DISPATCH_BLOCK,
  FIND_BLOCK,
  floorWorkflowGraph,
} from "../scripts/graph.mjs";

const LIVE_ITEM = {
  orderId: "338a473c-6810-4082-b206-00147eaccacf",
  partNumber: "FRAME-WELD-A",
  line: "automotive-welding-1",
  plannedQuantity: 30,
  quantityCompleted: 12,
  quantityScrap: 1,
  qualityPct: 92.3,
  availabilityPct: 100,
  performancePct: 85.8,
  oeePct: 79.2,
  bottleneckMachine: "automotive-welding-1-stage-4",
  statusRaw: "IN_PROGRESS",
  startedAt: "2026-09-15T09:13:25.168Z",
  closedAt: null,
  capturedAt: "2026-09-15T09:14:43.433Z",
  lifecycle: "RUNNING",
  counted: true,
  changed: { good: true, scrap: false, status: false },
  previous: { good_qty: 9, scrap_qty: 1, status: "IN_PROGRESS" },
};

// Answers the two reactor blocks the graph uses and records what they were
// asked. It is wrapped in the engine's CompositeBlockExecutor, exactly as the
// runtime wraps the piece executor, so `core#branch` is the real one: routing
// is the thing under test, and a fake branch would prove nothing.
function fakeExecutor(ledgers) {
  const calls = [];
  return {
    calls,
    handles: () => true,
    execute(execution) {
      calls.push(execution);
      if (execution.blockType === FIND_BLOCK) {
        return Promise.resolve({
          output: { count: ledgers.length, documents: ledgers },
        });
      }
      if (execution.blockType === DISPATCH_BLOCK) {
        return Promise.resolve({ output: { applied: 1 } });
      }
      return Promise.resolve({ output: {} });
    },
  };
}

function ledger(status, documentId = "ledger-1") {
  return {
    documentId,
    documentType: "umh/production-ledger",
    name: "Brenner GmbH - FRAME-WELD-A",
    state: { status, orderId: LIVE_ITEM.orderId },
  };
}

async function run(payload, ledgers) {
  const executor = fakeExecutor(ledgers);
  const result = await runWorkflow({
    definition: floorWorkflowGraph("connection-1"),
    executor: new CompositeBlockExecutor(executor),
    triggerPayload: payload,
  });
  const dispatched = executor.calls.find(
    (call) => call.blockType === DISPATCH_BLOCK,
  );
  return { result, executor, dispatched };
}

describe("the floor workflow", () => {
  it("appends exactly one snapshot when an OPEN ledger is bound to the order", async () => {
    const { dispatched } = await run(LIVE_ITEM, [ledger("OPEN")]);

    expect(dispatched).toBeDefined();
    expect(dispatched.config.documentId).toBe("ledger-1");
    // Enforced by the step, so this workflow cannot do anything else to a
    // ledger even if its action list were wrong.
    expect(dispatched.config.allowedActions).toBe("RECORD_ACTUALS_SNAPSHOT");
    expect(dispatched.config.actions).toHaveLength(1);
    expect(dispatched.config.actions[0].type).toBe("RECORD_ACTUALS_SNAPSHOT");
  });

  it("carries the floor's numbers as numbers, not as text", async () => {
    // A whole-string expression yields the raw value; the ledger's schema types
    // these as Int! and Float!, and "12" is not an Int.
    const { dispatched } = await run(LIVE_ITEM, [ledger("OPEN")]);
    const input = dispatched.config.actions[0].input;

    expect(input.quantityCompleted).toBe(12);
    expect(input.quantityScrap).toBe(1);
    expect(input.qualityPct).toBe(92.3);
    expect(input.oeePct).toBe(79.2);
    expect(input.availabilityPct).toBe(100);
    expect(input.performancePct).toBe(85.8);
  });

  it("passes the normalised lifecycle as the floor status, keeping the raw spelling", async () => {
    const { dispatched } = await run(LIVE_ITEM, [ledger("OPEN")]);
    const input = dispatched.config.actions[0].input;

    // The ledger's FloorOrderStatus enum, which the piece's lifecycle matches.
    expect(input.floorStatus).toBe("RUNNING");
    expect(input.floorStatusRaw).toBe("IN_PROGRESS");
    expect(input.floorCompletedAt).toBeUndefined();
  });

  it("derives the snapshot id from the reading, so a replay cannot double-append", async () => {
    const { dispatched } = await run(LIVE_ITEM, [ledger("OPEN")]);
    const input = dispatched.config.actions[0].input;

    expect(input.id).toBe(`${LIVE_ITEM.orderId}-${LIVE_ITEM.capturedAt}`);
    expect(input.capturedAt).toBe(LIVE_ITEM.capturedAt);
  });

  it("finds the ledger by the order id, which is the binding the processor did in code", async () => {
    const { executor } = await run(LIVE_ITEM, [ledger("OPEN")]);
    const find = executor.calls.find((call) => call.blockType === FIND_BLOCK);

    expect(find.config).toMatchObject({
      documentType: "umh/production-ledger",
      matchPath: "orderId",
      matchValue: LIVE_ITEM.orderId,
      includeState: true,
    });
  });

  it("writes nothing when the floor has counted nothing yet", async () => {
    // The first firing of every order is its PENDING -> RUNNING transition.
    // Recording it would put an empty reading at the head of the trail, and the
    // ledger's qualityPct is non-null — it would have to be given a quality
    // nobody measured.
    const { executor, dispatched } = await run(
      { ...LIVE_ITEM, counted: false, quantityCompleted: 0, quantityScrap: 0, qualityPct: null },
      [ledger("OPEN")],
    );

    expect(dispatched).toBeUndefined();
    expect(executor.calls.map((call) => call.blockType)).not.toContain(FIND_BLOCK);
  });

  it("writes nothing when no ledger is bound to the order", async () => {
    // The floor runs orders nobody has committed to; that is the normal case,
    // not an error.
    const { dispatched, result } = await run(LIVE_ITEM, []);

    expect(dispatched).toBeUndefined();
    expect(result.status).not.toBe("failed");
  });

  it("writes nothing to a ledger that is not OPEN", async () => {
    // Before OPEN the baseline is not frozen; after close-out the commitment is
    // no longer in force. Evidence outside that window is evidence against
    // nothing.
    for (const status of ["DRAFT", "CLOSED_OUT", "ACKNOWLEDGED", "VOID"]) {
      const { dispatched } = await run(LIVE_ITEM, [ledger(status)]);
      expect(dispatched, `dispatched into a ${status} ledger`).toBeUndefined();
    }
  });

  it("closes out nothing — the close-out is not this workflow's to write", async () => {
    // CLOSE_OUT takes a computed verdict, dimensions and costs, which live in
    // the ledger package's calculateCloseOut. A workflow cannot call it, so the
    // graph deliberately stops at evidence. See demo-umh/README.md.
    const closed = {
      ...LIVE_ITEM,
      statusRaw: "CLOSED",
      lifecycle: "COMPLETED",
      closedAt: "2026-09-15T09:20:00.000Z",
    };

    const { dispatched } = await run(closed, [ledger("OPEN")]);

    expect(dispatched.config.actions.map((action) => action.type)).toEqual([
      "RECORD_ACTUALS_SNAPSHOT",
    ]);
    expect(dispatched.config.actions[0].input.floorStatus).toBe("COMPLETED");
    expect(dispatched.config.actions[0].input.floorCompletedAt).toBe(
      "2026-09-15T09:20:00.000Z",
    );
  });
});
