// The paperless half: what a scanned purchase order turns into, and what the
// graph refuses to let a model do.
//
// Run through the engine's own coordinator with the piece blocks faked, so the
// subject is the routing, the expressions and the guards — the pieces have
// their own suites.
import {
  CompositeBlockExecutor,
  runWorkflow,
} from "@powerhousedao/reactor-connectors";
import { describe, expect, it } from "vitest";
import {
  ASK_LLM_BLOCK,
  CREATE_BLOCK,
  DISPATCH_BLOCK,
  GET_FILE_BLOCK,
  purchaseOrderWorkflowGraph,
  SCHEMA_BLOCK,
} from "../scripts/graph.mjs";

// What paperless delivers once the trigger has hydrated the document.
const SCAN = {
  id: 42,
  title: "PO-BA-2026-4471 Brenner GmbH",
  created: "2026-09-14T00:00:00Z",
  document_type: 3,
  content:
    "PURCHASE ORDER PO-BA-2026-4471\nBrenner GmbH\nPart: FRAME-WELD-A\nQuantity: 480 pcs\nDelivery by 30.09.2026\nQuality floor 98.5%",
};

// The reactor's document-schema output, as the prompt consumes it.
const MODEL = {
  documentType: "umh/production-ledger",
  name: "Production Ledger",
  stateSchema: "type ProductionLedgerState { customer: String }",
  actions: [
    { type: "SET_COMMITMENT", module: "commitment", inputSchema: "input SetCommitmentInput { customer: String }" },
    { type: "OPEN_LEDGER", module: "commitment", inputSchema: "input OpenLedgerInput { openedAt: DateTime! }" },
  ],
};

const EXTRACTED = JSON.stringify({
  actions: [
    {
      type: "SET_COMMITMENT",
      input: {
        customer: "Brenner GmbH",
        partNumber: "FRAME-WELD-A",
        committedQuantity: 480,
        committedQualityPct: 98.5,
        deadline: "2026-09-30T00:00:00.000Z",
        currency: "EUR",
      },
    },
  ],
});

function fakeExecutor({ llmOutput = EXTRACTED } = {}) {
  const calls = [];
  return {
    calls,
    execute(execution) {
      calls.push(execution);
      switch (execution.blockType) {
        case SCHEMA_BLOCK:
          return Promise.resolve({ output: MODEL });
        case ASK_LLM_BLOCK:
          // The OpenRouter piece returns the generated text itself.
          return Promise.resolve({ output: llmOutput });
        case CREATE_BLOCK:
          return Promise.resolve({
            output: { documentId: "ledger-7", documentType: "umh/production-ledger", name: execution.config.name },
          });
        case GET_FILE_BLOCK:
          return Promise.resolve({
            output: { ref: "apfile://1", filename: "PO-BA-2026-4471.pdf", mime_type: "application/pdf" },
          });
        case DISPATCH_BLOCK:
          return Promise.resolve({ output: { applied: 1 } });
        default:
          return Promise.resolve({ output: {} });
      }
    },
  };
}

async function run(options = {}) {
  const executor = fakeExecutor(options);
  const graph = purchaseOrderWorkflowGraph({
    paperlessConnectionId: "conn-paperless",
    aiConnectionId: "conn-ai",
    ledgerDriveId: "drive-ledgers",
    documentTypeId: 3,
    model: "openai/gpt-oss-120b",
  });
  const result = await runWorkflow({
    definition: graph,
    executor: new CompositeBlockExecutor(executor),
    triggerPayload: options.payload ?? SCAN,
  });
  const by = (blockType) => executor.calls.filter((c) => c.blockType === blockType);
  return { result, executor, by };
}

