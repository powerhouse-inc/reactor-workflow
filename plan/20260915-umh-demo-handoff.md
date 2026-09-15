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

**The purchase-order half is proven up to the last step.** A scanned PO fired
the self-registered paperless webhook, passed the type guard, had the ledger's
schema read for it, and reached OpenRouter carrying the OCR. The model returned
a correct commitment — Meridian Metalwerke / Brenner Automotive, FRAME-WELD-A,
480 pieces, 97% quality floor, 70% OEE floor, 12.50 scrap liability, 90.00 late
penalty — buried in two pages of its own reasoning. The piece now reads JSON out
of that prose (`parse.ts`), verified offline against the 7 kB output, **but the
fixed chain has not yet run through to a draft ledger.** That needs one upload
and one LLM call.

**First next step:** drop a PO into paperless (http://localhost:18000,
`admin` / `paperless-demo`) and read the run. Samples live in the
umh-powerhouse checkout under `demo-pdfs/`. Paperless de-duplicates against its
trash, so empty the trash before re-uploading one it has seen.

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

## Next steps, in the order I would do them

1. **Finish the purchase-order run** (above). One upload.
2. **Fix the paperless piece's type filter.** It sends paperless 3.x's
   `filter_has_any_document_types`; 2.18 — the line the piece targets and the
   demo pins — uses the singular `filter_has_document_type`. Paperless accepts
   the unknown field and ignores it, so the filter silently does nothing and the
   demo's branch guard is what actually decides. The piece should send the field
   its own API line understands.
3. **Decide whether `packages/piece-umh` goes to main** on its own merits. It is
   self-contained: 54 tests, a live e2e against the public simulator image, its
   own README. It is UMH-specific, which is why it stayed on the branch.
4. **Take the three ledger-model questions to whoever owns that model** — they
   are listed in the ledger PR body and each needs a decision, not a patch:
   the `production-ledger` subgraph shadowing the document model's generated
   GraphQL namespace; `calculateCloseOut` being a function no workflow can call;
   and `RecordActualsSnapshotInput.qualityPct` being non-null.
5. **Package the demo** the way umh-powerhouse is packaged — one compose file,
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

**The poll floor is 60 seconds.** `pollEverySeconds` is floored at
`MIN_SCHEDULE_INTERVAL_MS`, while the processor polled every 15. A floor tuned
for demo pace finishes an order inside two poll intervals.
