// Wires the demo on a running reactor: a drive, a connection to the factory
// floor, and the workflow that replaces the `umh-order-poller` processor.
//
//   node demo-umh/scripts/seed.mjs
//
// Idempotent by name: every step looks before it writes, so re-running it after
// a restart is the intended mode. It never edits a workflow that already
// exists — delete the document and re-run to rebuild one.
//
// Environment (defaults suit demo-umh/docker-compose.yml + `ph vetra`):
//   REACTOR_URL   http://localhost:4001
//   UMH_API_URL   http://localhost:18081   the floor, as the REACTOR sees it
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_BLOCK,
  FIND_BLOCK,
  floorWorkflowGraph,
  LEDGER_TYPE,
  TRIGGER_BLOCK,
  UMH_PIECE,
} from "./graph.mjs";

const REACTOR_URL = (process.env.REACTOR_URL ?? "http://localhost:4001").replace(/\/+$/, "");
const UMH_API_URL = (process.env.UMH_API_URL ?? "http://localhost:18081").replace(/\/+$/, "");

// Two drives, because they are read by different people. Ledgers live in the
// dashboard the ledger package ships; the workflow and the connection that
// drives them live with the other workflows, where Workflow Studio shows them.
//
// A drive's preferredEditor must target powerhouse/document-drive — that is the
// APP. The documents inside open in their own editors, because their
// documentTypes match.
const LEDGER_DRIVE = {
  name: "PL Dashboard",
  slug: "pl-dashboard",
  editor: "production-ledger-dashboard",
};
const WORKFLOW_DRIVE = {
  name: "Workflows",
  slug: "workflows",
  editor: "workflow-studio",
};

const LEDGER_PACKAGE = "umh-production-ledger";
const CONNECT_CONFIG = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "workflow",
  "powerhouse.config.json",
);
const CONNECTION_NAME = "UMH Factory Floor";
const WORKFLOW_NAME = "Floor evidence -> ledger";

const log = (message) => console.log(message);

async function gql(query, variables = {}) {
  const response = await fetch(`${REACTOR_URL}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors[0].message}`);
  }
  return body.data;
}

