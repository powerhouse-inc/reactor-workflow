# @powerhousedao/piece-umh

An Activepieces piece for a **United Manufacturing Hub factory floor**: read
production orders and machine counters, derive OEE, and create, release or
cancel orders.

It exists to replace a custom ingress processor with a workflow. The reference
integration ([umh-production-ledger](https://github.com/powerhouse-bai/umh-production-ledger)'s
`umh-order-poller`) polls the floor on a timer, matches orders to ledger
documents and dispatches evidence actions. This piece is the floor half of that,
as blocks: the reactor piece writes the documents, and the workflow owns the
binding between the two.

## Verified against

| | |
| --- | --- |
| Floor API | `dh2k/machine-simulator-2:v1.1.0` — the simulator shipped by [umh-factory-demo](https://github.com/united-manufacturing-hub/umh-factory-demo) |
| Endpoint | `http://<host>:8081`, the address the reference integration's `UMH_API_URL` points at |
| Verified on | 2026-09-15, live (`test/e2e.test.ts` against `test/e2e-compose.yml`) |

Every field name, status value and response shape in this piece was read off a
running instance, not from documentation.

## The connection has no credential

The floor API is **unauthenticated** — no token, no header, no CORS preflight.
The connection is an address, so:

- do not expose the floor anywhere you would not accept unauthenticated writes,
  because `create_order`, `set_order_status` and `cancel_order` are all
  reachable by anyone who can reach it;
- `checkConnection` reads `/health` and `/api/simulation`, and labels the
  connection with the size of the floor (`4 lines, 14 machines @ host:8081`), so
  a connection pointed at the wrong stack is visible as soon as it is saved.

## Actions

| Action | Endpoint | Notes |
| --- | --- | --- |
| List orders | `GET /api/orders` | Line, part and status filters are applied **client-side** — the endpoint takes no parameters at all. Newest first. |
| Get order | `GET /api/orders/{id}` | |
| **Get order actuals** | `GET /api/orders/{id}` + `GET /api/machines` | The evidence action: counts, quality, and the line's OEE factors. |
| Create order | `POST /api/orders` | Not idempotent — two runs make two orders. Rejects a fractional quantity before calling the floor, which would answer `400 {"error":"invalid request body"}` without naming the field. |
| Set order status | `PUT /api/orders/{id}/status` | |
| Cancel order | `DELETE /api/orders/{id}` | |
| List lines | `GET /api/lines` | Lines with their machines and recipes. |
| List machines | `GET /api/machines` | State and counters, optionally one line. |
| Custom API call | any | The rest of the floor API — buffers, per-machine tags, simulation controls. |

Line and part fields are live dropdowns. The part dropdown depends on the line,
because recipes are per line template: offering every part on every line is how
an order gets created that the line cannot run.

## Triggers — all polling

| Trigger | Fires |
| --- | --- |
| **Order progressed** | A good count, scrap count or status moved. One run per order per change, not per poll. |
| **Order closed** | The floor finished or cancelled an order — once, on the transition. |
| **New order** | An order appeared that was not there at the previous poll. |

**Polling, not webhooks, and that was a deliberate choice.** The simulator can
push (`SIMULATOR_WEBHOOK_TARGET_URL`), but it exposes no endpoint to register
one: the target is set in its config or environment and it restarts to pick it
up. A webhook trigger could therefore never self-register the way the paperless
piece does, and the operator would be pasting URLs into a compose file. Polling
keeps the whole arrangement inside the workflow.

What the triggers guarantee:

- **Enabling a workflow replays nothing.** `onEnable` seeds a cursor with the
  floor as it is, so a floor carrying thousands of finished orders produces no
  runs until something actually changes.
- **A change fires once.** The cursor holds each order's last reading; the item
  carries `changed` (which of good/scrap/status moved) and `previous`.
- **`_dedupe_key` is keyed on the reading**, not the order, so the host's 30s
  suppression window drops a re-poll of the same numbers but never a second
  genuine change.
- **An idle floor costs one request per poll.** Machines are read only when
  something is worth firing on, and then once for the whole poll rather than
  once per order.
- **A machine-counter failure does not lose the cycle.** The counts and status
  still fire; the OEE factors read null.

### Cadence

The runtime polls on `pollEverySeconds` in the trigger's config, **with a 60
second floor** (`MIN_SCHEDULE_INTERVAL_MS`) and a 5 minute default. A floor
tuned for demo pace — the umh-powerhouse demo cuts every cycle time to 1/40, so
an 80-piece order finishes in ~80 seconds — will therefore be sampled once or
twice per run. Slow the floor down, or accept a coarser trail.

## Measured, or null — never zero

Every figure this piece reports is either measured or `null`:

- **Quality** is the good share of what was counted, and `null` until something
  is counted. A run that has produced nothing has no quality; reporting 100%
  would be an opinion. (The reference implementation reports 100% here — this
  piece deliberately does not, because the trail it feeds is append-only.)
- **Availability and performance** come from the **bottleneck machine** — the
  lowest availability x performance on the line. A serial line cannot run better
  than its constraint, and taking one real machine keeps the factors internally
  consistent; averaging them blends denominators into a number no machine
  reported. Availability uses the machine's own run/down clocks, not a shift
  window: the historian view divides by a 24-hour shift, which reads ~0.4% for a
  three-minute order and would manufacture a breach out of a good run.
- **OEE** is the product of all three, and `null` while any of them is unknown —
  while still reporting the two that were measured. A machine with no configured
  cycle time is skipped rather than scored zero: its performance is
  unmeasurable, not zero, and including it would hand every line a 0%
  bottleneck.

A live item, captured from the floor:

```json
{
  "orderId": "338a473c-6810-4082-b206-00147eaccacf",
  "partNumber": "FRAME-WELD-A",
  "line": "automotive-welding-1",
  "plannedQuantity": 2,
  "quantityCompleted": 0,
  "quantityScrap": 0,
  "qualityPct": null,
  "availabilityPct": 100,
  "performancePct": 85.8,
  "oeePct": null,
  "bottleneckMachine": "automotive-welding-1-stage-4",
  "statusRaw": "IN_PROGRESS",
  "lifecycle": "RUNNING",
  "changed": { "good": false, "scrap": false, "status": false },
  "previous": null,
  "order": { "...": "the floor's own record, verbatim" }
}
```

`lifecycle` normalises the floor's five status spellings
(`CREATED | RELEASED | IN_PROGRESS | CLOSED | CANCELLED`) to
`PENDING | RUNNING | COMPLETED | CANCELLED | UNKNOWN`, so a workflow branches on
one vocabulary and an unknown status degrades to `UNKNOWN` rather than reading
as "done". The floor's own spelling is kept alongside as `statusRaw`.

## Not on this API

OEE history, machine stop records and cost rates are **not** on the floor API at
all. They live in the historian's TimescaleDB views (`v_oee_by_asset`,
`machine_stops`, `part_scrap_costs`, `line_downtime_costs`) and behind the
`costs-api` dataflow that a UMH deployment adds by hand. A workflow built on
this piece records them as null; reading them needs a SQL block against the
historian, which is a different connection and a different piece.

## API oddities worth knowing

- `GET /api/orders` answers **`null`, not `[]`**, when the floor holds no orders
  — the normal state at boot with the ERP in manual mode. The client coerces it.
- `line_template` on an order is often **an empty string** even when the line has
  one; `GET /api/lines` carries `template_name` reliably.
- `POST /api/machines/{id}/command` answers `{"status":"ok"}` for **any** string,
  including nonsense, so this piece deliberately does not wrap it: an action that
  cannot fail cannot be trusted.
- There is no pagination and no filtering anywhere.

## Tests

```sh
pnpm -F @powerhousedao/piece-umh test     # unit + the bundle conformance gate
```

The conformance gate loads `dist/` — the tarball root — through the reactor's
own duck-typed loader, describes it into a connector descriptor, and runs an
action inside the forked worker. That, not the esbuild config, is the definition
of a valid bundle.

The live suite runs against the real simulator and is skipped without
`UMH_E2E_URL`:

```sh
docker compose -f test/e2e-compose.yml up -d
UMH_E2E_URL=http://localhost:18081 pnpm -F @powerhousedao/piece-umh vitest run test/e2e.test.ts
docker compose -f test/e2e-compose.yml down
```

It publishes the floor on **18081**, not the canonical 8081, so it cannot talk to
a real `~/umh-factory` deployment by accident.

## Building

```sh
pnpm -F @powerhousedao/piece-umh build       # dist/ = package.json + one CJS file
node scripts/bundle.mjs --out <dir>          # build straight into a bundle directory
```

The bundle is self-contained: everything inlined, `dependencies: {}`, `keepNames`
so the reactor's constructor-name check still identifies the piece.
