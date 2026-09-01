# Spike S6b notes — dynamic options channel (piece-subflows)

**Date:** 2026-09-01 · **Runner:** Node v24.14.1, macOS · **Follows:** `10-spike-notes-s6a.md`
**Question (doc 06 §2.5, doc 09 §6):** is `Property.Dropdown.options()` invocable outside their
engine, and what does the design-time `PropertyContext` actually need to carry?
**Probe script:** superseded by `test/activepieces/piece-subflows.test.ts` (bundle fetched at runtime)

## 1. Candidate selection (a mini Tier-1 sweep)

The cloud registry lists 761 pieces (`GET cloud.activepieces.com/api/v1/pieces`; the per-piece
detail endpoint 403s without auth). 37 have actions and no piece-level auth. All 37 npm bundles
were fetched and swept with the real adapter modules (`loadPieceFromDir` + `buildDescriptor`,
filtering for `DROPDOWN`/`MULTI_SELECT_DROPDOWN` props with `hasDynamicResolver`):

| Piece | Dynamic dropdowns | Out-of-band cost |
|---|---|---|
| `piece-subflows@0.6.4` | `callFlow.flowId`, `streamCsvToSubflows.subflow` | **none — only `ctx.flows`** ← chosen |
| `piece-tables@0.5.1` | `table_id` on 8 actions | hits platform API via `ctx.server`; catches its own failure and returns a disabled `DropdownState` with a placeholder |
| `piece-ai@0.10.0` | `classifyText.provider`/`.model` (+1 action) | fetches from `ctx.server.apiUrl` |

### 🔴 Side-finding: bundles are NOT universally self-contained

8 of 37 no-auth bundles fail to load on missing runtime deps, contradicting the doc 06 §2.4
assumption ("framework and third-party deps are inlined"):

- `piece-crypto` → `openpgp` · `piece-duckdb` → `@duckdb/node-api` · `piece-file-helper` → `@zip.js/zip.js`
- `piece-image-helper` → `sharp` · `piece-pdf` → `unpdf` · `piece-text-helper` → `jsdom`
- `piece-todos`, `piece-video-ai` → **`@activepieces/pieces-framework` itself, un-inlined**

Presumably packages with binary/heavy deps keep them external (their engine installs piece
packages with npm). **Correction to doc 06 §2.4 / doc 08 §6.3:** Path B loading needs either a
dependency-installation step per bundle or a Tier-1 conformance rejection for this class.

## 2. piece-subflows introspection

`@activepieces/piece-subflows@0.6.4` — same bundle shape as piece-http (minified CJS, keepNames,
`main` only, loads via `import()` + constructor-name check). `auth: undefined`.

- `callFlow`: `flowId` **DROPDOWN** (options() fn), `mode` STATIC_DROPDOWN (`simple`/`advanced`),
  `flowProps` **DYNAMIC** (props() fn), `waitForResponse` CHECKBOX
- `streamCsvToSubflows`: `file` FILE, `subflow` DROPDOWN (options() fn), `batchSize`, `delimiter`, `extraData`
- `returnResponse`: `mode`, `response` DYNAMIC
- Trigger: `callableFlow` (not probed — trigger lifecycle is still a follow-up spike)

## 3. The answer: options() works out-of-band

```js
await callFlow.props.flowId.options({}, propertyContext)
// → { options: [{ value: "ext-1", label: "Callable Flow" }] }
```

- **Signature:** `options(refresherValues, propertyContext)` — same two-arg shape as DYNAMIC
  `props()` from S6a.
- **PropertyContext surface actually touched: `flows` only.** It calls `flows.list()` and filters
  `data` for `version.trigger.type === "PIECE_TRIGGER" && settings.pieceName === "@activepieces/piece-subflows"`,
  mapping to `{ value: externalId ?? id, label: version.displayName }`. Wrong-trigger flows are
  correctly excluded; an empty list returns well-formed `{ options: [] }`.
- **Correction to doc 06 §2.5:** the guessed PropertyContext ("a searchValue, a connections.get,
  and little else") is incomplete — it must also carry **`flows`** (and, per piece-tables/piece-ai,
  `server`). The needed surface is per-piece, like the runtime context.
- `flows.list` must support a **`{ externalIds: [...] }` filter param**: `flowProps.props()` calls
  `flows.list({ externalIds: ["ext-1"] })` to fetch the selected flow and derive its input props
  (returns e.g. `{ payload: { displayName: "Payload", required: true, type: "OBJECT" } }`).

## 4. Runtime probe: callFlow.run() is engine-coupled

Under the S6a mock context (with `flows` served), `callFlow.run()` touched
`executionType, propsValue, run, server` and threw `TypeError: fetch failed`: it POSTs to
`${server.apiUrl}` with `{ flowId, parentRunId: run.id, callbackUrl, ... }`. The action delegates
flow-triggering to the platform's HTTP API rather than a context capability. For Powerhouse this
piece's actions are superseded by `core#subflow` (doc 08 §4.5) — adapt its *dropdown pattern*,
not its runtime.

## 5. Decision

**PASS.** The design-time channel is mechanically fully available: both `DROPDOWN.options()` and
`DYNAMIC.props()` are plain two-arg async functions invocable outside their engine. The real
Phase-1 work in `context/props.ts` is servicing the PropertyContext per piece (`flows`, `server`,
`connections`, `searchValue`) — a data/capability problem, not a loading problem.

Pinned as tests in `test/activepieces/piece-subflows.test.ts` (loader, descriptor, options()
filtering + empty case, flowProps.props(), externalIds param).