async function waitForReactor(seconds = 120) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    try {
      await gql("{ __typename }");
      log(`reactor is up at ${REACTOR_URL}`);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `No reactor at ${REACTOR_URL} after ${seconds}s. Start Vetra first:\n` +
            "  cd packages/workflow && PH_REGISTRY_PACKAGES=umh-production-ledger UMH_POLLER_ENABLED=false pnpm vetra --strictPort\n" +
            `(last error: ${error.message})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

// The floor is read by the reactor, not by this script, so the address checked
// here is the one the connection will carry — a floor this script can reach on
// a different address would be a connection that fails on first use.
async function checkFloor() {
  const response = await fetch(`${UMH_API_URL}/health`);
  if (!response.ok) throw new Error(`floor /health answered ${response.status}`);
  const simulation = await (await fetch(`${UMH_API_URL}/api/simulation`)).json();
  log(
    `floor is up at ${UMH_API_URL} (${simulation.line_count} lines, ${simulation.machine_count} machines)`,
  );
}

async function childrenOf(driveId) {
  const data = await gql(
    `query($id:String!) {
       documentOutgoingRelationships(
         sourceIdentifier:$id, relationshipType:"child", paging:{limit:200}) {
           items { id name documentType } } }`,
    { id: driveId },
  );
  return data.documentOutgoingRelationships.items;
}

// By name, because that is what a person reading Connect sees, and because a
// drive created by hand has its id for a slug. Matching on slug alone would
// have missed the Workflows drive somebody already had open.
async function findDrive(name) {
  const data = await gql(
    `query { findDocuments(search:{type:"powerhouse/document-drive"}, paging:{limit:100}) {
       items { id name slug } } }`,
  );
  return data.findDocuments.items.find((item) => item.name === name);
}

async function ensureDrive(drive) {
  const existing = await findDrive(drive.name);
  if (existing) {
    log(`drive "${drive.name}" already exists (${existing.id})`);
    // Its own slug, not the one this script would have given it: a drive
    // created by hand in Connect has its id there, and that is what a default
    // drive URL has to address.
    return { id: existing.id, slug: existing.slug };
  }
  const created = await gql(
    `mutation($name:String!,$slug:String,$editor:String) {
       DocumentDrive { createDocument(name:$name, slug:$slug, preferredEditor:$editor) { id } } }`,
    { name: drive.name, slug: drive.slug, editor: drive.editor },
  );
  const id = created.DocumentDrive.createDocument.id;
  log(`created drive "${drive.name}" (${id})`);
  return { id, slug: drive.slug };
}


// Connect is the other half, and it is told none of this by the reactor: the
// browser fetches powerhouse.config.json over HTTP and reads its own `packages`
// and `defaultDrives` from there. Without the package entry the ledger
// documents render as an unknown type with no editor, however well the
// switchboard has loaded the same models.
//
// This edits a file that is tracked in git. It is the project's dev config, not
// something the workflow package publishes, and the edit is the demo's: revert
// it when you are done, or keep it if this checkout is the demo.
function configureConnect(drives) {
  const config = JSON.parse(readFileSync(CONNECT_CONFIG, "utf8"));
  const changes = [];

  config.packages ??= [];
  if (!config.packages.some((entry) => entry.packageName === LEDGER_PACKAGE)) {
    // No version and no provider: Connect resolves it against
    // packageRegistryUrl, which already points at the registry the ledger is
    // published to.
    config.packages.push({ packageName: LEDGER_PACKAGE });
    changes.push(`packages += ${LEDGER_PACKAGE}`);
  }

  config.connect ??= {};
  config.connect.drives ??= {};
  config.connect.drives.defaultDrives ??= [];
  const defaults = config.connect.drives.defaultDrives;
  for (const drive of drives) {
    const url = `${REACTOR_URL}/d/${drive.slug}`;
    if (!defaults.some((entry) => entry.url === url)) {
      defaults.push({ url, name: null, icon: null });
      changes.push(`defaultDrives += ${url}`);
    }
  }

  if (changes.length === 0) {
    log("Connect config already carries the package and both drives");
    return;
  }
  writeFileSync(CONNECT_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  for (const change of changes) log(`connect config: ${change}`);
  // Only half of that takes effect under Vetra. `ph vetra` builds its own
  // drives override — its Vetra and preview drives, with preserveStrategy
  // "preserve-all" — and hands that to Connect Studio, so `defaultDrives` from
  // this file never reaches the browser. It is written anyway because it is
  // what `ph connect` and a Docker deployment read; under Vetra, opening each
  // drive once per browser is what puts it in the sidebar, and preserve-all is
  // what keeps it there.
  log("Reload Connect for the package; open the drive links below once each.");
}

async function ensureConnection(driveId) {
  const existing = (await childrenOf(driveId)).find(
    (item) =>
      item.documentType === "powerhouse/connection" && item.name === CONNECTION_NAME,
  );
  if (existing) {
    log(`connection "${CONNECTION_NAME}" already exists (${existing.id})`);
    return existing.id;
  }
  const created = await gql(
    `mutation($name:String!,$parent:String) {
       Connection { createDocument(name:$name, parentIdentifier:$parent) { id } } }`,
    { name: CONNECTION_NAME, parent: driveId },
  );
  const id = created.Connection.createDocument.id;
  // The floor API has no credential, so the connection is an address and
  // nothing else: no secret ref, and no secrets service involved.
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetConnectorInput!) {
       Connection { setConnector(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { connectorId: UMH_PIECE, authType: "CUSTOM_AUTH" } },
  );
  await gql(
    `mutation($doc:PHID!,$input:Connection_SetConfigInput!) {
       Connection { setConfig(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { config: { base_url: UMH_API_URL } } },
  );
  log(`created connection "${CONNECTION_NAME}" -> ${UMH_API_URL} (${id})`);
  return id;
}

async function ensureWorkflow(driveId, connectionId) {
  const existing = (await childrenOf(driveId)).find(
    (item) =>
      item.documentType === "powerhouse/workflow" && item.name === WORKFLOW_NAME,
  );
  if (existing) {
    log(
      `workflow "${WORKFLOW_NAME}" already exists (${existing.id}) — delete it to rebuild`,
    );
    return existing.id;
  }
  const created = await gql(
    `mutation($name:String!,$parent:String) {
       Workflow { createDocument(name:$name, parentIdentifier:$parent) { id } } }`,
    { name: WORKFLOW_NAME, parent: driveId },
  );
  const id = created.Workflow.createDocument.id;
  const graph = floorWorkflowGraph(connectionId);

  await gql(
    `mutation($doc:PHID!,$input:Workflow_SetTriggerInput!) {
       Workflow { setTrigger(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: graph.trigger },
  );
  for (const step of graph.steps) {
    await gql(
      `mutation($doc:PHID!,$input:Workflow_AddStepInput!) {
         Workflow { addStep(docId:$doc, input:$input) { id } } }`,
      { doc: id, input: step },
    );
  }
  for (const edge of graph.edges) {
    await gql(
      `mutation($doc:PHID!,$input:Workflow_AddEdgeInput!) {
         Workflow { addEdge(docId:$doc, input:$input) { id } } }`,
      { doc: id, input: edge },
    );
  }
  // Last, deliberately: only an ENABLED workflow registers a trigger instance,
  // and a half-built graph that starts polling would run against missing steps.
  await gql(
    `mutation($doc:PHID!,$input:Workflow_SetWorkflowStatusInput!) {
       Workflow { setWorkflowStatus(docId:$doc, input:$input) { id } } }`,
    { doc: id, input: { status: "ENABLED" } },
  );
  log(
    `created workflow "${WORKFLOW_NAME}" (${id}) — ${graph.steps.length} steps, ENABLED`,
  );
  return id;
}

await waitForReactor();
await checkFloor();
const ledgerDrive = await ensureDrive(LEDGER_DRIVE);
const workflowDrive = await ensureDrive(WORKFLOW_DRIVE);
const connectionId = await ensureConnection(workflowDrive.id);
const workflowId = await ensureWorkflow(workflowDrive.id, connectionId);
configureConnect([workflowDrive, ledgerDrive]);

log(`
Seeded.

  ledger drive    ${ledgerDrive.id}   (${LEDGER_DRIVE.name})
  workflow drive  ${workflowDrive.id}   (${WORKFLOW_DRIVE.name})
  connection      ${connectionId}
  workflow        ${workflowId}

Open each drive once in Connect — "ph vetra" overrides the configured default
drives with its own, and a drive you have visited is kept by preserve-all:

  ${WORKFLOW_DRIVE.name}: http://localhost:3001/?driveUrl=${encodeURIComponent(`${REACTOR_URL}/d/${workflowDrive.slug}`)}
  ${LEDGER_DRIVE.name}: http://localhost:3001/?driveUrl=${encodeURIComponent(`${REACTOR_URL}/d/${ledgerDrive.slug}`)}

Next:
  1. Open Connect and create a Production Ledger in the "${LEDGER_DRIVE.name}" drive.
  2. Set its commitment, then set its Order ID to an order on the floor — or
     have a workflow create the order and bind it.
  3. Open the ledger (status OPEN) so evidence is judged against a frozen
     baseline; the workflow ignores ledgers in any other status.
  4. Watch the runs:
     curl -s ${REACTOR_URL}/graphql/workflow-runtime \\
       -H 'content-type: application/json' \\
       -d '{"query":"{ workflowRuntime { runs(limit: 5) { workflowName status steps { key status } } } }"}'
`);
