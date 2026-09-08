# Paperless-ngx Connector — Activepieces Piece Design

**Date:** 2026-09-08 · **Status:** Draft for review
**Reads with:** [`06-ap-red-compatible-architecture.md`](./06-ap-red-compatible-architecture.md) (compatibility claims),
[`08-workflow-automation-spec.md`](./08-workflow-automation-spec.md) (connector contract, §7.2 webhook ingress),
[`20260908-docling-piece-plan.md`](./20260908-docling-piece-plan.md) (the first piece; bundle shape, pinned framework
versions, esbuild config — reused verbatim here).

All repo facts in this document were verified against **`origin/main` @ `5c0b72d`**, not a feature branch.
All Paperless facts were verified against **paperless-ngx `main` / v3.1.3** (released 2026-09-04) on 2026-09-08.

---

## 1. What we are building

Three deliverables, one spec. They are separated into parts that review independently, and the phase table
(§9) gates them so each lands with a working consumer.

1. **`@powerhousedao/piece-paperless-ngx`** — a full-connector Activepieces piece for
   [paperless-ngx](https://github.com/paperless-ngx/paperless-ngx), the self-hosted document management
   system: 9 actions and 2 push triggers over its REST API. Published to npm and loaded by the reactor
   through the existing Path-B pipeline; upstream twin PR'd to `activepieces/activepieces` as
   `packages/pieces/community/paperless-ngx/`.
2. **AttachmentBridge** — a real `ctx.files` for *actions*, closing gap G2. Required by the piece's file
   actions; reusable by every future piece (74 upstream pieces call `ctx.files`).
3. **Webhook ingress** — a `fireWorkflowWebhook` mutation on the workflow-runtime subgraph, letting
   Paperless (and any provider that can POST JSON with custom headers) start a workflow run. This is the
   doc 08 §7.2 capability, delivered through GraphQL rather than a mounted HTTP route — see §7 for why
   that is both possible and preferable here.

**No Paperless piece exists upstream.** The Activepieces cloud catalog holds 764 pieces
(`https://cloud.activepieces.com/api/v1/pieces`, checked 2026-09-08); none matches paperless, DMS or
document management. Adjacent pieces (Google Drive, Dropbox, S3) are file *stores*, not document
management systems with OCR, correspondents, tags and full-text search.

**Not built in v1:** document versions, permissions/ownership, saved views, mail accounts and rules,
users and groups, app config, trash operations, the 3.x AI endpoints, and `include_document` webhook
payloads. See §10 for the backlog and why each waits.

---

## 2. Research findings

### 2.1 paperless-ngx v3.1.3 REST API

Base path `/api/`; a browsable schema lives at `/api/schema/view/`.

**Resource endpoints** (`src/paperless/urls.py`, full CRUD viewsets): `documents` (a
`UnifiedSearchViewSet`), `correspondents`, `document_types`, `tags`, `storage_paths`, `custom_fields`,
`saved_views`, `tasks`, `users`, `groups`, `mail_accounts`, `mail_rules`, `processed_mail`,
`share_links`, `share_link_bundles`, **`workflows`**, **`workflow_triggers`**, **`workflow_actions`**,
`config`, `logs`. Plus non-router routes: `remote_version/`, `ui_settings/`, `token/`, `profile/`
(+ `profile/generate_auth_token/`), `status/`, `trash/`.

That the three `workflow*` endpoints are writable viewsets is what makes §4.2's auto-registration
possible.

**Authentication** — five forms; we use **token auth**: `Authorization: Token <token>`. A token is minted
in the web UI (My Profile → the circular-arrow button) or via `POST /api/token/` with username and
password. Basic auth, session auth, remote-user auth and headless OIDC also exist and are out of scope.

**API versioning** — the API is versioned via a request header:

```
Accept: application/json; version=10
```

Supported versions are **9 and 10**; the server default is currently 10. An invalid version yields
`406 Not Acceptable`. Every authenticated response carries `X-Api-Version` and `X-Version`
(server version) headers, which is the sanctioned client-compatibility handshake.

This is not cosmetic. The task serializers diverge:

| API v9 | API v10 |
|---|---|
| `related_document` (single int, from the first id in `result_data`) | `related_document_ids` (list) |
| `task_file_name` (derived from `input_data.filename`) | absent |

An unpinned client therefore gets a *different shape* for "which document did my upload create?" the day
the server's default version moves. **We pin `version=10` on every request** (D3).

**Document upload** — `POST /api/documents/post_document/`, **multipart only**; no JSON or base64 path
exists. Form field `document` carries the file; optional fields `title`, `created`, `correspondent`,
`document_type`, `storage_path`, `tags` (repeatable), `archive_serial_number`, `custom_fields` (an array
of ids, or an object mapping id → value). The endpoint returns **HTTP 200 immediately with the
consumption task's UUID** — the document does not exist yet. Progress is observed at
`/api/tasks/?task_id={uuid}`.

**Consumption task model** (`PaperlessTask`, `src/documents/models.py`):

- `Status` values are **lowercase**: `pending`, `started`, `success`, `failure`, `revoked`.
- `COMPLETE_STATUSES = (success, failure, revoked)` — the terminal set a poll loop must wait for.
- `TaskType.CONSUME_FILE = "consume_file"`; `TriggerSource.API_UPLOAD = "api_upload"`.

**Full-text search** on `/api/documents/` (Tantivy-backed) via query parameters: `query=` (full syntax),
`text=` (substring over title and content), `title_search=` (title only), `more_like_id=` (similarity).
Search results carry an extra `__search_hit__` object with `score`, `highlights` (HTML `<span
class="match">` markup) and `rank`. Pagination is the standard `count`/`next`/`previous`/`results` shape.
`/api/search/autocomplete/?term=&limit=` returns a bare string array.

**Bulk editing** — `POST /api/documents/bulk_edit/` with `{documents, method, parameters}`. Methods:
`set_correspondent`, `set_document_type`, `set_storage_path`, `add_tag`, `remove_tag`, `modify_tags`,
`delete`, `reprocess` (optional `{remote_ocr: true}`), `set_permissions`, `modify_custom_fields`. Object
bulk editing is `POST /api/bulk_edit_objects/` with `{objects, object_type, operation, ...}` where
`object_type` ∈ `tags | correspondents | document_types | storage_paths` and `operation` ∈
`set_permissions | delete`.

Note the deprecation: from API version 10, the document-*editing* operations (`merge`, `rotate`,
`edit_pdf`, …) have individual endpoints; the `bulk_edit` route keeps them for compatibility but clients
"should migrate before they are removed". We model only the metadata methods above, which are not
deprecated.

**Binary reads** — `GET /api/documents/{id}/download/`, `/preview/`, `/thumb/`, `/metadata/`, all
accepting `?version={version_id}`. The document JSON's `content` field holds the extracted OCR text,
which is often megabytes.

### 2.2 Paperless workflows and the webhook action

Paperless has its own workflow engine, and one of its action types is an outbound webhook. This is what
makes a *push* trigger possible.

**Trigger types** (`WorkflowTrigger.WorkflowTriggerType`, integer choices):

| Value | Name | `{{doc_id}}` available? |
|---|---|---|
| `1` | Consumption Started | **no** — the document does not exist yet |
| `2` | Document Added | yes |
| `3` | Document Updated | yes |
| `4` | Scheduled | yes |

Server-side filters on a trigger: `filter_filename` (wildcards), `filter_path`, `filter_mailrule`,
`filter_source` (`DocumentSourceChoices`: consume folder, api upload, mail fetch, web UI), content
matching (`matching_algorithm` ∈ none/any/all/literal/regex/fuzzy + `match`), and for added/updated/
scheduled: any-tags, all-tags, no-tags, document type / not-document-types, correspondent /
not-correspondents, storage path / not-storage-paths, and a custom field query.

**Webhook action** (`WorkflowAction.WorkflowActionType.WEBHOOK = 4`, model `WorkflowActionWebhook`):

| Field | Notes |
|---|---|
| `url` | `CharField(max_length=256)` — **a hard 256-character budget** |
| `use_params` | default true; selects `params` over `body` |
| `params` | JSONField; each **value** is Jinja-templated |
| `body` | TextField; Jinja-templated as a whole |
| `as_json` | default false |
| `headers` | JSONField, arbitrary |
| `include_document` | default false; attaches the file itself |

**How it is sent** (`src/documents/workflows/webhooks.py`, a Celery task):

```python
if as_json:                    post_args["json"] = data
elif isinstance(data, dict):   post_args["data"] = data
else:                          post_args["content"] = data
```

`data` is a **dict** when `use_params` was used and a **string** when `body` was used. So
`as_json: true` + `body` JSON-encodes a *string*, producing `"\"{…}\""` — a quoted literal, not an
object. The only configuration that yields a genuine JSON object body is
**`use_params: true` + `as_json: true`**, which is what §7 uses.

Further properties of the sender, each of which constrains the design:

- `timeout=5.0` — the receiver has **five seconds** to respond.
- `@shared_task(retry_backoff=True, autoretry_for=(httpx.HTTPStatusError,), max_retries=3)` combined with
  `raise_for_status()` — a non-2xx is retried up to three times with backoff, so **duplicate deliveries
  must be expected**. A GraphQL endpoint answers 200 even for logical errors, so Paperless will *not*
  retry those; the trigger must surface them itself.
- `follow_redirects=False` — an `http`→`https` redirect fails silently.
- Headers pass through verbatim except `host`, which is stripped.
- `PinnedHostHTTPTransport(allow_internal=settings.WEBHOOKS_ALLOW_INTERNAL_REQUESTS)` — DNS-pinned
  against rebinding.
- `include_document: true` populates httpx's `files=`, which cannot coexist with `json=`.

**Deployment gates** (`docs/configuration.md`, "Workflow webhooks"):
`PAPERLESS_WEBHOOKS_ALLOWED_SCHEMES` (default `http,https`), `PAPERLESS_WEBHOOKS_ALLOWED_PORTS` (default
empty = all allowed), `PAPERLESS_WEBHOOKS_ALLOW_INTERNAL_REQUESTS` (**default true**). So a localhost
reactor works out of the box, and a hardened install is the exception rather than the rule — but a
silent one, hence the §4.2 preflight.

**Templating** (`src/documents/templating/workflows.py`): real Jinja2 with a **sandboxed environment**,
`StrictUndefined` wrapped in a logging undefined, and `find_undeclared_variables` validation. Filters
added: `datetime`, `slugify`, `localize_date`. The known placeholder set has **24 names**:
`correspondent`, `document_type`, `owner_username`, `added`, `added_year`, `added_year_short`,
`added_month`, `added_month_name`, `added_month_name_short`, `added_day`, `added_time`,
`original_filename`, `filename`, `created`, `created_year`, `created_year_short`, `created_month`,
`created_month_name`, `created_month_name_short`, `created_day`, `created_time`, `doc_title`, `doc_url`,
`doc_id`. Anything else raises.

Two consequences: only `{{`, `{%` and `{#` are special (a bare `}}` is literal text), so a GraphQL
document survives templating **provided no two opening braces are ever adjacent**; and since values are
rendered as raw strings, interpolating anything but an integer risks producing invalid JSON (a document
titled `Invoice "Q3"` would break a `"title": "{{doc_title}}"` payload). We therefore interpolate
**only `{{doc_id}}`** and hydrate everything else server-side.

**Workflow permissions**: workflows in Paperless deliberately have no owner and no per-object
permissions; editing them requires the "edit workflows" application permission. Auto-registration
therefore needs a reasonably privileged token, and must degrade gracefully when it does not have one.

### 2.3 Our side — reactor-workflow @ `origin/main` `5c0b72d`

**`@powerhousedao/reactor-connectors`.** `ensurePieceBundle` (tarball fetch + dep install), duck-typed
`loadPiece`, `buildDescriptor`, `PieceWorker` (fork isolation, TLS-poison containment, JSON IPC), context
shims, and the engine (block-type parsing, `shapeAuthValue` for
`SECRET_TEXT|BASIC_AUTH|CUSTOM_AUTH|OAUTH2|OIDC|NONE`, coordinator, expressions).

The worker protocol (`worker/protocol.ts`) carries five request types — `run`, `resolve-options`,
`trigger-hook`, `check-connection`, `describe` — and exactly two response types, `result` and `error`.
**It is strictly one-directional:** everything a piece needs is pre-resolved and pushed in (`auth`,
`connections`, `storeState`), and mutated state returns whole in the response (`storeState` out). There
is no worker→host RPC channel. §6 is built around this.

`CheckConnectionOutcome` is `{ declared: boolean, result?: unknown }`, where `declared` is false when the
piece exposes no `checkConnection`, and `result` may be `void | boolean | { name | username | email |
sub }`. The host tolerates a piece without one.

**Dynamic properties are fully wired.** `descriptor.ts` records `hasDynamicResolver` and
`dynamicResolverId`; `context/props.ts` invokes `DROPDOWN options()` / `DYNAMIC props()` resolvers; the
worker carries a `resolve-options` message; and the subgraph exposes a `blockOptions` query whose service
path supplies the step's connection for auth-dependent resolvers. Real pickers work.

**Trigger supervisor** (`subgraphs/workflow-runtime/trigger-supervisor.ts`) is **polling-only**: it owns
leases, cursors (`trigger_state`), dedupe (`trigger_dedup` with TTL, `extractDedupeKey`), a 60 s
`MIN_INTERVAL_MS`, backoff to a 30 min ceiling, and honours exactly one cron shape (`*/N * * * *`). It
hands every trigger a placeholder `webhookUrl` of `http://localhost:0/v1/webhooks/${binding.workflowId}`
(line 222) and never reads the descriptor's `strategy` field.

**Host capability surfaces** (from `@powerhousedao/reactor-api@6.2.2-dev.77`, a consumed package):

| Surface | Has `httpAdapter`? | Has attachments? |
|---|---|---|
| `API` (constructed by the host app) | ✅ `IHttpAdapter` | ✅ `AttachmentBuildResult`, `attachmentAccess` |
| `IProcessorHostModule` (given to processor factories) | ❌ | ✅ **`attachments: IAttachmentClient`** |
| `SubgraphArgs` (given to subgraphs) | ❌ | ❌ |

`IHttpAdapter.mountNodeRoute(method, path, handler)` exists exactly as doc 08 §7.2 assumed, with raw
`http.IncomingMessage` / `ServerResponse`. It is simply **not reachable from a package** — neither
subgraphs nor processors receive it. This is the same gap doc 09 recorded for secrets. §7 routes around it
rather than waiting on an upstream change.

The GraphQL `Context` is `{ driveId?, document?, headers: IncomingHttpHeaders, db, user? }` — resolvers
**do** get request headers, and `user` tells us whether auth was enforced.

**Gaps this work must handle:**

Gap numbering continues the Docling plan's. **G1 there — "2026 framework pieces carry no
`piece.checkConnection`, so the piece must export a shim" — is obsolete on `origin/main`:** the worker's
`CheckConnectionOutcome.declared` flag means the host tolerates a piece without one, so no shim is
needed. We still declare `checkConnection` (§4.1), but as the source of the connection document's
`status` and `accountLabel`, not as a workaround.

| # | Gap | Where it is addressed |
|---|---|---|
| G2 | Action `ctx.files` is a throwing stub (`context/action.ts:134`), and `ActionContextOptions` has no injection point for one | §6 — AttachmentBridge |
| G3 | Worker IPC is JSON: a `Buffer` crosses as `{type:"Buffer",data:[…]}` and class instances flatten to plain objects | §5.3 — one normalizer, three shapes |
| G4 | The subgraph catalog proxies only the AP cloud API, so first-party pieces are invisible | §8 — `FIRST_PARTY_PIECES` merge (same as Docling) |
| G5 | No HTTP route mounting is reachable from a package | §7 — GraphQL mutation instead |
| G6 | The supervisor ignores `strategy` and cannot enable a webhook trigger | §7.3 — strategy dispatch |

---

## 3. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | **Home** | New package `packages/piece-paperless-ngx` → `@powerhousedao/piece-paperless-ngx`; upstream PR to AP `community/paperless-ngx` | Doc 08 policy, Docling D1 precedent. Upstreaming is a package rename, not a rewrite |
| D2 | **Auth** | `PieceAuth.CustomAuth({ props: { base_url: ShortText, token: SecretText } })`, `validate` → `GET /api/ui_settings/`, `getConnectionIdentifier` → `<username>@<host> (v<X-Version>, API <X-Api-Version>)` | Token auth is Paperless's native machine path. `ui_settings` is cheap *and* returns the caller's identity; the version headers come free on the same response |
| D3 | **Pin the API version** | Every request sends `Accept: application/json; version=10` | v9/v10 disagree on the task fields the upload action depends on (§2.1). Unpinned, the output shape changes under us on a server upgrade |
| D4 | **Action set** | 9 actions: `upload_document`, `get_document`, `get_document_file`, `search_documents`, `update_document`, `bulk_edit_documents`, `find_or_create_object`, `get_task`, `custom_api_call` | Lean core plus the AP-convention escape hatch. A 1:1 mapping of 18 resource endpoints would be 40+ near-duplicate actions; `custom_api_call` covers the tail at a fraction of the review cost |
| D5 | **File transport** | Out: `ctx.files.write` → `attachment://v1:<sha256>` ref (§6). In: multipart from a `Property.File` input | Paperless has **no** JSON/base64 upload path, so multipart is forced — unlike Docling D3, which chose base64 precisely to avoid it |
| D6 | **Consumption is async** | `upload_document` → task UUID → poll `/api/tasks/?task_id=` to a `COMPLETE_STATUSES` member; `wait_for_consumption` (default true), `timeout_seconds` (default 300) | `post_document` returns 200 before the document exists. Without the loop, the next step gets a UUID and no document |
| D7 | **Triggers** | Two webhook triggers: `new_document` (type `2`) and `document_updated` (type `3`), each auto-registering its Paperless side | `{{doc_id}}` exists only on these two. Consumption-started (type `1`) cannot identify a document, so it has nothing useful to emit |
| D8 | **Webhook credential** | An opaque 32-byte base64url token in the `X-Powerhouse-Webhook-Token` **header**, stored as `sha256` only, compared in constant time | Paperless does not HMAC-sign webhooks, so doc 08 §7.2's raw-byte signature verification does not apply — the token *is* the credential. A header keeps it out of GraphQL query logs and traces |
| D9 | **Ingress transport** | A `fireWorkflowWebhook` GraphQL mutation on the workflow-runtime subgraph, not a mounted HTTP route | G5: no route mounting is reachable from a package. Paperless can POST arbitrary JSON with arbitrary headers, so the GraphQL endpoint switchboard already serves is a valid receiver. Avoids a second listener, a second port, and a cross-repo dependency |
| D10 | **Pickers** | Dynamic `DROPDOWN` (`refreshers: ['auth']`) for tags, correspondent, document type, storage path and custom field | Verified wired end-to-end (§2.3). Raw numeric ids would make every write action unusable by hand |
| D11 | **Journal discipline** | The document `content` field is omitted unless `include_content: true` | It holds the full OCR text — routinely megabytes. Docling D9's lesson; doc 08 risk #3 |
| D12 | **Only `{{doc_id}}` is interpolated** | The registered Jinja payload carries the document id and nothing else; the trigger hydrates via `GET /api/documents/{id}/` | Jinja renders raw strings, so any text placeholder can produce invalid JSON. An integer cannot (§2.2) |

---

## 4. The piece

Package `@powerhousedao/piece-paperless-ngx` (upstream twin `@activepieces/piece-paperless-ngx`), built
against the same pinned framework as Docling: `@activepieces/pieces-framework@0.32.0`,
`@activepieces/pieces-common@0.12.5`.

```ts
createPiece({
  displayName: "Paperless-ngx",
  description: "Manage documents in a self-hosted paperless-ngx archive: upload, search, tag, and react to new documents.",
  logoUrl: <data-URI>,
  categories: [PieceCategory.CONTENT_AND_FILES],
  auth: paperlessAuth,
  actions: [...],
  triggers: [...],
})
```

### 4.1 Connection (`src/lib/auth.ts`)

```ts
export const paperlessAuth = PieceAuth.CustomAuth({
  props: {
    base_url: Property.ShortText({
      displayName: "Base URL",
      required: true,
      description: "e.g. https://paperless.example.com — no trailing slash, no /api suffix",
    }),
    token: PieceAuth.SecretText({
      displayName: "API Token",
      required: true,
      description: "Paperless web UI → My Profile → API Token",
    }),
  },
  validate: async ({ auth }) => { /* GET /api/ui_settings/ → { valid } | { valid: false, error } */ },
})
```

`validate` maps status codes to messages a user can act on: `401`/`403` → "token rejected";
`404` → "not a paperless-ngx API — check the base URL"; `406` → "server does not support API version 10";
a connection error → "unreachable". `getConnectionIdentifier` returns
`<username>@<host> (v3.1.3, API 10)` from the `ui_settings` body plus the `X-Version` / `X-Api-Version`
response headers.

The piece also exposes **`checkConnection`**, returning `{ username }` from the same call. Per §2.3 the
host tolerates its absence (`declared: false`), but declaring it is what populates the connection
document's `status` and `accountLabel` — so it is not optional in practice.

At runtime `ctx.auth` arrives as `{ type: "CUSTOM_AUTH", props: { base_url, token } }`, matching
`shapeAuthValue`'s `CUSTOM_AUTH` branch.

### 4.2 Actions

| Action | Class · idempotent | Props (required **bold**) | Output |
|---|---|---|---|
| `upload_document` | WRITE · no | **file**, title, created, correspondent▾, document_type▾, storage_path▾, tags▾ (multi), archive_serial_number, custom_fields, wait_for_consumption (default true), timeout_seconds (default 300) | `{ task_id, status, document_id?, document? }` |
| `get_document` | READ · yes | **id**, include_content (default false), version | the document JSON |
| `get_document_file` | READ · yes | **id**, variant (`original` \| `preview` \| `thumbnail`), version | `{ ref, filename, mime_type, size }` |
| `search_documents` | SEARCH · yes | mode (`full_text` \| `substring` \| `title_only` \| `more_like`), **term** or **document_id**, tags▾/correspondent▾/document_type▾/storage_path▾ filters, created/added ranges, custom field query, ordering, page, page_size, include_content | `{ count, next, previous, results[] }`, each result keeping `__search_hit__` on full-text |
| `update_document` | WRITE · yes | **id**, title, created, correspondent▾, document_type▾, storage_path▾, tags▾, tag_mode (`replace` \| `add` \| `remove`), archive_serial_number, owner, custom_fields | the updated document |
| `bulk_edit_documents` | WRITE · no | **document_ids**, **method**, method-specific parameters via `DynamicProperties` | `{ result }` |
| `find_or_create_object` | WRITE · yes | **object_type** (`tags` \| `correspondents` \| `document_types` \| `storage_paths` \| `custom_fields`), **name**, type-specific extras via `DynamicProperties` | `{ id, name, created }` |
| `get_task` | READ · yes | **task_id** | the task row incl. `related_document_ids` |
| `custom_api_call` | WRITE · no | **method**, **path** (relative to `/api/`), query, body, headers | raw response |

▾ = dynamic dropdown (D10).

Two notes on the less obvious ones. `bulk_edit_documents` uses `Property.DynamicProperties` keyed on the
chosen `method`, so picking `modify_tags` presents add/remove tag pickers rather than a raw JSON
`parameters` blob — the same technique gives `find_or_create_object` a tag colour field for tags, a
`data_type` for custom fields, and a `path` for storage paths. And `find_or_create_object` is what makes
ingest workflows viable at all: mail-derived sender names have to become correspondent ids before
`upload_document` can use them, and it does that with `?name__iexact=` followed by a POST when absent.

`update_document`'s `tag_mode` exists because a bare PATCH to `tags` replaces the whole list. Without it,
adding one tag means read-modify-write in the workflow, which races against Paperless's own workflows.

Two assumptions to settle during implementation rather than design. `custom_fields` is sent as an object
mapping field id → value (the form also accepts a bare array of ids to attach empty, which we accept as an
alternative input shape and normalise). And `find_or_create_object`'s lookup assumes `?name__iexact=` is
exposed by each of the five viewsets' filtersets — true for tags, correspondents and document types by
inspection, unconfirmed for storage paths and custom fields; where it is absent the client falls back to a
paged scan comparing case-insensitively. P2 confirms this per object type against a live server.

### 4.3 Triggers

Both triggers are `TriggerStrategy.WEBHOOK` and share one implementation, differing only in the Paperless
trigger `type` they register (`2` for added, `3` for updated).

Props mirror Paperless's own server-side filters, so filtering happens in Paperless and we never receive
and discard: `filter_filename`, `filter_source`, `filter_has_tags` / `filter_has_all_tags` /
`filter_has_not_tags`, `filter_correspondent`, `filter_document_type`, `filter_storage_path`, plus
content matching (`matching_algorithm` + `match`).

**`onEnable`** — a preflight, then three POSTs, then persistence:

1. **Preflight.** `GET /api/workflows/` to confirm the token holds the "edit workflows" permission. On
   `403`, fail with an error containing the exact JSON to paste into the Paperless UI for manual setup —
   not a bare permission error. Also refuse when no reachable public URL is configured.
2. `POST /api/workflow_triggers/` → `{ type: 2, filter_*, matching_algorithm, match }`.
3. `POST /api/workflow_actions/` → the webhook action of §7.1.
4. `POST /api/workflows/` → `{ name: "Powerhouse: <flowId>", enabled: true, order, triggers: [id], actions: [id] }`.
5. Store all three ids in `ctx.store` so `onDisable` can delete them.

**`onDisable`** deletes the workflow, then the action, then the trigger, tolerating a `404` on each (a
user may have removed them by hand).

**`run`** receives the mutation's payload, hydrates the document with `GET /api/documents/{doc_id}/`
(honouring `include_content`), and emits one item with `_dedupe_key = <doc_id>:<event>:<modified>`.

`onEnable` is idempotent under `isRepublish`: if the stored ids still resolve, it reuses them rather than
creating a duplicate Paperless workflow.

---

## 5. Piece internals

### 5.1 The client

One `src/lib/common/client.ts` wrapping the framework's `httpClient` so thrown errors keep the
`HttpError` shape the reactor's failure classifier expects. It owns: base-URL normalisation (strip a
trailing slash, reject a `/api` suffix with a clear message), the `Authorization: Token` header, the
`Accept: application/json; version=10` header (D3), pagination helpers, and status→error mapping
(`400`/`422` → validation detail from the DRF error body, `401`/`403` → credential, `404` → not found,
`406` → API version, `5xx` → retryable).

