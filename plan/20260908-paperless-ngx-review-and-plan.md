# Paperless-ngx Piece — Review Findings and Implementation Plan

**Date:** 2026-09-08 · **Status:** implemented (P0–P5 in code; publish, upstream PR and live e2e outstanding)
**Amends:** [`20260908-paperless-ngx-piece-design.md`](./20260908-paperless-ngx-piece-design.md) — read that
for the design; this document records where verification changed it, and the task order that follows.

Every claim below was checked against source on 2026-09-08: paperless-ngx `main` (= v3.1.3, confirmed
via `src/paperless/version.py`), the published `@activepieces/pieces-framework@0.32.0` npm tarball, and
this repo at `feat/paperless-ngx-piece`. File:line references are to those trees.

---

## 1. Verified corrections to the design

### C1 — Webhook delivery is lossy, and no preflight can detect it

`src/documents/workflows/webhooks.py`:

```python
@shared_task(retry_backoff=True, autoretry_for=(httpx.HTTPStatusError,),
             max_retries=3, throws=(httpx.HTTPError,))
```

Only `HTTPStatusError` is retried. A connection refusal or a response slower than `timeout=5.0` raises
`ConnectError`/`ReadTimeout` — subclasses of `httpx.HTTPError`, which is in `throws`, i.e. Celery treats
it as expected and does **not** retry. Every reactor restart, deploy or long GC drops those events
permanently.

Worse for §4.3's preflight: `validate_outbound_http_url` (scheme / port / internal-address gates) runs
inside the Celery task at **send** time, not at registration. `WorkflowActionWebhookSerializer.validate_url`
is only Django's `URLValidator` — a syntax check. So a hardened deployment accepts our registration and
then silently discards every delivery, and there is no request we can make at enable time that proves
otherwise.

**Change:** the webhook stops being the delivery mechanism and becomes a latency optimisation on top of a
cursor sweep. `?added__gt=<iso>&ordering=added` is available (`DocumentFilterSet` maps `added` to
`DATETIME_KWARGS`, which includes `gt`/`gte` — `src/documents/filters.py:868`), and `modified` likewise for
the updated trigger. Webhook triggers therefore keep a slow reconciliation poll instead of no poll at all
(D7 amended, R6 mitigated properly, the v2-backlog polling trigger promoted into v1 as one branch of the
same `run` hook).

### C2 — Dedupe must happen after hydration, and then it is free

The Jinja placeholder set is exactly 24 names (`src/documents/templating/workflows.py`,
`_known_placeholder_names`) and contains no `modified` and no delivery nonce; `doc_id` is rendered via
`str(doc_id)`. So a resolver that only receives `doc_id` **cannot** distinguish Paperless's three retries
from a document genuinely edited twice — §7.2's `<docId>:<event>` dedupe would swallow real updates.

It is also unnecessary. `trigger-supervisor.ts:493` `fireItem` already claims `_dedupe_key` with a 30 s TTL
(`DEDUPE_TTL_MS`), which comfortably covers Celery's `retry_backoff` window. Routing the delivery through
the trigger's `run` hook — which hydrates the document and therefore knows `modified` — makes the existing
machinery do the work.

**Change:** the resolver verifies, rate-limits and enqueues. No dedupe there. The trigger emits
`_dedupe_key = <doc_id>:<event>:<modified>` and the supervisor collapses duplicates.

### C3 — Pin by negotiation, not by constant

`ALLOWED_VERSIONS` by release: **v2.14.7** `["1".."7"]`; **v2.18.4** `["1".."9"]`; **v3.0.0** and
**main/3.1.3** `["9","10"]`, `DEFAULT_VERSION = "10"`. A hard `version=10` therefore `406`s every
paperless before 3.0 — an undeclared compatibility floor, not the robustness measure R3 describes.

A second divergence turned up beyond §2.1's two field names: `TasksViewSet.paginate_queryset` returns
`None` for version < 10, so **v9 `/api/tasks/` is an unpaginated plain list** while v10 returns
`{count, results}` (`src/documents/views.py:4360`).

**Change (D3 amended):** probe `ui_settings` with no version header, read `X-Api-Version` (the server's
default = its maximum), pin `min(10, that)` for the connection's lifetime, and branch three things:
`related_document_ids` (v10) vs `related_document` (v9), `task_file_name` (v9 only), and the tasks-list
envelope. §10.4's tests already require the v9 shape, so the branch costs almost nothing and buys every
2.18.x install.

