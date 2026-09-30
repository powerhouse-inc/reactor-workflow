# @powerhousedao/piece-docling

A first-party workflow piece for document conversion: convert documents
(PDF, DOCX, PPTX, images, HTML, …) to Markdown, docling-document JSON,
HTML, DocTags, or plain text, chunk them for retrieval, and transcribe
audio and video. It speaks the **docling-serve v1 REST API**, and that
one API reaches both servers Powerhouse runs:

| Server | What it is | Point the connection at |
| --- | --- | --- |
| **Document Conversion add-on** | `@powerhousedao/docling-service`, a wrapper over `docling.rs`, enabled per environment in Vetra. No ingress, no credentials — reachable only from inside the environment. | `CONVERT_SERVICE_URL` (`http://<env>-docling…:5011`) |
| **docling-serve** | The stock Python server, self-hosted (the demo compose runs the CPU image) or Docling for IBM watsonx. | Its own URL, port 5001 by default |

Everything works against both. The add-on additionally measures things
docling-serve's response shape has no field for — how much of the
document's own text survived, which rung of the OCR ladder read it,
whether OCR is worth offering — and returns them under `powerhouse`,
which is simply absent from a stock docling-serve. Read it with `?.`
and a workflow runs unchanged against either.

> Using the add-on also needs the **Workflows** add-on to allow the
> private address it lives on — see `PH_WORKFLOWS_EGRESS_ALLOW_ADDRESSES`.

| | |
| --- | --- |
| Auth | Optional API key (the add-on takes none; the demo server runs unauthenticated — leave it empty) |
| Connection check | `checkConnection` probes a key-gated `/v1/` route with the configured key and reports the server version as the connection label |
| Verified against | **docling-serve v1.32.0**, **docling-service 0.4.1** |

## The v1 API surface this piece uses

docling-serve v1 gates only the `/v1/*` routes on the API key —
`/health` and `/version` answer `200` even with a bad key — which is why
the connection check deliberately probes a `/v1/` route instead of
`/health` (a `/health` probe would report healthy for a wrong key).

| Endpoint | Shape |
| --- | --- |
| `POST /v1/convert/file` | multipart; the upload field is **`files`** (array); `target_type` defaults to `inbody`; returns the `ConvertDocumentResponse` in the body |
| `POST /v1/convert/source` | JSON `{ sources, options, target, callbacks }`; sources are discriminated by `kind` (`file` \| `http`) |
| `POST /v1/chunk/{hybrid,hierarchical}/source` | JSON like the convert source request, but the conversion settings live under **`convert_options`** (the chunk request model names the field differently from the convert one) |
| `…/async` variants of all three | return a task id instead of the result; poll it with `GET /v1/status/poll/{task_id}?wait=n` and read it with `GET /v1/result/{task_id}` |

Notes from the live v1.32.0:

- **`http` sources pass an SSRF gate** that accepts only globally
  routable hosts — a `file` source (bytes, the piece's `Convert file`
  action) is the way to convert documents behind a private URL such as a
  self-hosted archive.
- A sync conversion returns `{ document, status, errors, … }` where
  `status` is `success` / `partial_success` / `failure` and `document`
  carries the requested output formats (`md_content`, `json_content`,
  `html_content`, …).
- The stock CPU image bundles the layout, table-structure, and OCR
  (RapidOCR) models; the **first** conversion loads them and takes a
  minute or two, later ones are fast.

## Actions

| Action | What it does |
| --- | --- |
| **Health** | `/health` + `/version` — service status without auth |
| **Convert file** | An attachment (the workflow's file handoff) via `/v1/convert/file`; sync or async |
| **Convert URL** | An `http` source via `/v1/convert/source` — the *server* fetches it, so the bytes never pass through the workflow, subject to the SSRF gate (globally routable hosts) |
| **Transcribe URL** | Audio or video via ASR, returning timed segments, the speakers it detected and a rendered transcript |
| **Submit job** | Async submit (convert or chunk); returns the task id for a later **Get result** |
| **Get result** | `/v1/result/{task_id}` for a previously submitted job |
| **Chunk** | `/v1/chunk/{hybrid,hierarchical}/source` — converts and chunks in one call |

All conversion actions share the same options block (format, OCR, table
mode, page range, enrichments, …); defaults match the stock image's
out-of-the-box behavior (markdown, OCR on) and anything left alone is
omitted from the request, so the server keeps owning its own defaults.

Two props are worth calling out:

- **Filename** (on *Convert URL* and *Transcribe URL*) names the document
  when the URL does not. The format is read from the extension, and a
  share link — `drive.google.com/uc?id=…` — carries none. Leave it empty
  when the URL ends in the file's own name.
- **Include Figures** returns the pictures and display formulas. The
  add-on cuts them out of the pages as PNGs; a docling-serve embeds the
  images it already extracted. It costs a second pass and makes the
  response much larger, so it is off by default.

## Build

`pnpm build` emits the piece at `dist/node/pieces/docling/index.mjs`
with the framework inlined, and copies `powerhouse.manifest.json` into
`dist/`. That module is what `pieces/index.ts` declares and what a
reactor loads.

## Tests

- `pnpm test` — builds, then runs the unit + conformance suites against the in-process
  `mock-docling-serve` (v1 route-level key gating, the `files`/`options`/
  `convert_options` contract, status polling, error taxonomy, output
  schemas).
- Live e2e (needs Docker):

  ```sh
  docker compose -f test/e2e-compose.yml up -d
  DOCLING_E2E_URL=http://localhost:5001 \
  DOCLING_E2E_API_KEY=docling-e2e-key \
    pnpm vitest run test/e2e.test.ts
  docker compose -f test/e2e-compose.yml down -v
  ```

  The stack pins `ghcr.io/docling-project/docling-serve-cpu:v1.32.0`
  with an API key set, so the key-gated `/v1/*` paths (401 with a bad
  key) are exercised too. The first conversion loads the layout model,
  so the suite's readiness wait allows several minutes.

- `pnpm tsc` / `pnpm lint` — type check and lint.