### 5.2 The consumption loop

`upload_document` with `wait_for_consumption` polls `/api/tasks/?task_id={uuid}` with jittered backoff
until `status ∈ {success, failure, revoked}` or the deadline. On `success` it reads
`related_document_ids[0]` (v10, per D3) and optionally fetches the document. On `failure` it raises with
the task's error text. On `revoked` it raises distinctly — a revoked task is not a retryable failure.
Deadline expiry returns the task id with `status: "pending"` rather than throwing, so a workflow can hand
it to `get_task` in a later run.

### 5.3 File normalisation (gap G3)

A `Property.File` value reaches the piece as one of three shapes: an `ApFile` from Activepieces' own
picker; a plain object `{ filename, data: { type: "Buffer", data: [...] } }` after JSON IPC flattening;
or a base64 string from our own hydration. One helper accepts all three and yields
`{ filename, buffer, contentType }`, unit-tested against each. This is Docling §5.2's helper, reused.

Multipart assembly is explicit rather than delegated: the framework's `httpClient` does not retry
form-data bodies, so a transient failure must surface as an error the reactor can retry at the step
level, not be silently swallowed mid-stream.

---

## 6. Host work A — AttachmentBridge (`ctx.files` for actions)

Two sub-problems. Doc 06 rates the `files` shim "trivial" (74 pieces, `AttachmentBridge.put()` → a ref)
— that rating covers only the second.