### C4 — Reconcile the action timeout with the worker timeout

`engine/blocks.ts:194` uses `execution.step.timeoutSeconds`, else `defaultTimeoutMs`, which
`worker/host.ts:98` defaults to **30 s** — and expiry *replaces the worker*
(`PieceWorkerTimeoutError`, `host.ts:44`). D6's 300 s consumption loop exceeds that by 10×.

`PostDocumentView.post` ends `return Response(async_task.id)` (`src/documents/views.py:3390`) — the task,
and possibly the document, exist before the poll starts. A worker kill plus a step retry uploads twice,
and Paperless has no idempotency key.

**Change:** `upload_document` caps `timeout_seconds` at the step budget and, before POSTing, checks
`ctx.store` for a task id from a previous attempt of the same step, resuming the poll instead of
re-uploading. The action's description states that a wait beyond the default requires the step's own
`timeoutSeconds`.

### C5 — Registration is one atomic POST, not three

`WorkflowSerializer` (`src/documents/serialisers.py:3321`) declares nested
`WorkflowTriggerSerializer(many=True)` and `WorkflowActionSerializer(many=True)`, and
`update_triggers_and_actions` creates each nested trigger/action — and the webhook nested inside the action
— with `update_or_create(id=...)`.

So §4.3's three POSTs become **one** `POST /api/workflows/` carrying the trigger and the webhook action
inline. Partial-failure orphans become impossible, and `isRepublish` (and token rotation) is a `PATCH` with
the stored ids. Note `action["order"]` is assigned by the serializer, and `Workflow.order` is optional.

Deletion still needs all three: `triggers`/`actions` are M2M, so deleting the workflow does not cascade.

### C6 — The preflight has a correct, cheap form

`UiSettingsView.get` (`src/documents/views.py:4082`) returns `{user: {id, username, is_staff,
is_superuser, groups}, settings: {..., version}, permissions: [...]}`, where `permissions` is
`user.get_all_permissions()` with the `<app_label>.` prefix stripped.

So the one call D2 already makes yields identity, server version **and** the permission list. The
preflight checks for `add_workflow` / `change_workflow` instead of inferring from `GET /api/workflows/`,
which only proves `view_workflow`. It also removes the need for the `X-Version` header in the label.

### C7 — File-variant names are inverted

`download` and `preview` both call `serve_file(use_archive=not original_requested(request) and
file_doc.has_archive_version)` (`src/documents/views.py:1364`, `:1709`); `?original=true` forces the
original; `thumb` returns the webp thumbnail.

