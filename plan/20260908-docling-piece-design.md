# Docling Connector — Activepieces Piece Design

**Date:** 2026-09-08 · **Status:** Review pass applied 2026-09-08 (framework version split, auth-shape handling, outputSchema semantics; §12 answered below)
**Reads with:** [`06-ap-red-compatible-architecture.md`](./06-ap-red-compatible-architecture.md) (the compatibility claims), [`08-workflow-automation-spec.md`](./08-workflow-automation-spec.md) (the connector contract), [`10-spike-notes-s6a.md`](../packages/reactor-connectors/10-spike-notes-s6a.md) / [`11-spike-notes-s6b.md`](../packages/reactor-connectors/11-spike-notes-s6b.md) (bundle/loading findings).

---

## 1. What we are building

A first Activepieces piece for **Docling** (IBM's document-conversion toolkit, MIT, LF AI & Data
foundation, `docling-project` org): a package that converts documents (PDF, DOCX, images, HTML, …)
into LLM-ready formats (Markdown, docling-document JSON, HTML, DocTags, plain text) by calling a
**docling-serve** v1 REST deployment.

One artifact, two homes (doc 08 §1.1: "a connector authored for Powerhouse is a valid Activepieces
piece"):

1. **`@powerhousedao/piece-docling`** — published to npm, loaded by the reactor via the existing
   Path-B pipeline (fetch → load → descriptor → worker), listed in the workflow-runtime catalog,
   health-checked by the `checkConnection` subgraph.
2. **Upstream PR** to `activepieces/activepieces` at `packages/pieces/community/docling/` — on merge
   their CI publishes `@activepieces/piece-docling` and it appears in the cloud catalog (the one
   our workflow-runtime subgraph already proxies), installable by any Activepieces user from
   *Settings → My Pieces → Install Piece*.

No Docling piece exists today: none of the 764 pieces in the Activepieces cloud catalog matches
"docling" (checked 2026-09-08). Adjacent pieces (CloudConvert, PDF.co, textract, parseur) all talk
to SaaS converters; none drives a self-hosted docling-serve or the Docling-for-IBM-watsonx SaaS.

**Not built:** a Python sidecar (in-process `docling` converter), triggers, batch endpoint, binary
(page-image) outputs. See §10 for the v2 backlog and why.

## 2. Research findings (all verified 2026-09-08)

### 2.1 docling-serve v1.32.0 (2026-09-01; weekly releases; MIT)

Source of truth: `docling-project/docling-serve` (repo moved from `docling-ai/*`), request/response
schemas in `docling-project/docling` under `docling/datamodel/service/*`.

**Endpoint surface** (`docling_serve/app.py`):

| Endpoint | Method | Notes |
|---|---|---|
| `/health`, `/ready`, `/version`, `/metrics` | GET | root-level, **not** under `/v1` |
| `/v1/convert/source` | POST | JSON body; `sources[]` = URL(s) and/or base64 file(s); **sync** |
| `/v1/convert/file` | POST | multipart upload + form-field options; **sync** |
| `/v1/convert/source/async`, `/v1/convert/file/async` | POST | returns `TaskStatusResponse` |
| `/v1/convert/source/batch` | POST | bulk (S3/Azure/GCS/Drive/file sources) |
| `/v1/chunk/{hybrid|hierarchical}/source[/async]`, `/v1/chunk/{…}/file[/async]` | POST | chunking for RAG |
| `/v1/status/poll/{task_id}?wait=<s>` | GET | long-poll capable |
| `/v1/status/ws/{task_id}?api_key=<k>` | WS | push updates; auth via query param |
| `/v1/result/{task_id}` | GET | finished payload |
| `/v1/callback/task/progress` | POST | internal; users register *outbound* webhooks via the request's `callbacks[]` field instead |
| `/v1/clear/converters`, `/v1/clear/results`, `/v1/memory/*` | GET | management, env-gated |

**Request schema (v1 — `ConvertSourcesRequest`):**

```jsonc
{
  "sources": [                       // min 1; max 3 per request by default
    { "kind": "file", "base64_string": "…", "filename": "a.pdf" },
    { "kind": "http", "url": "https://…" }
  ],
  "options": { /* all optional — see below */ },
  "target": { "kind": "inbody" },    // zip | s3 | azure_blob | google_cloud_storage | google_drive | put | presigned_url
  "callbacks": [ /* webhook specs */ ]
}
```

`options` (`ConvertDocumentsOptions`, all optional): `to_formats` (**defaults to `["md"]` only** —
`a client wanting JSON must ask), `from_formats` (all by default), `do_ocr` (default true),`
`force_ocr`, `ocr_preset` (`auto|easyocr|tesseract`), `ocr_lang`, `table_mode` (`fast|accurate`,
default `accurate`), `do_table_structure` (default true), `page_range` (**1-based `[start,end]`** —
the v1 way to cap pages; there is no per-request `max_pages`; the piece exposes it as a
ShortText `start[-end]` builder field parsed to the tuple at runtime — `"5"` = that page only,
`"5-"` = to the last page), `pdf_backend`
(`pypdfium2|docling_parse|threaded_docling_parse`, default `threaded_docling_parse`),
`image_export_mode` (`placeholder|embedded|referenced`, default `placeholder`), `pipeline`
(`legacy|standard|native|vlm|asr`, default `standard`), enrichment flags (formula, code, picture
classification/description, charts), `document_timeout`, `abort_on_error`.

**Chunk request (`/v1/chunk/{hybrid|hierarchical}/source[/async]` JSON):** the chunk request
model (`BaseChunkDocumentsRequest`) names the conversion settings **`convert_options`** — not
`options`. Pydantic silently ignores the convert key on this route, so sending `options` makes
the server use its defaults (OCR/table/page-range settings are dropped). Body shape:
`{ convert_options, sources, chunking_options, include_converted_doc, target, callbacks }`;
the piece omits `chunking_options` (server defaults per chunker — the chunker is selected by
the path), `include_converted_doc` (false) and `callbacks`. File input rides the same
`sources[]` base64 shape (dedicated `/file` multipart routes exist — form fields
`convert_*`/`chunking_*` — but the JSON path is what the piece uses).

**Response (inline, single doc):**

```jsonc
{
  "document": { "filename": "a.pdf",
    "md_content": "…", "json_content": { /* DoclingDocument */ },
    "html_content": "…", "text_content": "…", "doctags_content": "…" },
  "status": "success|partial_success|skipped|failure",
  "errors": [ { "category": "…", "error_message": "…", "page_no": 3 } ],
  "processing_time": 12.4, "timings": { /* per-stage */ }, "confidence": { /* optional */ }
}
```

Only the `*_content` fields requested via `to_formats` are populated. Multiple sources or
`target.kind=zip` → the response is a **zip archive**, not JSON. Async submission returns
`TaskStatusResponse {task_id, task_type, task_status, task_position, task_meta, error_message,
failure:{category, message, retryable, phase}}`; `GET /v1/result/{id}` returns the inline shape
above or a `TaskFailureResult`.

**Auth & deployment:** API key is **optional** — with `DOCLING_SERVE_API_KEY` unset the server
accepts everything; when set, every request needs header `X-Api-Key` (401 otherwise). Default
bind `0.0.0.0:5001`; Docker images `quay.io/docling-project/docling-serve` (GPU) and
`ghcr.io/docling-project/docling-serve-cpu`. **Docling for IBM watsonx** (GA 2026-06, ~$4/1000
pages) is the *same REST API* behind a service URL + key — a docling-serve client with a
configurable base URL covers both.

**Limits (deployment defaults, env-overridable):** `max_sync_wait` **120 s** — sync endpoints
return **504** beyond it (the job may keep running server-side, but the task id is not returned);
`max_sources_per_request` **3**; `max_file_size` / `max_num_pages` unlimited; `document_timeout`
up to 7 days; Ray-engine queue rejection surfaces as 429/503 with `RedisBackpressureError`.

**Gotchas:**
- In-repo `docs/usage.md` examples are **stale** (v0 names: `http_sources`, `file_sources`,
  `ocr_engine`). The v1 code and `docs/v1_migration.md` are authoritative.
- `json_content` is a docling-core `DoclingDocument` (schema-versioned); older readers should send
  `Accept-Docling-Document-Version`.
- Stock images ship only layout + table-structure models; OCR/VLM/enrichment require
  `docling-tools models download` (no auto-download).

### 2.2 Activepieces piece framework — version status (verified 2026-09-08)

**The version split — the load-bearing fact for this piece:**

| | Version | Status |
|---|---|---|
| npm `latest` | **0.32.0** (published 2026-06-17; 0.30/0.31/0.32 shipped weekly in June) | the only current published line — **0.33–0.39 do not exist on npm** |
| GitHub `main` | **0.39.0** | seven unpublished increments ahead; deps moved to `core-utils`/`core-piece-types` + `zod/mini` |

The "2026 surface" below is **main-only**: `classification` on actions/triggers,
`Property.File({ streaming: true })`/`ApStreamingFile`, and auth `getConnectionIdentifier` exist
on main but in **no published version**. We build the piece against published **0.32.0**
(reproducible npm dependency). The reactor's loader is version-agnostic — a piece bundle inlines
its own framework copy, and the `Piece` constructor-name duck type holds on main too, so code
written to the 0.32.0 surface compiles unmodified against main when the upstream PR targets it.
The main-only surface is the v2 upgrade path (§10).

The monorepo was restructured: pieces live under `packages/pieces/{core,community,custom}/` —
**731 community pieces** — and the repo carries a `packages/pieces/CLAUDE.md` "Piece SDK" guide
(the AP team authors pieces with agents).

- **Scaffold:** `npm run create-piece|create-action|create-trigger`; layout
  `src/index.ts` (`createPiece`), `src/lib/auth.ts`, `src/lib/actions/`, `src/lib/trigger/`,
  `src/lib/common/`, `src/i18n/translation.json`. Reference example: `community/airtable`.
- **Auth:** `PieceAuth.SecretText()`, `PieceAuth.OAuth2()`, `PieceAuth.CustomAuth({ props })` —
  all support `validate({ auth, server }) → { valid: true } | { valid: false, error }` (credential
  check) in both 0.32.0 and main; main adds `getConnectionIdentifier({ auth, server }) → string |
  undefined` (the human-readable connection label shown in the UI) — **v2-only for us**.
  `CustomAuth` props: short/long text, number, checkbox, static dropdown, secret text
  (`PieceAuth.SecretText` factory — there is **no** `Property.SecretText` in either version; the
  exported `SecretTextProperty` is a zod schema *value*, not a factory). 0.32.0 hands `validate`
  the **flat** property value (`{ base_url, api_key }`) — the shaped `{ type, props }` object only
  exists on runtime `ctx.auth`. Our `validate` reads the flat value (pure AP semantics); the
  reactor path never calls it — the `checkConnection` shim reads the shaped `ctx.auth` itself (§4.3).
- **Actions:** 0.32.0 `createAction({ name, auth?, displayName, description, props,
  propertyGroups?, run, test?, requireAuth?, errorHandlingOptions?, outputSchema?,
  audience: 'human'|'ai'|'both', aiMetadata: { description?, idempotent? } })` — no
  `classification` (main-only: `'READ'|'SEARCH'|'WRITE'|'DESTRUCTIVE'`) and no `i18n` param.
- **Files:** `Property.File()` → `ApFile { filename, data: Buffer, extension? }` with a `.base64`
  getter (both versions). Main-only: `Property.File({ streaming: true })` →
  `ApStreamingFile { filename, body: Readable, … }` (v2, §10). `ctx.files.write(Readable|Buffer)`
  for outputs — **unused by us** (G2: throwing stub in the reactor); `httpClient` never retries
  stream/form-data bodies.
- **Categories:** `PieceCategory.CONTENT_AND_FILES` is the right bucket for docling.
- **Bundling/publishing:** per-piece `build` (tsc) + `bundle` (CLI, inlines framework + deps into a
  self-contained npm tarball — the format the reactor loads, see spike S6a). Three distribution
  paths (docs `sharing-pieces/`): **community** — rename package to your own npm scope
  (`@my-org/piece-x`) and `npm run publish-piece <folder>`; users install by package name;
  **contribute** — PR into the main repo, maintainer review, merge → automatic
  `@activepieces/piece-x` npm publish and cloud-catalog listing "within a few minutes";
  **private** — enterprise tarball upload.

### 2.3 Our side (reactor-workflow, current `main`)

- **`@powerhousedao/reactor-connectors`:** `ensurePieceBundle` (CDN/npm tarball fetch + dep
  install), duck-typed `loadPiece`, `buildDescriptor`, `PieceWorker` (fork isolation, TLS-poison
  containment, JSON IPC, per-scope in-memory stores), context shims (`propsValue`, `auth`,
  `store`, `connections`; `files`/`server`/`agent` are throwing stubs), engine (block-type parsing
  `<pkg>[@ver]#<action>`, `shapeAuthValue` for `SECRET_TEXT|BASIC_AUTH|CUSTOM_AUTH|OAUTH2|OIDC|NONE`,
  coordinator, expressions).
- **`workflow` package:** `powerhouse/connection` document model (authType/config/secretRefs/
  status/accountLabel), workflow-runtime subgraph (cloud-proxied `pieceCatalog`, actions/triggers
  detail, **`checkConnection` mutation** that loads the bundle and calls
  **`piece.checkConnection(ctx)`** — the fixture suite in `check-connection.test.ts` shows the
  contract: `(ctx) => { name }` on success, throw on failure, secrets resolved into `ctx.auth`,
  bundles loaded from a **local cache directory in the production layout** — no cloud needed),
  encrypted secret store, connection editor driven by the piece's auth descriptor, AI tools
  (`getConnectors`/`getConnections`/`checkConnection`).
- **Editor shim** (`ap-runtime.ts`): already merges a synthetic first-party `@powerhouse/core`
  piece into the catalog with a **data-URI logo** — the precedent for first-party catalog entries.

**Known gaps this piece must work around (verified against source):**

| # | Gap | Consequence for the piece |
|---|---|---|
| G1 | 2026 framework pieces carry **no** `piece.checkConnection` — validation moved to `auth.validate` | The piece exports a **`checkConnection` shim** so the existing subgraph works unmodified (§6.2) |
| G2 | Action `ctx.files` is a throwing stub in the reactor | The piece **never calls `ctx.files.write`**; all outputs are JSON-safe strings/objects (§5) |
| G3 | Worker IPC is JSON: `Buffer` crosses as `{type:"Buffer",data:[…]}`, class instances become plain objects | File values are normalized by a piece-side `toBase64`/`toBuffer` accepting `Buffer \| {data:[…]} \| string` (§5.2) |
| G4 | Server-side catalog proxies only the AP cloud API | First-party entries are merged in the subgraph (§6.1) |

## 3. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | **Home** | New package `packages/piece-docling` in `reactor-workflow`; publish `@powerhousedao/piece-docling`; upstream PR to AP `community/docling` | Doc 08 policy (author for Powerhouse ⇒ valid AP piece). We keep the build, the test rig and release timing; upstreaming is a rename PR, not a rewrite. |
| D2 | **Backend** | docling-serve **v1 REST only** — self-hosted *and* watsonx via `base_url` | One API covers both (verified: same endpoints/auth/schema). A Python sidecar is a different architecture (subprocess in a piece worker, model downloads, GPU) — deferred, documented in §10. |
| D3 | **File transport (v1)** | `Property.File` input → piece-side base64 → **JSON** `POST /v1/convert/source` with `{kind:"file"}` | One code path for file/url/base64 inputs; no multipart; survives G3; no `ctx.files` (G2). Cost: +33 % body size — irrelevant for document sizes. Multipart + `ApStreamingFile` is the v2 optimization when page-image/binary output lands. |
| D4 | **Execution model** | Default **async internally**: submit → long-poll (`?wait=`) → fetch result, with a user `timeoutSeconds` (default 600). Explicit `sync` mode for fast servers. | The 120 s sync cap (504) would otherwise turn medium documents into confusing failures; async is the shape docling-serve recommends for production. |
| D5 | **Action set (v1)** | `convert_file`, `convert_url`, `submit_job`, `get_result`, `chunk`, `health` (6 actions, 0 triggers) | Each action maps 1:1 to an endpoint family; unambiguous required props per action (easier for humans *and* the AI assistant). `submit_job`/`get_result` enable workflows that span runs (task id persisted between steps/runs; the reactor's retry-with-backoff can re-poll). |
| D6 | **Auth** | `PieceAuth.CustomAuth({ props: { base_url (ShortText, required, default `http://localhost:5001`), api_key (SecretText, optional) } })` + `validate` → `GET /health`; connection label from the `checkConnection` shim's `GET /version` (`auth.getConnectionIdentifier` is main-only, v2) | Matches the reactor's `CUSTOM_AUTH` shaping exactly (gotify test precedent). Optional key keeps local dev frictionless; `validate` feeds AP's UI, the shim feeds our connection document's `status`/`accountLabel`. |
| D7 | **Triggers** | None in v1 | docling-serve emits no events. v2 candidates (job-completion polling trigger; webhook via the request's `callbacks[]` field pointed at our inbound-webhook bridge) are documented, not built. |
| D8 | **Bundle** | Own esbuild config: CJS, `keepNames`, `platform: node`, `target: node20`, fully inlined (no externals) — the exact properties spike S6a measured | Acceptance is behavioral: the bundle must pass the existing Tier-1 conformance suite (load → descriptor → worker run) and produce a `metadata()` matching the cloud API's detail shape. We do not fork their monorepo to build. |
| D9 | **Output discipline** | `to_formats` defaults to `["md"]`; `json` opt-in | The docling-document JSON is large; defaulting to Markdown keeps run journals small (doc 08 risk #3). |
| D10 | **AI metadata** | `convert_*`/`chunk`/`get_result`/`health`: `audience: 'both'`, `aiMetadata.idempotent: true` (except `submit_job`: `aiMetadata.idempotent: false`); `classification` (READ/WRITE) is main-only → v2/upstream | `audience`/`aiMetadata` exist in 0.32.0 and are the AI-assistant selection surface; `submit_job` creates server-side state. |

## 4. The piece

Package: `@powerhousedao/piece-docling` (upstream twin: `@activepieces/piece-docling`).
`createPiece({ displayName: "Docling", description: "Convert documents to Markdown, JSON (docling-document), HTML, DocTags and plain text via a docling-serve v1 API.", logoUrl: <data-URI>, authors: […], categories: [CONTENT_AND_FILES], auth: doclingAuth, actions: […] })`.
`minimumSupportedRelease`: the current framework floor (the constructor enforces it anyway).
`i18n/translation.json`: identity-mapped English keys.

### 4.1 Connection (`src/lib/auth.ts`)

```ts
export const doclingAuth = PieceAuth.CustomAuth({
  displayName: 'Docling Serve',
  props: {
    base_url: Property.ShortText({
      displayName: 'Service URL', required: true,
      defaultValue: 'http://localhost:5001',
      description: 'docling-serve base URL (self-hosted) or the Docling-for-IBM-watsonx service URL.',
    }),
    api_key: PieceAuth.SecretText({
      displayName: 'API Key', required: false,
      description: 'The server’s DOCLING_SERVE_API_KEY, sent as X-Api-Key. Leave empty for an unauthenticated local server.',
    }),
  },
  // 0.32.0's AP runtime calls validate with the FLAT property value
  // ({base_url, api_key}) — validate reads it flat (pure AP semantics). The
  // reactor never calls validate: its checkConnection shim (§4.3) performs
  // its own /health with a shape-agnostic auth reader (authFromCtx).
  validate: async ({ auth }) => { /* GET `${auth.base_url}/health`; 401 → invalid key; unreachable/5xx → server error */ },
  // v2 (main 0.39.0): getConnectionIdentifier: GET /version → "docling-serve v1.32.0".
});
```

Reactor mapping: `powerhouse/connection` with `authType: CUSTOM_AUTH`, `config: { base_url }`,
`secretRefs: [{ name: "api_key", ref }]` → `shapeAuthValue` produces exactly the `ctx.auth` shape
above (verified against `engine/connections.ts` + the gotify fixture).

### 4.2 Actions

Shared options block (`src/lib/common/options.ts`) across `convert_file`, `convert_url`, `chunk`:

| Prop | Type | Default | Maps to |
|---|---|---|---|
| `format` | STATIC_DROPDOWN: `markdown` / `markdown + document model` / `all` | `markdown` | `options.to_formats` (`["md"]` / `["md","json"]` / `["md","json","html","text","doctags"]`) |
| `ocr` | CHECKBOX | `true` | `options.do_ocr` |
| `table_mode` | STATIC_DROPDOWN: `fast` / `accurate` | `accurate` | `options.table_mode` |
| `page_range` | OBJECT (optional `[start, end]`, 1-based) | — | `options.page_range` |
| `image_mode` | STATIC_DROPDOWN: `placeholder` / `embedded` / `referenced` | `placeholder` | `options.image_export_mode` |
| `execution` | STATIC_DROPDOWN: `auto (async)` / `sync` | `auto` | sync vs async path (§5.1) |
| `timeout_seconds` | NUMBER | `600` | async polling deadline |

- **`convert_file`** (`READ`, idempotent): `file` (`Property.File`, required) + options.
  Normalizes the file (G3), POSTs `{sources:[{kind:"file",base64_string,filename}], options,
  target:{kind:"inbody"}}` — async path by default. Output: the response's `document` fields
  (only populated ones) + `status` + `errors` + `processing_time`.
- **`convert_url`** (`READ`, idempotent): `url` (required) + options. Same endpoint,
  `{kind:"http"}`. Rejects `.zip` URLs with a clear error (server does).
- **`submit_job`** (`WRITE`, not idempotent): file or url source; POSTs `/async`; output
  `{ task_id, task_status, task_position, task_meta }` — the value to persist for `get_result`.
- **`get_result`** (`READ`, idempotent): `task_id` (required), `wait_seconds` (optional, 0–30,
  default 0). One long-poll; if still pending, returns the status **without failing** (the
  workflow's own retry policy re-runs it). On completion, fetches `/v1/result/{id}` and returns the
  same shape as the convert actions; on task failure, surfaces `failure.{category, message,
  retryable}` as a typed error.
- **`chunk`** (`READ`, idempotent): file or url source (exactly one — both set is rejected) +
  `chunker` STATIC_DROPDOWN (`hybrid`/`hierarchical`) + options minus image-mode. POSTs
  `/v1/chunk/{chunker}/source[/async]` with the conversion settings under `convert_options`
  (see the chunk request note above); output `{ chunks: […], processing_time }` — the RAG entry point.
- **`health`** (`READ`, idempotent): no props. `GET /health` + `/version` →
  `{ status, version }`. Usable standalone (e.g. a pre-flight step) and reused by `validate`.

**Output schema:** every action gets an `outputSchema` **field list** — `{ fields: [{ key,
label?, description? }], itemLabel? }` — a UI descriptor (identical in 0.32.0 and main; it is
*not* a validator) mirroring §2.1's response shape, so the editor's output picker and the AI
assistant see typed fields. Optional internal validation of the response (e.g. rejecting the
unexpected zip payload) lives in the client core, not on the action.

**Errors (mapped in the client core, §5):** 401 → "invalid or missing API key (server
`DOCLING_SERVE_API_KEY` mismatch)"; 422 → the server's detail (bad option/source); 504 (sync) →
"conversion exceeded the server's sync limit — re-run with `execution: auto (async)`"; 429/503
backpressure → retryable; `TaskFailureResult` → `failure.category`-typed, `retryable` honored.

### 4.3 `checkConnection` shim (gap G1)

```ts
const piece = createPiece({ … });
// The reactor subgraph's contract — pre-dates the 2026 auth.validate
// convention; the secret-resolved SHAPED auth arrives in ctx.auth.
piece.checkConnection = async (ctx) => {
  const { baseUrl, apiKey } = authFromCtx(ctx);  // shape-agnostic (props ?? flat)
  // GET /health — 401 → throw "API key rejected"; unreachable/5xx → throw.
  // 0.32.0 has no auth.getConnectionIdentifier — the shim derives the label
  // itself: GET /version → "docling-serve v1.32.0" (1.32.0's keys are
  // hyphenated: body["docling-serve"], with a docling_serve fallback for
  // older builds). Harmless under real Activepieces — AP never calls
  // checkConnection.
};
```

The shim does its HTTP with the framework's `httpClient` directly (no `server` context
member is involved), so the subgraph stays unmodified for v1. A follow-up should
teach the subgraph to call `auth.validate` directly when `checkConnection` is
absent, so *all* pieces on the 2026 framework surface get health checks
(separate, small change — noted, not included).

## 5. Piece internals

```
packages/piece-docling/
├── src/
│   ├── index.ts                  # createPiece + checkConnection shim
│   ├── lib/
│   │   ├── auth.ts               # §4.1
│   │   ├── client.ts             # base-URL join, X-Api-Key, timeouts, 429 backoff, error mapping,
│   │   │                         #   async loop (submit → poll(?wait=) → result), deadline enforcement
│   │   ├── files.ts              # toBase64/toBuffer: Buffer | {type:'Buffer',data:[…]} | string
│   │   ├── options.ts            # prop → ConvertDocumentsOptions builder (incl. format presets)
│   │   └── actions/              # convert-file.ts, convert-url.ts, submit-job.ts,
│   │                             #   get-result.ts, chunk.ts, health.ts
│   └── i18n/translation.json
├── scripts/bundle.mjs            # esbuild: CJS, keepNames, platform node, bundle (no externals)
├── test/
│   ├── mock-docling-serve.ts     # node:http: /health /version /v1/convert/source[/async]
│   │                             #   /v1/status/poll /v1/result /v1/chunk/… + 401/422/504/503/failure
│   └── …                         # suites per §7
└── package.json                  # deps (published npm): @activepieces/pieces-framework@0.32.0,
                                  #   @activepieces/pieces-common@0.12.5, @activepieces/shared@0.95.1
                                  #   (main's core-*/zod-mini split is unpublished — v2, §10)
```

### 5.1 The async loop

```
submit  → POST /v1/convert/{source|file}/async          (or chunk /async)
loop    → GET /v1/status/poll/{id}?wait=5  until {success, failure, partial_success, skipped}
          or until `timeout_seconds` deadline → typed PieceTimeoutError
result  → GET /v1/result/{id}  → inline response  |  zip (unexpected for single source: error)
          |  TaskFailureResult → throw with failure.{category, message, retryable}
```

Long-poll `wait` keeps one HTTP call per 5 s window (mirrors the first-party
`DoclingServiceClient`, which uses the same loop with `job_timeout=300`).

### 5.2 File normalization (gap G3)

```ts
function toBase64(file: unknown): { b64: string; filename: string; extension?: string } {
  // ApFile (real AP):      { filename, data: Buffer, extension }
  // JSON-IPC plain object: { filename, data: { type:'Buffer', data:[…] } | string(base64) }
  // host hydration:        { filename, data: <base64 string> }
  …
}
```

The three shapes are the only ones reachable from the two runtimes (AP file picker ⇒ ApFile;
reactor ⇒ JSON-IPC plain object; our own hydration ⇒ base64 string). One helper, unit-tested
against all three.

## 6. Reactor integration

1. **Catalog (gap G4):** `subgraphs/workflow-runtime/piece-catalog.ts` — merge a
   `FIRST_PARTY_PIECES` summary list (`@powerhousedao/piece-docling`, data-URI logo, version,
   action/trigger counts, `auth` descriptor) into `fetchPieceCatalog()` alongside the cloud
   entries — the server-side twin of the editor shim's `POWERHOUSE_SUMMARY`. After the upstream
   PR merges, the docling entry dedupes: prefer the `@activepieces/` name (cloud wins), drop the
   first-party entry.
2. **checkConnection:** no subgraph change in v1 — the piece's shim (§4.3) satisfies the existing
   `piece.checkConnection(ctx)` call. The fixture suite gains a `docling` case (validate success /
   401 / unreachable → status OK / ERROR / ERROR with `accountLabel` populated).
3. **File values (gap G3): no host-side change needed.** The worker entry already hydrates
   every `FILE`-typed prop before the action runs — `handleRun`/`handleTriggerHook`
   (`worker/entry.ts:148/:183`) run values through `normalizePropsValue`
   (`context/normalize.ts`), whose `toApFile` turns data URIs, http(s) URLs, and file-shaped
   objects into full `ApFile { filename, data: Buffer, base64, extension }`. The piece-side
   normalizer (§5.2) stays as defense-in-depth for any non-worker caller.
4. **No changes to:** `fetch.ts` (any npm name+version already resolves), loader, descriptor,
   worker, auth shaping, secret store.

## 7. Test plan

All suites offline (no network beyond npm-fetch for the bundle in the conformance case, which the
existing `bundle-cache.ts` pattern already handles):

1. **Conformance (Tier-1):** our bundle passes `loadPiece` (constructor-name *or* structural),
   `buildDescriptor` (actions, props, auth, `hasDynamicResolver`), `metadata()` shape matches the
   cloud API detail shape. This is the definition of "a valid bundle" (D8).
2. **Worker execution:** every action through the real `PieceWorker` against the mock
   docling-serve: happy paths (file→md+json, url→md, async job lifecycle, chunk, health), and the
   four error classes (401 / 422 / 504-sync / TaskFailure with `retryable` true and false).
3. **Auth shaping:** `shapeAuthValue` for the docling connection (with and without `api_key`)
   produces the `ctx.auth` the piece expects — mirrors `piece-credentialed.test.ts` (gotify).
4. **checkConnection:** the subgraph against a fixture bundle with the shim: OK / 401 /
   unreachable → `OK` / `ERROR`(+message) / `ERROR`(+message), `accountLabel` from `/version`.
5. **File normalizer:** the three input shapes from §5.2.
6. **Async loop:** deadline expiry → typed error; `partial_success` surfaced with per-page
   `errors[]`; poll `wait` parameter actually sent.
7. **Output schemas:** the attached `outputSchema` field lists match the mock responses'
   shapes; the internal validator rejects the unexpected zip payload.
8. **Live e2e (manual, not CI):** `docker run ghcr.io/docling-project/docling-serve-cpu` + a 2-page
   PDF through the studio workflow editor; confirm Markdown output renders in the run journal.

## 8. Publishing

1. **Own scope:** build (`tsc` for types + esbuild bundle script) → `npm publish`
   `@powerhousedao/piece-docling` (scope already in use by `@powerhousedao/reactor-connectors`
   et al.). The reactor's `ensurePieceBundle` resolves it by name+version.
2. **Upstream:** PR to `activepieces/activepieces` — `packages/pieces/community/docling/` with the
   package renamed to `@activepieces/piece-docling`, plus the `tsconfig.base.json` path entry
   their `CLAUDE.md` requires. On merge: automatic npm publish + cloud catalog listing. Their
   logo CDN (`cdn.activepieces.com/pieces/docling.png`) is the conventional `logoUrl` upstream;
   our own publish keeps the data-URI logo (the `POWERHOUSE_PIECE` precedent).
3. **Versioning:** piece semver independent of docling-serve; the piece declares in its
   description the docling-serve v1 contract it targets (v1.21+ API surface; verified against
   1.32.0).

## 9. Build phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **P0** Scaffold + connection | package skeleton, `doclingAuth` (+`validate`; `getConnectionIdentifier` is main-only, v2), `health` action, bundle script, conformance suite | the reactor loads the bundle, descriptor builds, `health` runs through the worker; `checkConnection` fixture passes |
| **P1** Conversion core | client core (async loop, error mapping, options builder), `convert_file`, `convert_url`, `submit_job`, `get_result`, mock docling-serve, full worker/auth/async test suites | all §7.1–6 suites green; a real docling-serve (CPU docker) converts a PDF end-to-end through the studio |
| **P2** Chunking + polish | `chunk` action, format presets, i18n, output field descriptors, logo, description | §7.5–7 green; editor shows the piece with correct metadata |
| **P3** Publish + catalog | npm publish, first-party catalog merge; E2E verifies the worker-side file hydration (already in `normalize.ts` — no host change) | a workflow with a `FILE` step input runs unmodified in the reactor; AI `getConnectors` lists Docling |
| **P4** Upstream | PR to AP community dir, watsonx smoke test (their service URL + key, read-only health/convert) | PR merged ⇒ cloud catalog lists `@activepieces/piece-docling`; first-party entry deduped |

## 10. v2 backlog (explicitly not built)

- **Framework upgrade (0.33+/main 0.39.0):** when AP resumes npm publishing, re-target the
  piece to gain `classification` (READ/WRITE labels for the AI assistant), auth
  `getConnectionIdentifier` (the shim's `/version` call moves into the framework), and
  `Property.File({ streaming: true })`/multipart; the 0.32.0 surface is a strict subset, so
  the port is additive.
- **Triggers:** (a) polling trigger "job completed" (user supplies `task_id`; piece polls and emits
  with `_dedupe_key = task_id` — dedup contract from spike S6b); (b) webhook trigger fed by
  docling-serve's request-level `callbacks[]` pointed at our inbound-webhook bridge (doc 08 §7
  recipes). Both need the trigger-supervisor surface matured first.
- **Multipart + streaming:** `/v1/convert/file` with `Property.File({ streaming: true })`
  (`ApStreamingFile`) for large documents; requires the reactor's FilesService to stop being a
  throwing stub (G2) and `httpClient` stream semantics (no retries on streams).
- **Binary outputs:** page images (`include_page_images`, `image_export_mode: referenced` →
  presigned URLs) via a real FilesService adapter backed by `reactor-attachments`.
- **Batch:** `/v1/convert/source/batch` for multi-document jobs (server `max_sources_per_request`
  is 3 by default — batch is the sanctioned path beyond that).
- **Management actions** (`/v1/clear/*`, `/v1/memory/*`): env-gated server endpoints; only if a
  user explicitly wants them, classified `DESTRUCTIVE`.
- **Python sidecar alternative:** in-process `DocumentConverter` (one-liner, `export_to_*`)
  instead of HTTP — only relevant if a deployment cannot run docling-serve at all; a different
  piece, different isolation story.

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | docling-serve v1 is young and moving (v0→v1 rename happened recently; weekly releases) | Client targets the stable v1 surface only; mock server pins the contract in tests; piece description declares the target version range; re-run conformance on every docling-serve minor |
| R2 | AP bundle format is a private contract (doc 05 §5.1) | Our own esbuild config is stable under our control; Tier-1 conformance is the acceptance gate, not their toolchain version |
| R3 | Upstream PR may be rejected or sit in review | The piece works identically under our scope; upstream is an enhancement, not a dependency |
| R4 | docling-document JSON bloats run journals | Markdown-only default (D9); `json` opt-in; journal-size discipline from doc 08 §10 |
| R5 | IPC JSON mangling of file values (G3) | single normalization helper, unit-tested over all three shapes |

## 12. Open questions (for you)

1. **npm scope** — `@powerhousedao/piece-docling` as published name, or a different scope?
2. **v1 size** — six actions as specified, or should `chunk` wait for v1.1 to keep P1 tight?
3. **watsonx** — is a managed Docling-for-IBM-watsonx deployment part of your intended usage
   (it's free with D6, but P4's smoke test only makes sense if yes)?

**Reviewer answers (2026-09-08):**
1. **Keep `@powerhousedao/piece-docling`.** The scope is already the workspace's publishing
   scope (`reactor-connectors`, `workflow`, …); a different scope buys nothing, and the
   upstream twin uses `@activepieces/` regardless.
2. **Keep `chunk` in v1 (P2).** It reuses the client core + file + options almost entirely
   (only the endpoint path and the `chunker` prop differ), so it costs one isolated task
   (plan Task 12) and does not bloat P1. If the thinnest possible v1 is preferred, it is the
   one clean thing to defer to v1.1 — the plan keeps it isolated in P2 for exactly that reason.
3. **Optional P4 smoke step.** Watsonx is the same API via `base_url` (free with D6): if you
   have a service URL + key, run a read-only `health` plus one small conversion against it;
   otherwise skip — nothing in v1 depends on it.

## 13. Sources

- docling-serve repo (`docling-project/docling-serve` @ v1.32.0): `app.py` (routes), `auth.py`
  (`X-Api-Key`), `settings.py` (defaults: port 5001, `max_sync_wait` 120, `max_sources_per_request`
  3), `docs/v1_migration.md`, `pyproject.toml`, `CHANGELOG.md`
- docling core (`docling-project/docling`): `datamodel/service/{requests,responses,options,
  targets}.py`, `base_models.py` (format enums), `service_client/client.py`,
  `document_converter.py`
- Official REST API reference: docling-project.github.io/docling/usage/api_server/rest_api/
- Docling for IBM watsonx: docling-project.github.io/docling/usage/api_server/managed/ (GA
  2026-06-15, $4/1000 pages, same API)
- Activepieces (`activepieces/activepieces` @ main, 2026-09-08): `packages/pieces/CLAUDE.md`
  (Piece SDK), `packages/pieces/framework/src/lib/{piece,action/action}.ts`,
  `property/{authentication/{common,custom-auth-prop,secret-text-property},input/file-property}.ts`,
  `core/piece-types/src/lib/piece.ts` (`PieceCategory`), `community/airtable/` (reference piece),
  `docs/build-pieces/sharing-pieces/{community,contribute,private}.md`
- Activepieces cloud catalog: `https://cloud.activepieces.com/api/v1/pieces` (764 pieces, no
  docling — checked 2026-09-08)
- npm registry (2026-09-08): `@activepieces/pieces-framework` latest = **0.32.0**
  (2026-06-17; 0.33–0.39 unpublished); `@activepieces/pieces-common` latest = 0.12.5;
  `@activepieces/shared` latest = 0.96.2 (0.32.0's own dependency: 0.95.1). 0.32.0's `.d.ts`
  verified from the published npm tarball.
- This repo: spike notes S6a/S6b, `src/activepieces/*`, `src/engine/connections.ts`,
  `subgraphs/workflow-runtime/{piece-catalog,check-connection.test,service}.ts`,
  `editors/workflow-editor-ap/shims/ap-runtime.ts` (`POWERHOUSE_PIECE`),
  plan docs 06/08