### 6.1 Crossing the fork

`ctx.files.write(buffer)` is called *during* `action.run()`, inside the forked worker, but the protocol
has no worker→host request channel (§2.3). Rather than invert the protocol, we follow the pattern
`storeState` already establishes — push in, return whole — using the fact that a fork shares the
filesystem with its parent:

1. **Worker.** `ctx.files.write({ fileName, data })` writes to `<stagingDir>/<runId>/<uuid>` and returns a
   provisional ref, `apfile://<uuid>`. A size cap (default 25 MB, configurable) is enforced before the
   write.
2. **Protocol.** One new optional field on the existing response: `ResultResponse.files?: StagedFile[]`,
   where `StagedFile` is `{ token, path, fileName, size, contentType }`. No new message type; no change to
   the request direction.
3. **Host.** For each staged file: stream the path into `IAttachmentClient`, receive the real
   `attachment://v1:<sha256>`, then **rewrite the `apfile://` tokens** wherever they appear in the step
   output before it is journalled. Unlink the staging directory in a `finally`, and on worker crash sweep
   it by run id.

Bytes never cross IPC: a 50 MB scan is ~67 MB of JSON string as base64, or a 60-byte path.

The limitation to document: a provisional ref only becomes real *after* the step returns, so a piece that
writes a file and then reads it back by URL within the same run would break. No Paperless action does.
The general fix — a real bidirectional RPC, which would also unblock `ctx.output.update`, `ctx.server`,
`ctx.run.pause` and agent tools — is a protocol inversion with its own deadlock and timeout design, and
belongs in its own spec.

