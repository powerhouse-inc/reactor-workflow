# @powerhousedao/piece-paperless-ngx

A first-party workflow piece for a self-hosted **paperless-ngx** document
archive: upload, search, read, tag, and react to new documents. Built on
the Activepieces piece contract and run by the reactor's workflow runtime
(see the root README).

| | |
| --- | --- |
| Auth | API token (paperless: *Settings → User API token*; or `POST /api/token/` with the admin credentials) |
| Connection check | `checkConnection` probes the user endpoint with the token and reports the server version as the connection label |
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

Registering the endpoint requires the reactor to have a public origin
the paperless instance can reach: start Vetra with `PH_PUBLIC_URL` set to
that origin (for the local demo, `http://localhost:4001` — paperless runs
in the host network namespace and the switchboard is on loopback; the
demo compose also sets
`PAPERLESS_WEBHOOKS_ALLOW_INTERNAL_REQUESTS=true` so paperless accepts
the loopback address). The trigger **refuses to enable** while the origin
is unset, so a webhook can never be registered at an address nothing can
reach.

## Tests

- `pnpm test` — unit/conformance suites against the in-process
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