So `/download/` yields the **archive** (the OCR'd PDF with a text layer), and `preview` differs from
`download` only in Content-Disposition.

**Change:** variants become `archive` (default), `original`, `thumbnail`; `preview` is dropped. The output
reports which was served, using the document's `has_archive_version`. This is also the variant that
matters downstream: the archive already has a text layer.

### C8 — `name__iexact` exists on all five object types

`CHAR_KWARGS = ["istartswith", "iendswith", "icontains", "iexact"]` is applied to `name` on
Correspondent (`:95`), Tag (`:104`), DocumentType (`:119`), StoragePath (`:128`) and CustomField (`:252`).
§4.2's "unconfirmed for storage paths and custom fields" is settled and the paged-scan fallback is
deleted before it is written.

### C9 — One file cap, not two numbers

There are already two 8 MiB caps: `context/normalize.ts:25` `MAX_FILE_BYTES` (inbound hydration) and
`context/files.ts` `MAX_INLINE_FILE_BYTES` (the data-URI trigger service). §6.1's proposed 25 MB write cap
would let the piece emit an attachment that the inbound path then refuses — breaking the Docling round
trip for any scan over 8 MiB.

**Change:** one exported, configurable constant shared by both directions. Raising it is a deliberate
one-line change, not a per-call-site accident. `normalize.ts` currently enforces the cap only on the URL
fetch branch; the data-URI and file-shaped branches get it too.

### C10 — `include_document: true` would drop the body entirely

`execute_webhook_action` passes `files` to `send_webhook`, which sets `post_args["files"] = files or None`
alongside `json`. httpx's `encode_request` prefers `files` over `json`, so the payload would not merely
conflict — the GraphQL query would vanish and Paperless would POST a bare multipart file. Stays `false`;
the reason is recorded.

Related: `execute_webhook_action` catches template errors and logs them, leaving `data` partially built. A
delivery can therefore arrive with an empty or truncated body, which the resolver must reject as a bad
delivery rather than fault on.

### C11 — Auth: the token is the only credential, and there is a house pattern for that

`AuthorizationPolicy` is `OPEN | ADMIN_ONLY | DOCUMENT_PERMISSIONS`, and the authorization service is
consulted at document call sites (`canRead`/`canMutate`/`canManage`/`isSupremeAdmin`), not as request
middleware; no resolver in `subgraphs/workflow-runtime/` reads `ctx.user`. Open question Q2 is answered:
**no reactor bearer token is required**, and R2 dissolves.

The corollary is that `fire(workflowId, payload)` — "runs it to completion" — and the three secret
mutations sit on the same unauthenticated surface. `resolvers.ts:24` already carries the house response:
`assertSecretWritesAllowed()`, "prod gate until runtime auth lands". The ingress mutation follows it.

### C12 — Schema shape and naming

Everything lives under `Mutation.workflowRuntime.*` (`schema.ts:213`), so §7.2's top-level
`extend type Mutation` is wrong. And since the token resolves the trigger instance, which knows its own
event type, `docId`/`event` arguments buy nothing.

**Change (Q3 answered):** `Mutation.workflowRuntime.fireWebhook(token: String!, payload: Unknown)`,
generic from the start. Paperless sends `params: { query: "mutation { workflowRuntime { fireWebhook(token:
\"…\", payload: {docId: {{doc_id}}}) { accepted } } }" }`. Note `params` values each render to a *string*,
so `{"query": "…"}` is exactly the GraphQL-over-HTTP body shape and `variables` cannot be an object —
inlining `{{doc_id}}` in the query text is forced, and safe, because it renders as an integer.

The token still travels in the `X-Powerhouse-Webhook-Token` header (D8) so it stays out of query logs;
the `token` argument exists for providers that cannot set headers, and the resolver prefers the header.

---

## 2. What this changes in the phase table

P0–P2 are unaffected in shape. P3 gains the inbound half of the file path. P4 becomes "ingress +
reconciliation" rather than "ingress". The Docling dependency is made explicit: nothing here needs the
Docling piece except the P3 round-trip demo, so the shared bundle script and file normalizer are extracted
into this package and re-used by Docling later, not the other way round.

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **P0** | package scaffold, client core, version negotiation, auth + `checkConnection`, `get_document`, `custom_api_call`, esbuild bundle | reactor loads the bundle; `describe` builds the descriptor; `check-connection` returns username + label; negotiation picks 10 / 9 / fails with an actionable 406 message |
| **P1** | `search_documents`, `get_task`, `get_document_file`, five dropdowns, mock server | search and pickers work against the mock and a live 3.1.3; v9 and v10 task shapes both parse |
| **P2** | `upload_document` (resume guard), `update_document`, `bulk_edit_documents`, `find_or_create_object` | upload → consumption → document id, and a re-run of a timed-out step resumes rather than re-uploads |
| **P3** | AttachmentBridge: staging service, `ResultResponse.files`, host ingest, ref rewrite, `ctx.files` injection, shared cap, attachment-ref hydration inbound | a document flows out as an attachment ref and back into a `Property.File` input; the cap is one constant |
| **P4** | `fireWebhook` mutation + endpoint-token store + env gate, supervisor `strategy` dispatch, both triggers with one-POST registration, cursor sweep | adding a document fires a run within seconds; killing the reactor for a minute loses nothing (the sweep recovers it); a bad token is rejected without journalling |
| **P5** | catalog merge, i18n, logo, `outputSchema`s | `getConnectors` lists Paperless-ngx with correct metadata |

---

## 3. Task order

Each task is one commit, tests first where there is behaviour to pin.

**T1** `packages/piece-paperless-ngx` scaffold: `package.json` (framework `0.32.0`, common `0.12.5`),
tsconfig, vitest config, esbuild `scripts/bundle.mjs` (CJS, `keepNames`, node20, no externals), workspace
entry. No `getConnectionIdentifier`, no `classification` — neither exists in 0.32.0 (verified against the
published tarball); the connection label comes from `checkConnection`.

**T2** `src/lib/common/version.ts` + tests: negotiate and pin, `406` → "server too old for API version 9"
with the observed ceiling in the message.

**T3** `src/lib/common/client.ts` + tests: base-URL normalisation, `Authorization: Token`, negotiated
`Accept`, status→error mapping (`400/422` DRF detail, `401/403`, `404`, `406`, `5xx` retryable),
pagination over both envelopes.

**T4** `src/lib/auth.ts` + `src/index.ts`: `CustomAuth`, `validate` → `ui_settings`, `checkConnection` →
`{ username }` plus label, permission list captured for the trigger preflight.

**T5** `get_document`, `custom_api_call` + worker-level tests. **Bundle conformance test** (load →
describe → run) is the acceptance gate.

**T6** mock paperless server (`node:http`): documents, tasks (both envelopes), objects, workflows,
`ui_settings` with a configurable permission list and version ceiling.

**T7** `get_document_file` with the three corrected variants; `search_documents`; `get_task`.

**T8** the five dynamic dropdowns (`refreshers: ['auth']`).

**T9** `upload_document`: multipart assembly, consumption poll, resume guard, deadline → `pending`.

**T10** `update_document` (`tag_mode`), `bulk_edit_documents` (`DynamicProperties` per method),
`find_or_create_object` (`name__iexact` only).

**T11** host: shared file cap constant; `normalize.ts` enforces it on every branch.

**T12** host: `ActionContextOptions.files`, `StagedFilesService` in the worker, `ResultResponse.files`,
host ingest + `apfile://` rewrite + staging cleanup, `attachment://` hydration inbound via a staging path
rather than base64 through IPC.

**T13** host: `fireWebhook` resolver, `webhook_endpoint` table (token hash, workflow id, trigger instance),
env gate mirroring `assertSecretWritesAllowed`, rate limit, 5 s ACK budget test.

**T14** host: supervisor `strategy` dispatch — `WEBHOOK` mints the token, passes a real `webhookUrl`, and
schedules the reconciliation interval instead of the poll interval.

**T15** piece: both triggers — one-POST nested registration, `PATCH` on republish, delete-all-three on
disable, `ui_settings.permissions` preflight, and a `run` hook with two branches (webhook payload → hydrate
one document; no payload → cursor sweep).

**T16** catalog merge (`FIRST_PARTY_PIECES`), i18n, logo, `outputSchema` field lists.

---

## 4. What was built, and where it deviated

All sixteen tasks landed except the ones that need something outside the repo
(npm publish, the upstream PR, the manual live e2e). 514 tests pass across the
three packages; `pnpm -r tsc` and `pnpm -r lint` are clean.

| Deviation | Why |
|---|---|
| No `@activepieces/pieces-common`; the client is native `fetch`, and `@activepieces/shared` is a direct dependency for `PieceCategory` | One error path instead of two, deterministic response-header reads for the version negotiation, and no axios FormData behaviour to work around on the multipart upload. Invisible to the host, which loads a bundle either way |
| `upload_document` adopts a recent consumption task rather than remembering its own | The piece store lives in the worker process and a step timeout *replaces* that worker, so a store-based guard cannot survive the case it exists for. Confirmed necessary: `pre_check_duplicate` only rejects a duplicate when `PAPERLESS_CONSUMER_DELETE_DUPLICATES` is set, and it is not by default — paperless consumes the second copy |
| Trigger sources are `sources`, not `filter_source` | `WorkflowTriggerSerializer` exposes `sources` as a `MultipleChoiceField`; the design doc had the wrong field name |
| A webhook trigger keeps a slow poll (15 min) instead of none | That poll *is* C1's reconciliation sweep. Same `run` hook, no payload |
| The delivery token rides in the `webhookUrl` fragment | Keeps AP's "the webhook URL is the credential" convention while getting the token into a header on the wire; a fragment is never sent |
| Attachment reads are authorized against the workflow document, carried on an `AsyncLocalStorage` run scope | `IAttachmentClient.download` needs a document id, and the block executor is shared across concurrent runs, so the scope cannot live on the executor |
| One file cap (`PH_PIECE_MAX_FILE_BYTES`, 8 MiB) on every `toApFile` branch | C9. The 25 MB write cap in the design would have let a piece emit a file the inbound path refuses |

Not built, and deliberately: `outputSchema` field lists, the npm publish, the
upstream `community/paperless-ngx` PR, and the docker-compose live e2e. The
piece's `i18n/translation.json` exists for the upstream path — 0.32.0 has no
`i18n` parameter on `createAction`.

## 5. Still open

- **Reconciliation interval** for webhook triggers: 15 min is the proposed default. Cheap, and it bounds
  worst-case loss; a user who trusts their network can raise it.
- **Live e2e** stays manual (docker compose paperless-ngx + studio), as §10.11 has it.