### 6.2 Wiring

`ActionContextOptions` gains `files?: ActionFilesService`, mirroring the `files?: TriggerFilesService`
option triggers already accept, and `context/action.ts:134` uses it in place of `throwingStub("files")`,
keeping `DataUriFilesService` as the fallback when no host service is injected.

The host side needs no upstream change: `processorFactory(module: IProcessorHostModule)` already receives
`module.attachments: IAttachmentClient`. The switchboard processor path captures it and hands it to the
workflow-runtime service, which is in the same process as the worker pool.

---

## 7. Host work B — webhook ingress

### 7.1 The Paperless side

`onEnable` registers this webhook action:

```jsonc
POST /api/workflow_actions/
{
  "type": 4,
  "webhook": {
    "url": "<public switchboard URL>/<workflow-runtime graphql path>",
    "use_params": true,
    "as_json": true,
    "params": {
      "query": "mutation { fireWorkflowWebhook(docId: {{doc_id}}, event: DOCUMENT_ADDED) { accepted } }"
    },
    "headers": { "X-Powerhouse-Webhook-Token": "<opaque 32-byte base64url token>" },
    "include_document": false
  }
}
```

Every element of that is forced by §2.2: `use_params` + `as_json` is the only combination producing a real
JSON object body; the token is a header so it never enters a GraphQL query log; the query is written with
spaces between braces so Jinja never sees `{{` where we did not intend it; and `{{doc_id}}` is the only
interpolation, so no document title can produce invalid JSON.

