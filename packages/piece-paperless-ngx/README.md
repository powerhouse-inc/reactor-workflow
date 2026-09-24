# @powerhousedao/piece-paperless-ngx

A first-party workflow piece for a self-hosted **paperless-ngx** document
archive: upload, search, read, tag, and react to new documents. Written
against `@powerhousedao/pieces-framework` and run by the workflow runtime
in `@powerhousedao/reactor-workflow` (see the root README).

| | |
| --- | --- |
| Auth | API token (paperless: *Settings → User API token*; or `POST /api/token/` with the admin credentials) |
| Connection check | `auth.validate` probes the user endpoint with the token; `auth.getConnectionIdentifier` labels the connection with the user, host, server and API version |
| Verified against | **paperless-ngx 2.18.4** (the 2.18 API line) |

## The 2.18 API line

This piece was built and verified against the **2.18.x** API and pins it.
The 2.18 line split the documents API, which differs from the older 2.x
API and from the 3.0 rewrite:

- `GET /api/documents/` is a **read-only search route** — a `POST` there
  answers `405 Method Not Allowed` (the writable `DocumentViewSet` is
  gone from that path).
- Uploads go to **`POST /api/documents/post_document/`** (multipart
  field `document`). It answers `200` with a task identifier and
  consumes the file **asynchronously**; the new document appears in the
  list once consumption finishes. Consumption is de-duplicated by
  content hash, so uploading the same file twice yields one document.
- There is **no `status` field** on document objects in 2.18 (that is a
  3.0+ addition). A consumed document is recognizable by its archive:
  `archived_file_name` set and `page_count` present.
- File download: **`GET /api/documents/<id>/download/`** serves the
  **archive** (OCR'd PDF) by default; add **`?original=true`** for the
  original upload.
- Task states use Celery's uppercase states (`PENDING`, `SUCCESS`, …)
  and the task's document link is the string `related_document` field —
  the `get_task` action normalizes both.
- **Workflow triggers filter on one correspondent and one document
  type.** `OPTIONS /api/workflows/` on 2.18.4 lists
  `filter_has_correspondent` and `filter_has_document_type` (single
  ids, compared with `!=` in `matching.py`); the multi-valued
  `filter_has_any_*` / `filter_has_not_*` names and the storage-path
  filter are 3.0 additions. DRF **drops an unknown field without
  complaining**, so sending the 3.x names here registers a trigger with
  no filter at all — one that fires on every document, silently. The
  triggers send the names the negotiated API version understands, and
  refuse a filter that line cannot express rather than dropping it.
  `filter_has_tags` means "any of" on both lines and needs no
  translation.

Paperless **3.0** rewrites the API again (a different router and request
shapes), so the pin stays at 2.18.x until the piece is ported. The
client negotiates the API version per host: it starts at the highest
version it supports and steps down on `406`, caching the negotiated
value — the "legacy" e2e half below exercises exactly that path against
2.18.4, whose API tops out at version 9.

## Actions

| Action | What it does |
| --- | --- |
| **Upload document** | `POST /api/documents/post_document/` with an attachment or a URL source; returns the created task |
| **Get document** | One document by id (metadata + OCR text) |
| **Get document file** | A document's file as an attachment — variant **Archive (OCR'd PDF)** (default, the best input for downstream conversion) or **Original** (`?original=true`) |
| **Search documents** | The four search shapes `/api/documents/` accepts in 2.18: text query, filter, sort, and pagination |
| **Update document** | Title, correspondent, document type, tags, storage path, notes |
| **Bulk edit documents** | The same fields across many document ids |
| **Find or create object** | Correspondent / document type / tag / storage path by name (idempotent), for wiring updates without hard-coded ids |
| **Get task** | Poll a consumption/processing task; normalizes 2.18's task shape to a stable output |
| **Custom API call** | Any paperless API route with the connection's auth (escape hatch) |

## Triggers

Both triggers are **webhook** triggers: enabling one registers a delivery
endpoint with paperless (paperless *Documents → Webhooks*), and paperless
posts there on the event.

| Trigger | Fires on |
| --- | --- |
| **New document** | A document enters the archive (uploaded, mailed, or watched-folder) |
| **Document updated** | A document's metadata changes |

The filter props are registered with paperless, so deliveries arrive
already narrowed. They are also applied to the **reconciliation sweep** —
the poll that catches deliveries paperless dropped — as query params on
`/api/documents/`, because a filter registered on a workflow says nothing
about a list request. The filename glob has no equivalent lookup there
(`CHAR_KWARGS` is `istartswith`/`iendswith`/`icontains`/`iexact`), so the
sweep applies that one itself, matching paperless's own fnmatch.

Registering the endpoint requires the reactor to have a public origin
the paperless instance can reach: start Vetra with `PUBLIC_URL` set to
that origin (for the local demo, `http://localhost:4001` — paperless runs
in the host network namespace and the switchboard is on loopback; the
demo compose also sets
`PAPERLESS_WEBHOOKS_ALLOW_INTERNAL_REQUESTS=true` so paperless accepts
the loopback address). The trigger **refuses to enable** while the origin
is unset, so a webhook can never be registered at an address nothing can
reach.

## Build

`pnpm build` emits the piece at
`dist/node/pieces/paperless-ngx/index.mjs` with the framework inlined,
and copies `powerhouse.manifest.json` into `dist/`. That module is what
`pieces/index.ts` declares and what a reactor loads.

## Tests

- `pnpm test` — builds, then runs the unit/conformance suites against the in-process
  `mock-paperless` (API v9 pin, status codes, version negotiation,
  webhook registration, output schemas).
- Live e2e (needs Docker):

  ```sh
  docker compose -f test/e2e-compose.yml up -d
  PAPERLESS_E2E_URL=http://localhost:18000 \
    pnpm vitest run test/e2e.test.ts
  docker compose -f test/e2e-compose.yml down -v
  ```

  The stack pins `ghcr.io/paperless-ngx/paperless-ngx:2.18.4` with its
  bundled SQLite (no Postgres) and a sidecar Redis, on the host network
  namespace so the webhook can post back to the test process
  (credentials live in `test/paperless-e2e.env`, mounted as the s6
  service environments).

  ```sh
  docker compose -f test/e2e-legacy-compose.yml up -d
  PAPERLESS_LEGACY_E2E_URL=http://localhost:18001 \
    pnpm vitest run test/e2e-legacy.test.ts
  docker compose -f test/e2e-legacy-compose.yml down -v
  ```

  The "legacy" half runs the same 2.18.4 image through the pre-3.0
  client version (API v9): a client that pinned API v10 would 406 on
  every request against this image, which is exactly what the suite
  guards.

- `pnpm tsc` / `pnpm lint` — type check and lint.
