# Demo: paperless-ngx → docling on the reactor

A self-hosted **paperless-ngx** document archive and a self-hosted
**docling-serve** conversion server, both wired into the reactor through
this repo's first-party pieces. Upload a document to paperless; a workflow
picks it up, fetches the file, and converts it to Markdown with docling —
and you watch the run in the reactor's journal.

| Service | URL | Piece |
| --- | --- | --- |
| docling-serve v1.32.0 | http://localhost:5001 | `@powerhousedao/piece-docling` |
| paperless-ngx 2.18.4 | http://localhost:18000 (login `admin` / `paperless-demo`) | `@powerhousedao/piece-paperless-ngx` |

Both run from [`docker-compose.yml`](docker-compose.yml); the pieces talk
to them over plain HTTP on loopback. Paperless runs in the host network
namespace so its webhook can post back to the switchboard (see step 3).

## 1. Start the service stack

```sh
docker compose -f demo/docker-compose.yml up -d
```

First start pulls the images (a few GB). The stack needs a minute or two
for paperless to migrate and start its web process; docling serves within
seconds, but its first *conversion* loads the layout model (a minute or
two on CPU) — the seed step below does not trigger a conversion.

## 2. Mint the credentials

```sh
node demo/seed.mjs
```

Waits until both services answer, mints a paperless API token (stored in
`demo/.paperless-token`, mode 600), and prints the exact values the
connections need. Re-running it reuses the stored token and revalidates
it. It defaults to the compose credentials (`admin` /
`paperless-demo`); if you changed them in the compose file, pass
`PAPERLESS_USER` and `PAPERLESS_PASSWORD`.

## 3. Start the reactor

From the repo root:

```sh
PUBLIC_URL=http://localhost:4001 pnpm dev
```

`pnpm dev` builds `reactor-connectors` and starts Vetra (Connect on
:3000, switchboard on :4001 — see the root README). The
`PUBLIC_URL` flag is **required for this demo**: the paperless
piece's webhook trigger registers a delivery endpoint with paperless
when you enable it, and that endpoint is the switchboard's GraphQL URL
on the reactor's public origin. The trigger refuses to enable while the
origin is unset, so it cannot silently register an address nothing can
reach. For the local demo, `http://localhost:4001` is right, because
paperless shares the host network namespace and the switchboard is
reached on loopback.

## 4. Create the two connections

In Connect: **Settings → Connections → New**.

1. **Paperless-ngx** — `base_url` `http://localhost:18000`, `token` from
   the seed output.
2. **Docling Serve** — `base_url` `http://localhost:5001`, `api_key`
   left empty (the demo server runs unauthenticated).

Saving each runs its connection check: the docling check probes a
key-gated `/v1/` route (v1 only gates those — `/health` stays open), the
paperless check hits the user endpoint. Both should report healthy.

## 5. Build the workflow

In the workflow builder, three blocks:

1. **Trigger: Paperless-ngx → New document.** This is a *webhook*
   trigger: enabling it registers a webhook with paperless (named
   `Powerhouse: new document …` in paperless's Webhooks list).
2. **Paperless-ngx → Get document file.**
   - `document id`: `{{blocks.<trigger>.output.id}}`
   - `variant`: **Archive (OCR'd PDF)** — the text-layer PDF paperless
     produced; it is what docling converts best.
   - The output is an attachment reference (`ref`), not raw bytes: the
     bytes live in the attachment store, and only the reference enters
     the run journal.
3. **Docling → Convert file.**
   - `file`: `{{blocks.<get file>.output.ref}}`
   - everything else at its default: markdown format, OCR on.

Then **enable** the workflow. (Enabling is where the webhook gets
registered — if it refuses, `PUBLIC_URL` is not set; stop Vetra and
redo step 3.)

## 6. Upload a document

Open <http://localhost:18000>, sign in as `admin` / `paperless-demo`,
and drop `demo/sample-invoice.pdf` onto the Documents page (or any PDF
you like — a scanned one exercises the OCR path the stock docling image
handles out of the box). Paperless de-duplicates by content hash:
uploading the same file again is a no-op (the run still fires from the
existing document's webhook, if any).

## 7. Watch the run

Within a few seconds the workflow appears in the run list (Connect, or
directly):

```sh
curl -s http://localhost:4001/graphql/workflow-runtime \
  -H 'content-type: application/json' \
  -d '{"query":"{ workflowRuntime { runs(limit: 1) { workflowName status steps { key blockType status } } } }"}'
```

All three steps should report `success`, and the docling step's output
carries the invoice as Markdown — open the run in Connect to read the
`md_content` field.

## Troubleshooting

- **Webhook trigger refuses to enable** — `PUBLIC_URL` was not set
  when Vetra started (step 3). It must be the origin the switchboard
  actually serves on and that paperless can reach: `http://localhost:4001`
  for this layout.
- **Deliveries never arrive** — paperless can only reach the switchboard
  on loopback because it runs in the host netns (compose file). If you
  change that, point `PUBLIC_URL` at an address paperless can reach
  and allow the webhook through whatever firewall sits in between.
- **First docling conversion is slow** — the stock CPU image loads the
  layout model lazily on first use; later conversions are fast.
- **Paperless port already in use** — change `PAPERLESS_PORT` and
  `PAPERLESS_URL` in the compose file to the same new value (and the
  connection's `base_url`).
- **Reset everything** — `docker compose -f demo/docker-compose.yml
  down -v` deletes the archive and its volumes; re-run `node demo/seed.mjs`
  to mint a fresh token for the new instance.

## Version notes

- **docling-serve v1.32.0** is the release the docling piece targets.
  Two of its behaviors matter for connections: only the `/v1/*` routes
  are key-gated (`/health` and `/version` stay open even with a bad key,
  which is why the connection check probes a `/v1/` route), and URL
  sources pass an SSRF gate that accepts only globally routable hosts.
- **paperless-ngx 2.18.4** is the API line the paperless piece was built
  and verified against. The 2.18 line split the documents API:
  `/api/documents/` is a read-only search route (a `POST` there answers
  405) and uploads go to `POST /api/documents/post_document/`, which
  returns `{"success": true}` and consumes asynchronously. The piece's
  `upload_document` targets that route. The 3.0 line rewrites the API
  again — keep the pin until the piece supports it (see also
  `packages/piece-paperless-ngx/README.md`).