The URL must fit **256 characters** including the subgraph path, must be final (no redirect), and must
satisfy the deployment's scheme/port/internal-address gates.

### 7.2 The mutation

```graphql
enum PaperlessWebhookEvent { DOCUMENT_ADDED, DOCUMENT_UPDATED }
type FireWebhookResult { accepted: Boolean! }

extend type Mutation {
  fireWorkflowWebhook(docId: Int!, event: PaperlessWebhookEvent!): FireWebhookResult!
}
```

The resolver's entire job is to **acknowledge inside five seconds** (§2.2): read
`X-Powerhouse-Webhook-Token` from `ctx.headers`, look up `sha256(token)` in the endpoint table, compare in
constant time, apply a per-endpoint token bucket, check `trigger_dedup` for `<docId>:<event>`, enqueue the
trigger-hook run, return `{ accepted: true }`. It **never** executes the workflow inline. An unknown or
mismatched token returns a constant-time failure, journals nothing and starts no run.

Retries are expected, not exceptional: a 5xx from switchboard is retried up to three times with backoff,
so the dedupe check is load-bearing rather than defensive. Conversely, because GraphQL answers 200 even
for logical errors, Paperless will never redeliver one — the trigger records those in its own status.

Naming the mutation for Paperless specifically is deliberate for v1: a generic
`fireWorkflowWebhook(token, payload: JSON)` is the eventual shape, but it invites arbitrary payloads
before the dedupe and rate-limit story has been exercised by a real provider. Generalising is a
mechanical follow-up once this one is in production.

