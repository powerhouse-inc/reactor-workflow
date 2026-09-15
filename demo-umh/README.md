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

Status: the floor half is built. The paperless half is next.

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
# 1. build the workspace, then make its unpublished pieces visible to the reactor
pnpm build
node demo-umh/scripts/install-pieces.mjs

# 2. the floor and the archive
docker compose -f demo-umh/docker-compose.yml up -d

# 3. the reactor, with the ledger package loaded and its poller switched off
cd packages/workflow
PH_REGISTRY_PACKAGES=umh-production-ledger \
UMH_POLLER_ENABLED=false \
PH_PUBLIC_URL=http://localhost:4001 \
  pnpm vetra --strictPort

# 4. the drive, the connection and the workflow
node demo-umh/scripts/seed.mjs
```

**`UMH_POLLER_ENABLED=false` is not optional.** The ledger package registers
`umh-order-poller` the moment it loads, and two writers on one append-only
evidence trail produce duplicate entries. The switch is a guard in the ledger
package's own factory; without it, the processor and this workflow both write.

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

## Stopping

```sh
docker compose -f demo-umh/docker-compose.yml down     # keep the archive
docker compose -f demo-umh/docker-compose.yml down -v  # and delete it
```
