# Demo: the UMH production ledger, without the custom processor

The [umh-powerhouse demo](https://github.com/powerhouse-inc/umh-powerhouse) binds
a customer's purchase order to what a factory floor actually produced, in one
replayable document. Two custom integrations make it work, both processors
inside the ledger package:

| Processor | What it does |
| --- | --- |
| `umh-order-poller` | Polls the floor every 15s, matches orders to ledgers, appends evidence, closes out |
| `paperless-sync` | Receives a Paperless webhook, extracts a purchase order with an LLM, creates a DRAFT ledger |

**This demo replaces them with pieces and workflows** — the same evidence, built
from blocks anyone can read and edit in Connect, rather than from code that has
to be written, reviewed and deployed.

Both halves are built.

## What runs where

| | |
| --- | --- |
| Factory floor | `dh2k/machine-simulator-2` in Docker, port **18081** |
| Paperless | `paperless-ngx:2.18.4` in Docker, port **18000** |
| Reactor + Connect | Vetra on the host, from `packages/workflow` |
| Ledger document model, editors, dashboard | `umh-production-ledger`, linked from a sibling checkout |
| Floor blocks | `packages/piece-umh` — this workspace |
| Document blocks | `packages/workflow/pieces/reactor` — this workspace |

Both Docker ports are deliberately not the canonical ones: a standalone
`~/umh-factory` deployment or the umh-powerhouse stack publishes 8081 and 8000,
and this demo must not talk to a running factory or archive by accident.

## Prerequisites

The ledger package is not published to npm; it is linked from a sibling
checkout of [umh-production-ledger](https://github.com/powerhouse-bai/umh-production-ledger):

```sh
git clone git@github.com:powerhouse-bai/umh-production-ledger.git ../umh-production-ledger
cd ../umh-production-ledger && bun install && bun run build
```

`packages/workflow/package.json` already carries
`"umh-production-ledger": "link:../../../umh-production-ledger"`, so the two
repositories sit side by side under one parent directory.

## Run it

```sh
# 1. the floor and the archive
docker compose -f demo-umh/docker-compose.yml up -d

# 2. the reactor (installs this workspace's unpublished pieces, then Vetra)
./demo-umh/start.sh

# 3. the drives, connections and workflows
node demo-umh/scripts/seed.mjs
```

For the extraction step, put an OpenRouter key in `demo-umh/.env` (copy
`.env.example`) and run the seed again — it mints the key into the reactor's
secret store and rotates it on later runs, so only the ref ever touches the
connection document. Without it every other part of the demo works and the
extraction step fails with a 401.

`start.sh` exists because the piece installation has to happen on **every**
start. It writes `packages/workflow/dist/pieces/index.mjs`, and both `pnpm
build` and the workflow package's own test suite regenerate that file from the
tracked manifest — dropping the demo's pieces. When that happens the reactor
loads one package piece instead of three, every block type in both workflows
resolves to nothing, and no trigger registers: a silent and total stop.

`start.sh` sets three things that are each load-bearing:

**`WORKFLOW_EGRESS_ALLOW_ADDRESSES`.** Piece code runs under an egress policy
that denies private address space — a piece config is an SSRF surface — so
without it every connection in this demo is unreachable and the trigger parks
with `Could not reach the UMH floor API`. Naming the loopback addresses widens
the policy by exactly that much; the rest of private space, and the cloud
metadata endpoint, stay denied.

**`PUBLIC_URL`** — not `PH_PUBLIC_URL`, which nothing reads.
`resolvePublicOrigin` in reactor-api reads `PUBLIC_URL` (or
`RENDER_EXTERNAL_URL`) and otherwise falls back to localhost. It is the origin
the paperless piece registers as its webhook target, and paperless posts from
inside a container, where `localhost` is itself. On Docker Desktop the address
that reaches the host is `host.docker.internal`.

**`UMH_POLLER_ENABLED=false`.**

Belt and braces since
[umh-production-ledger#1](https://github.com/powerhouse-bai/umh-production-ledger/pull/1)
made the poller opt-in: on a package built before that, the processor starts the
moment the package loads, and two writers on one append-only evidence trail
produce duplicate entries. Passing it explicitly keeps this demo correct against
either version.

`install-pieces.mjs` builds `piece-umh` and `piece-paperless-ngx` into
`packages/workflow/dist/pieces` and declares them in the manifest the piece
registry reads there. It is build output, and `pnpm build` regenerates that
manifest from the tracked one — **re-run the script after any build**.

## The floor workflow

```
order progressed ──▶ counted? ──true──▶ find the bound ledger ──▶ OPEN? ──true──▶ append snapshot
```

`demo-umh/scripts/graph.mjs` is the whole thing, and
`demo-umh/test/workflow-graph.test.mjs` runs it against the engine with a
payload captured from a live floor.

- **The trigger** is `@powerhousedao/piece-umh#trigger:order_progressed`,
  polling. It fires once per order per change, carrying the counts, the derived
  OEE and what moved since the last poll.
- **`counted?`** stops a run that has produced nothing. The first firing of
  every order is its PENDING → RUNNING transition; recording it would put an
  empty reading at the head of the trail, and the ledger's `qualityPct` is
  non-null, so it would have to be given a quality nobody measured.
- **The find** is the binding the processor did in code: `orderId` in the
  ledger's state against the order id from the floor. The reactor's index
  cannot query state, so the host matches inside the page it read (100 rows).
- **`OPEN?`** is the window in which evidence means anything. Before OPEN the
  baseline is not frozen; after close-out the commitment is no longer in force.
- **The dispatch** appends `RECORD_ACTUALS_SNAPSHOT`, and the step's
  `allowedActions` is set to that one type, so the workflow cannot do anything
  else to a ledger even if its action list were edited.

The snapshot id is derived — `<orderId>-<capturedAt>` — so a replayed delivery
produces the same id and the reducer rejects it, rather than appending the same
reading twice.

## The purchase-order workflow

```
new document ──▶ purchase order? ──true──▶ read the model ──▶ extract
                                             ──▶ draft ──▶ commitment ──▶ fetch scan ──▶ attach
```

This is the `paperless-sync` processor — an LLM client, an import store, a
safe-merge, a paperless client and a docling client — as seven blocks, three of
them the reactor's own. `demo-umh/scripts/graph.mjs` is the definition and
`demo-umh/test/purchase-order-graph.test.mjs` runs it against the engine.

- **The trigger self-registers.** Enabling the workflow creates a webhook in
  paperless pointing at this reactor; `include_content` is what puts the OCR
  text in the payload.
- **The guard is a branch, not the trigger's filter.** The piece sends
  paperless 3.x's `filter_has_any_document_types`, and this demo pins 2.18.4,
  whose field is the singular `filter_has_document_type`. Paperless accepts the
  unknown field and ignores it, so the delivery is not filtered at the source
  and the branch on `document_type` is what actually decides.
- **The model reads its own schema at run time.** The `model` step hands the
  extractor the ledger's state schema and all eleven operations, so the prompt
  cannot drift from the document model the way a hardcoded field list would.
- **The commitment is dispatched, not created.** `document-create` will apply
  actions from a payload, but only `document-dispatch` enforces an allow-list.
  Creating the draft empty and dispatching into it is what makes "SET_COMMITMENT
  and nothing else" a rule rather than a request — which matters when the
  actions were written by a model. The scan is attached the same way, with
  `SET_SOURCE_DOCUMENT` and nothing else.
- **The human gate holds.** Nothing in this workflow approves, opens, starts or
  signs a ledger. A reviewer does that, and approval is what creates the floor
  order the other workflow then feeds.

### Two known gaps

**Close-out is not in the workflow.** `CLOSE_OUT` takes a computed verdict,
conformance dimensions and costs, produced by `calculateCloseOut(state, final,
{rates})` — a function exported from the ledger package and called by the
processor. A workflow cannot call a function. Closing out stays a human action
in the editor until that calculation moves into the reducer (where the state it
needs already is) or behind a mutation the ledger package exposes. Everything up
to it — every snapshot in the evidence trail — is the workflow's.

**The poll floor is 60 seconds.** The runtime floors `pollEverySeconds` at
`MIN_SCHEDULE_INTERVAL_MS`, while the processor polled every 15. The
umh-powerhouse floor is tuned so an 80-piece order finishes in ~80 seconds,
which would leave one or two snapshots per run; this demo's simulator runs at
stock pace, so an order takes long enough to build a trail. Slow the floor
further by editing the profile's cycle times if you want a denser one.

## Watching it work

The seed puts its documents in two drives, because different people read them:
the workflow and its connection go to **Workflows**, beside any others you have
and under Workflow Studio; ledgers go to **PL Dashboard**, under the dashboard
the ledger package ships.

### Connect needs telling twice

Connect is the other half of the reactor and shares none of its configuration:
the browser fetches `powerhouse.config.json` over HTTP and reads its own
`packages` list from there. `PH_REGISTRY_PACKAGES` is server-side only, so with
that list empty the switchboard loads the ledger models perfectly and Connect
still renders every ledger as an unknown type with no editor. The seed adds the
entry; reload Connect after the first run.

Two consequences worth knowing:

- **Connect loads the published package, the switchboard loads the link.** The
  browser resolves `umh-production-ledger` against `packageRegistryUrl` and
  fetches `…/-/cdn/umh-production-ledger/browser/index.js` at whatever version
  the registry has, while the reactor runs the linked local clone. Change the
  model locally and Connect will not see it until you publish.
- **Default drives come from the command line, not the config file.** `ph vetra`
  builds its own drives override and hands it to Connect Studio, so
  `connect.drives.defaultDrives` never reaches the browser — but
  `--default-drives-url` does, and the run command above uses it. The seed still
  writes the config entry, because `ph connect` and a Docker deployment read it,
  and prints a `?driveUrl=` link per drive for a browser that needs one:
  `preserveStrategy: "preserve-all"` keeps a drive you have visited. Reported
  upstream as [powerhouse-inc/powerhouse#3023](https://github.com/powerhouse-inc/powerhouse/issues/3023);
  note the flag *replaces* Vetra's own drives rather than adding to them.

The ledger editor also talks to the floor API **directly from the browser**, and
it defaults to `http://localhost:8081`. This demo's floor is on 18081, so the
editor shows "UMH factory unreachable — line list is a static fallback". Set
`localStorage.umhApiBaseUrl = "http://localhost:18081"` in Connect's console to
give it the live list.

1. Open Connect (Vetra prints the URL) and the **PL Dashboard** drive.
2. Create a Production Ledger, fill in the commitment, and **Open** it.
3. Put a floor order id into its `orderId` — either from
   `curl -s http://localhost:18081/api/orders`, or by having a workflow create
   the order with the UMH piece's `create_order` action and bind what it
   returns.
4. Within a poll interval the evidence trail starts filling.

```sh
curl -s http://localhost:4001/graphql/workflow-runtime \
  -H 'content-type: application/json' \
  -d '{"query":"{ workflowRuntime { runs(limit: 5) { workflowName status steps { key blockType status } } } }"}'
```

A run whose `counted?` or `OPEN?` step ends the graph is a **successful** run
that decided to write nothing — that is the guard working, not a failure.

**Paperless de-duplicates against its trash.** Re-uploading the same PDF after
deleting the document is refused with "It is a duplicate … existing document is
in the trash", and no webhook fires. Empty the trash, or use one of the other
sample purchase orders.

**If the trigger parks, republish it.** A trigger whose first enable failed —
the floor was not up yet, the egress policy was not widened — backs off, and a
restart does not clear the backoff: the supervisor logs `Enable for workflow …
still backing off until …` and waits. Toggling the workflow's status to
DISABLED and back to ENABLED re-enables it immediately.

What a healthy trail looks like, from a real run of this demo:

| captured | good | scrap | quality % | availability % | OEE % |
| --- | --- | --- | --- | --- | --- |
| 09:38:41 | 7 | 0 | 100 | 100 | 100 |
| 09:40:41 | 11 | 1 | 91.7 | 72.5 | 66.5 |
| 09:43:41 | 24 | 1 | 96 | 72.5 | 69.6 |
| 09:47:11 | 35 | 1 | 97.2 | 79.8 | 77.6 |

Six of those nine snapshots were written by one workflow document and the last
three by its replacement, after it was rebuilt into the Workflows drive — the
trail does not care which, because the evidence is the ledger's, not the
workflow's.

## Stopping

```sh
docker compose -f demo-umh/docker-compose.yml down     # keep the archive
docker compose -f demo-umh/docker-compose.yml down -v  # and delete it
```