### 7.3 Supervisor changes

`ConnectorTriggerDescriptor.strategy` already carries `WEBHOOK | POLLING | APP_WEBHOOK`; the supervisor
simply never reads it (G6). Enabling branches on it:

- **POLLING** — today's path, unchanged.
- **WEBHOOK** — mint a token, persist `{ token_hash, workflow_id, trigger_instance_id, created_at }`,
  call `onEnable` with the real `webhookUrl`, and schedule no polls. Disabling calls `onDisable` and
  deletes the row.

The placeholder `http://localhost:0/v1/webhooks/${binding.workflowId}` (line 222) is replaced by the
configured public URL plus the subgraph path. Note that today's placeholder embeds the **workflow id**,
which is enumerable; the opaque token exists precisely so the URL carries no guessable identifier.

Webhook triggers refuse at enable time when no public URL is configured, with a message the editor can
show — the behaviour doc 08 already prescribes for desktop.

---

## 8. Reactor integration

1. **Catalog (G4).** Merge `@powerhousedao/piece-paperless-ngx` into `piece-catalog.ts`'s
   `FIRST_PARTY_PIECES` alongside the Docling entry: data-URI logo, version, action and trigger counts,
   auth descriptor. After the upstream PR merges, prefer the `@activepieces/` name and drop the
   first-party entry.