describe("the purchase-order workflow", () => {
  it("only runs for documents paperless classified as purchase orders", async () => {
    // The trigger's own type filter uses paperless 3.x field names and this
    // demo pins 2.18.4, which ignores them — so the guard is what actually
    // decides, and a payslip must stop here.
    const { by } = await run({ payload: { ...SCAN, document_type: 9 } });

    expect(by(SCHEMA_BLOCK)).toHaveLength(0);
    expect(by(ASK_LLM_BLOCK)).toHaveLength(0);
    expect(by(CREATE_BLOCK)).toHaveLength(0);
  });

  it("runs the whole chain for a document of the right type", async () => {
    const { by } = await run();

    expect(by(SCHEMA_BLOCK)).toHaveLength(1);
    expect(by(ASK_LLM_BLOCK)).toHaveLength(1);
    expect(by(CREATE_BLOCK)).toHaveLength(1);
    expect(by(DISPATCH_BLOCK)).toHaveLength(2);
    expect(by(GET_FILE_BLOCK)).toHaveLength(1);
  });

  it("hands the model the ledger's own schema rather than a hardcoded field list", async () => {
    // The step before the extraction reads the schema at run time, so the
    // prompt cannot drift from the document model.
    const { by } = await run();
    const prompt = by(ASK_LLM_BLOCK)[0].config.prompt;

    expect(by(SCHEMA_BLOCK)[0].config.documentType).toBe("umh/production-ledger");
    expect(prompt).toContain("type ProductionLedgerState");
    expect(prompt).toContain("SET_COMMITMENT");
    expect(prompt).toContain("input SetCommitmentInput");
  });

  it("puts the scan's own text and title in the prompt", async () => {
    const { by } = await run();
    const prompt = by(ASK_LLM_BLOCK)[0].config.prompt;

    expect(prompt).toContain("PO-BA-2026-4471 Brenner GmbH");
    expect(prompt).toContain("Quantity: 480 pcs");
  });

  it("creates the draft in the ledger drive, named after the purchase order", async () => {
    const { by } = await run();
    const create = by(CREATE_BLOCK)[0];

    expect(create.config).toMatchObject({
      documentType: "umh/production-ledger",
      parentId: "drive-ledgers",
      name: "PO-BA-2026-4471 Brenner GmbH",
    });
    // No actions on the create: they go through the dispatch, which enforces
    // the allow-list.
    expect(create.config.actions).toBeUndefined();
    expect(create.config.payload).toBeUndefined();
  });

  it("dispatches the extracted commitment into that draft, and nothing else", async () => {
    const { by } = await run();
    const commitment = by(DISPATCH_BLOCK)[0];

    expect(commitment.config.documentId).toBe("ledger-7");
    expect(commitment.config.allowedActions).toBe("SET_COMMITMENT");
    // The model's JSON reaches the step as text; the reactor piece parses it.
    expect(JSON.parse(commitment.config.actions).actions[0]).toMatchObject({
      type: "SET_COMMITMENT",
      input: { customer: "Brenner GmbH", committedQuantity: 480 },
    });
  });

  it("carries a model's fenced JSON through unchanged, because the step unfences it", async () => {
    // Models fence JSON whatever the prompt says; parseDispatchPayload strips
    // it, so the workflow does not need to.
    const fenced = "```json\n" + EXTRACTED + "\n```";
    const { by } = await run({ llmOutput: fenced });

    expect(by(DISPATCH_BLOCK)[0].config.actions).toBe(fenced);
  });

  it("attaches the archived scan by reference, never by bytes", async () => {
    const { by } = await run();
    const scan = by(GET_FILE_BLOCK)[0];
    const attach = by(DISPATCH_BLOCK)[1];

    expect(scan.config).toMatchObject({ id: 42, variant: "archive" });
    expect(attach.config.allowedActions).toBe("SET_SOURCE_DOCUMENT");
    expect(attach.config.actions[0]).toEqual({
      type: "SET_SOURCE_DOCUMENT",
      input: { sourceDocument: "apfile://1", fileName: "PO-BA-2026-4471.pdf" },
    });
  });

  it("never opens or approves the ledger, whatever the model returns", async () => {
    // The instruction not to is in the prompt, but the guarantee is the step's
    // allow-list: a model that ignores it still cannot move the ledger's state.
    const rogue = JSON.stringify({
      actions: [
        { type: "SET_COMMITMENT", input: { customer: "Brenner GmbH" } },
        { type: "OPEN_LEDGER", input: { openedAt: "2026-09-15T00:00:00.000Z" } },
        { type: "APPROVE_ORDER", input: { approvedBy: "a model", approvedAt: "2026-09-15T00:00:00.000Z", corrections: [] } },
      ],
    });

    const { by } = await run({ llmOutput: rogue });
    const commitment = by(DISPATCH_BLOCK)[0];

    // The step is handed the lot and refuses everything but the commitment;
    // this asserts the workflow never widens that list.
    expect(commitment.config.allowedActions).toBe("SET_COMMITMENT");
    expect(commitment.config.allowedActions).not.toContain("OPEN_LEDGER");
    expect(commitment.config.allowedActions).not.toContain("APPROVE_ORDER");
  });

  it("leaves the order id unset — nothing has reached the floor yet", async () => {
    const { by } = await run();
    const prompt = by(ASK_LLM_BLOCK)[0].config.prompt;

    expect(prompt).toContain("Leave orderId unset");
  });
});
