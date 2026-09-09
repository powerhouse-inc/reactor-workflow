# Changelog

## 1.0.0 — 2026-09-09
- Initial release: docling-serve v1 integration (convert file/url, submit job,
  get result, chunk, health) with CustomAuth (base URL + optional API key).
- Connection validation probes a `/v1/` route for the key — v1.32.0 keys only
  the `/v1/*` routes, so `/health`/`/version` stay open even with a bad key.
- `convert_url` sources are SSRF-gated server-side: only globally routable
  hosts are accepted (no localhost/LAN fetches).