2. **`checkConnection`.** No subgraph change; the piece's declaration satisfies the existing worker
   message. The fixture suite gains a `paperless-ngx` case (valid / 401 / 404-wrong-host / unreachable →
   `OK` / `ERROR` / `ERROR` / `ERROR`, with `accountLabel` populated on success).
3. **File hydration (G3, host side).** In the `ActivepiecesBlockExecutor` path, a `FILE`-typed step config
   value that is a data URI or an attachment ref is hydrated to `{ filename, data, extension }` before the
   IPC message; §5.3's normalizer absorbs whatever arrives.
4. **Unchanged:** `fetch.ts`, loader, descriptor, auth shaping, secret store.

---

## 9. Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **P0** Scaffold + connection | package skeleton, `paperlessAuth` (+`validate`, `getConnectionIdentifier`, `checkConnection`), client core, `get_document`, `custom_api_call`, esbuild bundle script, conformance suite | the reactor loads the bundle, `describe` builds the descriptor, `check-connection` returns `{ username }`, the connection editor renders the auth form |
| **P1** Read + search | `search_documents`, `get_task`, all five dynamic dropdowns, mock Paperless server, worker + auth-shaping suites | search runs through the studio and the pickers populate from a live server |
| **P2** Write | `update_document`, `bulk_edit_documents`, `find_or_create_object` | a curation workflow (search → bulk tag) runs end-to-end |
| **P3** Files | AttachmentBridge (§6) — staging, `ResultResponse.files`, host ingest, ref rewrite, `ctx.files` injection — plus `get_document_file` and `upload_document` | a Paperless document flows into the Docling piece and back; a `Property.File` upload is consumed and the document id returned |
| **P4** Triggers | `fireWorkflowWebhook` mutation, endpoint-token store, strategy dispatch (§7.3), both triggers with auto-registration | adding a document in Paperless starts a run within seconds; disabling the trigger removes the Paperless workflow; a bad token 401s without journalling |
| **P5** Publish + catalog | npm publish, first-party catalog merge, i18n, logo, `outputSchema`s | AI `getConnectors` lists Paperless-ngx with correct metadata |
| **P6** Upstream | PR to AP `community/paperless-ngx` | merged ⇒ cloud catalog lists `@activepieces/piece-paperless-ngx`; first-party entry deduped |

P0–P2 need **no host changes at all** and are shippable on their own. P3 and P4 are where the host work
lands, each driven by the piece feature that needs it.

---

## 10. Test plan

Everything offline against a mock Paperless server, except where noted.

1. **Conformance (Tier-1).** The bundle passes `loadPiece`, `describe` produces a descriptor whose
   actions, props, auth and `hasDynamicResolver` flags match expectation, and `metadata()` matches the
   cloud API's detail shape.
2. **Worker execution.** Every action through a real `PieceWorker`: happy paths plus `400`/`422`
   validation, `401` credential, `404` wrong-host, `406` API version, and `5xx` retryable.
3. **Auth shaping.** `shapeAuthValue` for the Paperless connection produces the `ctx.auth` the piece
   expects; mirrors `piece-credentialed.test.ts`.
4. **API version divergence.** A v10 task row through `upload_document` is parsed via
   `related_document_ids`; a v9-shaped row (only `related_document`) arriving despite the pin is detected
   and reported rather than silently yielding no document id; a server too old for version 10 surfaces
   the `406` as "server does not support API version 10", not as a generic failure.
5. **Consumption loop.** Terminal statuses (`success`, `failure`, `revoked` each distinctly), deadline
   expiry returning `pending`, and backoff actually applied.
6. **File normalizer.** All three input shapes from §5.3.
7. **AttachmentBridge.** Staging write → host ingest → `apfile://` rewrite in nested output → staging
   unlinked; the size cap rejects before writing; a worker crash leaves no orphaned staging directory.
8. **Ingress.** Valid token accepted; wrong token 401 in constant time with nothing journalled; replayed
   delivery deduped; the resolver's ACK measured against the 5 s budget; the rate limiter trips.
9. **Trigger lifecycle.** `onEnable` creates trigger + action + workflow and stores their ids;
   `onDisable` deletes all three and tolerates `404`s; `isRepublish` reuses rather than duplicates; a
   `403` preflight produces the manual-setup instructions.
10. **Jinja payload safety.** A document titled `Invoice "Q3"` and one titled `{{ evil }}` both round-trip
    without breaking the payload or executing anything.
11. **Live e2e (manual, not CI).** `docker compose` paperless-ngx + the studio: upload a PDF through a
    workflow, confirm consumption, then add a document by hand in the Paperless UI and watch the webhook
    trigger start a run.

