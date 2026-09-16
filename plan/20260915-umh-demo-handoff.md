# UMH demo — handoff

**Written:** 15 September 2026, at the end of the session that built it.
**Branch:** `workflow/piece-umh`. **Companion:** [`demo-umh/README.md`](../demo-umh/README.md)
for how to run it, [`packages/piece-umh/README.md`](../packages/piece-umh/README.md)
for the piece.

## What this is

The [umh-powerhouse demo](https://github.com/powerhouse-inc/umh-powerhouse)
builds a production ledger with two custom processors inside the
[umh-production-ledger](https://github.com/powerhouse-bai/umh-production-ledger)
package. This work replaces both with pieces and workflows — the same evidence,
built from blocks a person can read and edit in Connect.

| Processor | Replaced by |
| --- | --- |
| `umh-order-poller` | `order progressed ─▶ counted? ─▶ find the bound ledger ─▶ OPEN? ─▶ append snapshot` |
| `paperless-sync` | `new document ─▶ purchase order? ─▶ read the model ─▶ extract ─▶ draft ─▶ commitment ─▶ fetch scan ─▶ attach` |

Both graphs live in [`demo-umh/scripts/graph.mjs`](../demo-umh/scripts/graph.mjs)
and are tested against the engine's own coordinator in
[`demo-umh/test/`](../demo-umh/test/) — real trigger payloads, real
`core#branch`, fake pieces.

## What is verified, and what is not

**The floor half is proven end to end.** A 40-piece order on the simulated floor
produced nine snapshots on one ledger, a minute apart, with quality climbing
92 → 97% and OEE derived from the bottleneck machine. Three of those nine were
written by a rebuilt workflow after the document was moved between drives; the
trail did not notice, because the evidence belongs to the ledger.

**The purchase-order half is proven too.** Two runs have gone through all seven
steps and written a DRAFT ledger each, with the commitment the model extracted
and the scan attached:

| Ledger | Commitment |
| --- | --- |
| `PO-BA-2026-4471_automotive-welding` | Meridian Metalwerke / Brenner Automotive, FRAME-WELD-A, 480 pcs, 97% quality, 70% OEE floor, 12.50 scrap, 90.00/h late |
| `PO-BC-2026-0917_window-frame` | Meridian Metalwerke GmbH / BuildCorp AG, WIN-STD-A, 320 pcs, 98.5% quality, 70% OEE floor, 180 scrap, 250/h late |

Both sit at `status: DRAFT` with `orderId` unset, which is what the prompt asks
for: a reviewer approves the draft, and that is what dispatches the order.
The model buries its answer in two pages of reasoning; the piece reads the JSON
out of that prose (`parse.ts`).

(An earlier version of this document said the chain had not yet reached a
ledger. It had — the first of those two runs predates the document.)

To fire one yourself: drop a PO into paperless (http://localhost:18000,
`admin` / `paperless-demo`). Samples live in the umh-powerhouse checkout under
`demo-pdfs/`, though all four are already loaded — and paperless de-duplicates
against its trash, so empty the trash before re-uploading one it has seen. To
re-run one already there, POST its id to the registered webhook instead:

```sh
curl -X POST http://localhost:4001/webhooks/<path> \
  -H 'content-type: application/json' -d '{"doc_id":"2","event":"DOCUMENT_ADDED"}'
```

The path is in paperless under *Workflows*, on the webhook action.

**The two halves have been joined**, which nothing had shown before: one
ledger now carries the scan, the commitment a model read out of it, the
approval that bound it to a floor order, and the machine evidence that
followed. `9570c9b6` — Brenner Automotive, FRAME-WELD-A, 480 pieces — is OPEN
against floor order `a4009ab2` and accruing snapshots (good 5, quality 100%,
OEE 60.5% from availability 97.5 × performance 62.1).

The sequence, for anyone repeating it:

1. Fire the purchase-order workflow (upload, or POST a `doc_id` to the
   registered webhook). A DRAFT ledger appears with the commitment and the
   scan attached, `orderId` unset.
2. Approve the draft in the ledger editor. Its approve button creates the
   floor order itself, then approves and opens in one batch — so the UI path
   needs no separate step here. By hand it is one POST:
   ```sh
   curl -X POST http://localhost:18081/api/orders -H 'content-type: application/json' \
     -d '{"product_id":"FRAME-WELD-A","line_instance_id":"automotive-welding-1","planned_qty":480}'
   ```
3. `APPROVE_ORDER` with that order id, then `OPEN_LEDGER`. Approval is
   one-time and DRAFT-only by design — it freezes the commitment and binds the
   order identity — so **bind it to an order that is actually running.** A
   ledger bound to the wrong order can only be voided, not repointed.
4. The floor workflow does the rest, every 60 s.

## State on this machine

Left running at the end of the session:

- `demo-umh/docker-compose.yml` — machine-simulator on **18081**, paperless on
  **18000**, its redis. All healthy.
- Vetra from `packages/workflow` — switchboard **4001**, Connect **3001**.
- Drives: `pl-dashboard` (ledgers) and `Workflows`, whose slug on this machine
  is its id `12be6c23-bdc8-4363-9b58-fc89ba0321f0` because it was made by hand
  in Connect. A fresh setup gets the slug `workflows`; the seed prints the exact
  `--default-drives-url` either way.
- `demo-umh/.env` holds a real OpenRouter key (gitignored).
- `packages/workflow/node_modules/umh-production-ledger` is a link to a sibling
  checkout at `../../../umh-production-ledger`, built with `bun run build`.

## Open pull requests

| PR | What it carries |
| --- | --- |
| [reactor-workflow#30](https://github.com/powerhouse-inc/reactor-workflow/pull/30) | The three core changes: state matching in `document-find`, `WORKFLOW_EGRESS_ALLOW_ADDRESSES`, reading a model's JSON out of prose |
| [umh-production-ledger#1](https://github.com/powerhouse-bai/umh-production-ledger/pull/1) | `UMH_POLLER_ENABLED` defaults to false — breaking, deliberate: the workflow is the default ingress now |
| [umh-powerhouse#2](https://github.com/powerhouse-inc/umh-powerhouse/pull/2) | The Docker demo asks for the processor explicitly |
| [powerhouse#3023](https://github.com/powerhouse-inc/powerhouse/issues/3023) | Issue: `ph vetra` ignores `connect.drives.defaultDrives` |

The ledger flip only bites once a new version of that package is published and
`UMH_LEDGER_VERSION` moves; 0.0.7 has no switch at all. `demo-umh/start.sh`
passes `UMH_POLLER_ENABLED=false` explicitly so the demo is correct against
either version.

## Done since this was written

**The paperless piece's trigger filters** (was step 2). It sent paperless 3.x's
`filter_has_any_document_types` to a 2.18 server, which drops an unknown field
without a word — so the trigger registered with no filter and fired on every
document. `OPTIONS /api/workflows/` on the demo's own 2.18.4 gave the
authoritative field list: the trigger serializer has `filter_has_tags`,
`filter_has_correspondent` and `filter_has_document_type`, and nothing else.
The piece now sends what the negotiated API version understands, and **refuses**
a filter that line cannot express instead of dropping it — dropping a filter
widens the trigger, which is the opposite of what was asked for.

A second half surfaced while fixing it: **the reconciliation sweep applied no
filters at all.** It asks `/api/documents/` rather than being delivered to, so
the filters registered in paperless never touched it — meaning one missed
delivery turned a filtered trigger into an unfiltered one. The sweep now sends
the equivalent query params (comma-joined ids: the `in` lookups split on
commas, and repeated params leave Django reading only the last), and applies
the filename glob itself, since the documents endpoint has no glob lookup.

Verified live against the demo's paperless — the registration test in
`test/e2e-legacy.test.ts` asserts what 2.18.4 actually stored, and the running
demo's own registration now carries `filter_has_document_type = 1`.

**A webhook delivery never read the id paperless sent** (found while checking
the above). The runtime hands a webhook trigger the request envelope —
`{ method, path, headers, queryParams, body }` — and `readDocId` looked for
`doc_id` at the top level, where it never is. Every delivery therefore fell
through to the reconciliation sweep, which worked only because the supervisor
rewinds the cursor before a delivery: it emitted everything since that cursor
instead of the one document named, and anything older than the rewind was
missed outright. It now reads `body`, then `queryParams`, then the flat shape.
Proven live: replaying a delivery for document 2 — hours older than any cursor
— ran all seven steps and produced the window-frame ledger above.

## Next steps, in the order I would do them

1. **Finish the purchase-order run** (above). One upload.
2. **Decide whether `packages/piece-umh` goes to main** on its own merits. It is
   self-contained: 54 tests, a live e2e against the public simulator image, its
   own README. It is UMH-specific, which is why it stayed on the branch.
3. **Take the three ledger-model questions to whoever owns that model** — they
   are listed in the ledger PR body and each needs a decision, not a patch:
   the `production-ledger` subgraph shadowing the document model's generated
   GraphQL namespace; `calculateCloseOut` being a function no workflow can call;
   and `RecordActualsSnapshotInput.qualityPct` being non-null.
4. **Package the demo** the way umh-powerhouse is packaged — one compose file,
   one command — if this becomes the version that gets shown.

## Landmines

Each of these cost an hour or more to find.

**The piece manifest is regenerated behind your back.** `pnpm build` and the
workflow package's own test suite both rewrite
`packages/workflow/dist/pieces/index.mjs` from the tracked manifest, dropping
the demo's unpublished pieces. The reactor then loads one package piece instead
of three, every block type in both workflows resolves to nothing, and **no
trigger registers at all** — with no error anywhere. `demo-umh/start.sh` exists
to re-install them on every start. If triggers stop registering, check the
manifest first.

**`PUBLIC_URL`, not `PH_PUBLIC_URL`.** Nothing reads the latter.
`resolvePublicOrigin` in reactor-api reads `PUBLIC_URL` or
`RENDER_EXTERNAL_URL`, and otherwise falls back to localhost — which paperless
then registers as its webhook target, from inside a container, where localhost
is itself. `demo/README.md` documented the wrong one for a long time.

**Host networking does not reach the host on Docker Desktop.** Paperless
answered perfectly inside its container and nothing on the Mac could see it.
This demo publishes a port instead and takes `host.docker.internal` back in.
`demo/` still uses host networking and has the same problem on Docker Desktop.

**A connection stores a package, not a pinned version.**
`packageFromConnectorId` strips a `#suffix` and nothing else, so a `connectorId`
of `@activepieces/piece-open-router@0.2.0` never matches the step's piece and
the run fails with "Connection is not available to this block".

**Piece code cannot reach private address space** unless
`WORKFLOW_EGRESS_ALLOW_ADDRESSES` says so. Without it every connection in a
local demo is unreachable and triggers park with a network error.

**A trigger whose first enable failed stays parked.** A restart does not clear
the backoff; toggling the workflow's status DISABLED → ENABLED re-enables it.

**A failed run cannot always be replayed.** `rerun` replays journaled step
outputs, but a redacted output refuses — so a failure downstream of a redacted
step needs a fresh firing, and with it another LLM call.

**Paperless de-duplicates against its trash**, so deleting a document is not
enough to re-upload the same file.

**A webhook trigger's `context.payload` is the request envelope**, not the body
the provider posted: `{ method, path, headers, queryParams, body }`. A piece
that reads its fields off the top level finds nothing, and if it has a polling
fallback — as this one does — it will look like it works.

**A paperless registration collides on its own name.** The piece names its
workflow after a hash of the endpoint, so a reactor workflow whose stored
registration was lost cannot re-register: paperless answers "workflow with this
name already exists" and the trigger parks. Delete the orphan in paperless
(*Workflows*), then toggle DISABLED → ENABLED.

**A new floor order reads `CREATED` for a few seconds**, then the simulator
picks it up on its own — no release call needed (measured: `CREATED` →
`IN_PROGRESS` with pieces counted inside 10 s). Reading the status immediately
after creating it and concluding the order is stuck is the easy mistake.

**An order can nonetheless be wedged.** This machine carries three from 09:36
that have sat at `IN_PROGRESS` ever since with every machine IDLE and nothing
counted. Cause unknown; the symptom is a line whose machines are IDLE while
orders claim to be running. Create a fresh order rather than trying to revive
one.

**The floor trigger fires on change, not on state.** It keeps a per-order
cursor of `{good, scrap, status}` and emits only when one of those moves, so a
finished or wedged order produces nothing however long you wait. A ledger bound
to such an order looks broken and is merely bound to nothing happening.

**The poll floor is 60 seconds.** `pollEverySeconds` is floored at
`MIN_SCHEDULE_INTERVAL_MS`, while the processor polled every 15. A floor tuned
for demo pace finishes an order inside two poll intervals.
