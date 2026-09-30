# @powerhousedao/piece-convert

Workflow blocks for the **Document Conversion** add-on — `@powerhousedao/docling-service`, a TypeScript service over `docling.rs`. Convert a document to markdown with retrieval-sized chunks, figures and an extraction score.

## Which docling is this?

Two different services in this stack are called docling, and they do not share an API. This piece speaks to the one the Vetra **Document Conversion** add-on deploys.

| | this piece (`piece-convert`) | `piece-docling` |
| --- | --- | --- |
| Service | `@powerhousedao/docling-service`, TypeScript over `docling.rs` | `docling-serve`, Python |
| Deployed by | the Vetra **Document Conversion** add-on, per environment | run it yourself, or Docling for IBM watsonx |
| Port | 5011 | 5001 |
| API | `POST /convert` with the file's bytes | `POST /v1/convert/source` with a JSON envelope |
| Auth | none — no ingress, in-cluster callers are trusted | `X-Api-Key` |
| Chunks | returned inline by `/convert` | a separate `/v1/chunk/...` call |
| Async jobs | none: `POST /convert` holds the connection | submit and poll a task id |
| Audio / video | no — its models are fetched with `--no-asr` | yes, with an ASR-capable image |

Pick this one when the add-on is enabled on your environment. Pick `piece-docling` when you run docling-serve yourself.

## Connecting

Enable **Document Conversion** on the environment. The chart then hands the reactor the service's address as `CONVERT_SERVICE_URL`, which looks like:

```
http://<release>-docling.<namespace>.svc.cluster.local:5011
```

Put that in the connection's **Service URL**. There are no credentials — the service carries no ingress and takes no key.

One thing that is easy to miss: a connector may not reach private address space unless it is allowed to. Add the service's address or CIDR to the **Workflows** add-on's *Allowed private addresses* (`PH_WORKFLOWS_EGRESS_ALLOW_ADDRESSES`), or every step fails to connect.

## Actions

| Action | What it does |
| --- | --- |
| **Health** | Whether the service is reachable and its models loaded, which formats it reads, which OCR rungs it has |
| **Convert File** | An attachment → markdown, chunks, extraction score; optionally figures |
| **Convert URL** | Downloads the document first, then converts it — the service itself takes bytes, not links |

`Convert URL` downloads the file itself, so the URL has to be one the workflow may reach, and it needs an extension to go on: the service picks the format from the filename. Set **Filename** when the URL ends in an id rather than a name.

## What comes back

`markdown` and `chunks` always; `pages`, `textSource` (which rung read the file — `docling`, `pdfjs`, `tesseract`, `docling-ocr`) and `quality` for PDFs. `quality.coverage` is the share of the file's text layer that reached the markdown — a floor on completeness, not a proof.

`ocrOffer` is set when the text layer was read flat and OCR would recover tables, with its estimated cost; re-run with **Force OCR** to take it.

With **Include Figures**, `figures[]` carries the document's pictures and display formulas as PNGs, each keyed to its placeholder in the markdown.

## Errors

The service converts one document at a time and answers `503` while busy. That comes back as a **retryable** error, so the engine waits rather than parking the run. `415` (a format it cannot read) and `500` (the conversion failed) are not retryable.

## Tests

`pnpm test` builds the piece and runs the suite against a mock service; no network and no container needed.
