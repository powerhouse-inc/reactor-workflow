# Changelog

## 1.1.0 — 2026-09-30

This is now the only document-conversion piece: `@powerhousedao/piece-convert`
was folded into it and removed. One piece, one API, either server — the
Document Conversion add-on or a self-hosted docling-serve.

- **Transcribe URL** (added in 1.0.x, previously undocumented) transcribes
  audio and video, returning timed segments, detected speakers and a rendered
  transcript.
- **Filename** on *Convert URL* and *Transcribe URL* names the document when
  the URL does not. The format is read from the extension and a share link
  (`drive.google.com/uc?id=…`) carries none, so this was the difference
  between "converts" and "cannot be converted at all" for the commonest way a
  file is shared. Needs docling-service ≥ 0.4.0; a stock docling-serve ignores
  the field.
- **Include Figures** returns the pictures and display formulas. The add-on
  cuts them out of the pages as PNGs; a docling-serve embeds the images it
  already extracted. Off by default — it costs a second pass and a much
  larger response.
- The **`powerhouse`** block is now listed as an output of the convert,
  chunk and transcribe actions and typed on the response: `quality.coverage`,
  `textSource`, `ocrOffer`, `pages`, `figures`, `backend`. Present only from
  the add-on (docling-service ≥ 0.3.0) and absent from a stock docling-serve,
  so read it with `?.`.
- **415 is now `UNSUPPORTED`** rather than a generic `JOB_FAILED`, and not
  retryable: the same bytes meet the same refusal, and the recovery is to
  check the formats the server reports on `/health`.
- Dropped the declared `zod` dependency; nothing imported it.

## 1.0.0 — 2026-09-09
- Initial release: docling-serve v1 integration (convert file/url, submit job,
  get result, chunk, health) with CustomAuth (base URL + optional API key).
- Connection validation probes a `/v1/` route for the key — v1.32.0 keys only
  the `/v1/*` routes, so `/health`/`/version` stay open even with a bad key.
- `convert_url` sources are SSRF-gated server-side: only globally routable
  hosts are accepted (no localhost/LAN fetches).