---

## 11. v2 backlog (explicitly not built)

- **Document versions** — `update_version`, `merge_as_versions`, per-version label PATCH/DELETE. New in
  3.x, and the semantics (root metadata shared, content per version) deserve their own props rather than
  being bolted onto `update_document`.
- **Permissions and ownership** — `set_permissions` on documents and objects, `?full_perms=true`. Needs a
  user/group picker, which means two more dropdown resolvers.
- **`include_document: true` webhooks** — Paperless can POST the file with the trigger, skipping a
  download round-trip. Incompatible with the JSON-body ingress (§2.2) and puts bytes in the trigger
  payload; revisit when the ingress can accept multipart.
- **A generic ingress mutation** — `fireWorkflowWebhook(token, payload: JSON)` for any provider, once
  dedupe and rate limiting have been proven by this one (§7.2).
- **Polling trigger** — a fallback for deployments that cannot reach the reactor. Cheap to add
  (`?added__gt=<cursor>&ordering=added` with dedupe by id) and worth having once someone needs it.
- **Saved views, mail accounts and rules, users and groups, app config, trash operations** — reachable
  today via `custom_api_call`; promote individually if usage justifies it.
- **The 3.x AI surface** — vector store, tool calling, `apply_ai_suggestions`, remote OCR. Moving fast
  upstream; not a stable contract to model yet.
- **Bidirectional worker RPC** — the general answer to §6.1's limitation, and the unlock for
  `ctx.output`, `ctx.server`, `ctx.run.pause` and agent tools.

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | The 5 s webhook timeout turns any slow resolver into a lost trigger | The resolver only verifies, dedupes and enqueues (§7.2); the ACK budget is a test (§10.8), not a hope |
| R2 | Auth enforcement on the switchboard GraphQL endpoint may require Paperless to also carry a reactor bearer token | Resolver accepts either the webhook token alone or a bearer token plus the webhook token; settled by a P4 spike against a live switchboard (§13 Q2) |
| R3 | paperless-ngx 3.x moves quickly | `Accept: version=10` pinned (D3); the mock server pins the contract; API version divergence is a test (§10.4); the piece description states the supported range |
| R4 | Auto-registration needs the "edit workflows" permission, which a scoped token may lack | Preflight with an actionable failure carrying the exact manual-setup JSON (§4.3) |
| R5 | Provisional `apfile://` refs are only real after the step returns | Documented; no v1 action reads back a file it wrote; the general fix is scoped out (§6.1) |
| R6 | A hardened Paperless silently refuses to POST to the reactor | `onEnable` preflights scheme, port and internal-address reachability; the failure names the setting to change (§2.2) |
| R7 | Journal bloat from OCR text | `include_content` defaults false (D11) |
| R8 | The upstream AP PR may be rejected or sit in review | The piece works identically under our own scope; upstream is an enhancement, not a dependency |
| R9 | The AP bundle format is a private contract | Our own esbuild config, under our control; Tier-1 conformance is the acceptance gate (Docling R2) |

---

## 13. Open questions

1. **npm scope** — `@powerhousedao/piece-paperless-ngx`, matching Docling?
2. **GraphQL auth enforcement** — does a switchboard deployment with auth enabled admit a mutation whose
   only credential is our webhook token, or must Paperless also hold a reactor bearer token? This is the
   one fact in §7 not verifiable from source alone; it needs a live switchboard and it gates P4's shape,
   not its feasibility.
3. **Ingress generality** — ship the Paperless-specific mutation (§7.2) and generalise later, or design
   the generic `payload: JSON` form now and accept the wider input surface immediately?
4. **Paperless AI features** — the 3.x vector store and tool-calling endpoints are in scope for a later
   phase, or deliberately out of scope for this connector?

---

## 14. Sources

- **paperless-ngx** (`paperless-ngx/paperless-ngx` @ `main`, v3.1.3 released 2026-09-04):
  `docs/api.md` (auth, versioning + changelog, upload, versions, permissions, bulk edit),
  `docs/usage.md` (workflow triggers, action types, placeholders, permissions),
  `docs/configuration.md` (§"Workflow webhooks"),
  `src/paperless/urls.py` (router registrations and non-router routes),
  `src/documents/models.py` (`PaperlessTask`, `WorkflowTrigger`, `WorkflowAction`,
  `WorkflowActionWebhook`),
  `src/documents/serialisers.py` (`TaskSerializerV9`/`V10` divergence),
  `src/documents/workflows/actions.py` (`execute_webhook_action`),
  `src/documents/workflows/webhooks.py` (`send_webhook`: httpx call shape, timeout, retries),
  `src/documents/templating/workflows.py` (Jinja sandbox, `StrictUndefined`, placeholder set)
- **Activepieces** cloud catalog `https://cloud.activepieces.com/api/v1/pieces` (764 pieces, no paperless
  — checked 2026-09-08); piece framework and distribution paths as recorded in the Docling plan
- **This repo** @ `origin/main` `5c0b72d`: `src/activepieces/worker/protocol.ts`,
  `src/activepieces/context/{action,trigger,files,props}.ts`, `src/activepieces/descriptor.ts`,
  `subgraphs/workflow-runtime/{trigger-supervisor,piece-catalog,service,schema}.ts`, plan docs 06/08/09,
  `plan/20260908-docling-piece-plan.md`
- **`@powerhousedao/reactor-api@6.2.2-dev.77`** type surface: `IHttpAdapter.mountNodeRoute`,
  `SubgraphArgs`, `Context`, `IProcessorHostModule`, `API`
