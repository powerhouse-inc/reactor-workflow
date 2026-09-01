# Spike S6a notes — Activepieces Path B loader

**Date:** 2026-09-01 · **Runner:** Node v24.14.1, macOS · **Instruction:** `09-spike-activepieces-loader.md`
**Spike code:** superseded by `src/activepieces/` + `test/activepieces/piece-http.test.ts` (bundles fetched at runtime)
**Scope deviation (operator-directed):** `piece-discord` excluded; `piece-http` only. Test 2
(credentialed action) and the dropdown half of S6b-lite were not run.

## 1. Bundle facts

| | |
|---|---|
| Piece | `@activepieces/piece-http@0.11.19` (npm `latest`, fetched 2026-09-01 via `npm pack`) |
| Contents | single-file `src/index.js` (~600 KB) + `src/i18n/*.json`; 15 files total |
| package.json | only `name`, `version`, `main`, `dependencies: {}`, `files` — no `type`, `exports`, `module`, `license`, `repository` (as doc 09 §2.1 predicted) |
| Module format | **CJS**, `module.exports` wrapped by an esbuild re-export helper |
| Minified | **Yes**, but esbuild `keepNames` is on (`__name` helper present) — `class Piece` name survives |

## 2. Loading (§3)

- `import()` of the CJS file worked directly through Node's ESM↔CJS interop — the `require()`
  fallback was never needed. Export keys seen: `['default', 'http', 'module.exports']` (the literal
  `'module.exports'` key is esbuild's CJS-annotation quirk; harmless, but don't be surprised by it).
- Duck-typing via `constructor.name === "Piece"` **worked** on the minified bundle. Keep the
  structural fallback (`displayName` + `actions`/`getAction`) anyway — `keepNames` is their build
  choice, not a contract.
- Entry resolved from `package.json#main`. No `exports` map existed.

## 3. Introspection dump (trimmed)

```
prototype: [constructor, metadata, getAction, getTrigger, actions, triggers]
own keys:  [displayName, logoUrl, authors, events, categories, auth,
            minimumSupportedRelease, maximumSupportedRelease, description,
            deprecated, _actions, _triggers, getContextInfo]
displayName: 'HTTP'   auth: undefined   minimumSupportedRelease: '0.82.0'
metadata() keys: [displayName, logoUrl, actions, triggers, categories, description,
                  authors, auth, minimumSupportedRelease, maximumSupportedRelease,
                  deprecated, contextInfo]
triggers: {}
```

`send_request` (displayName "Send HTTP request", `run` is a function, `requireAuth: true`):

| prop | type | required | notes |
|---|---|---|---|
| `method` | STATIC_DROPDOWN | yes | values GET/POST/PATCH/PUT/DELETE/HEAD |
| `url` | SHORT_TEXT | yes | |
| `headers` | OBJECT | yes | |
| `queryParams` | OBJECT | yes | |
| `authType` | STATIC_DROPDOWN | yes | default `"NONE"`; NONE/BASIC/BEARER_TOKEN |
| `authFields` | DYNAMIC | no | `props()` fn — see §6 |
| `body_type` | STATIC_DROPDOWN | no | default `"none"`; none/form_data/json/raw |
| `body` | DYNAMIC | no | |
| `response_is_binary`, `use_proxy`, `followRedirects` | CHECKBOX | no | |
| `proxy_settings` | DYNAMIC | no | |
| `timeout` | NUMBER | no | **unit is seconds**, not ms (doc 09 §5.1 guessed `10000`) |
| `failureMode` | STATIC_DROPDOWN | no | default `continue_none`; retry_all/retry_5xx/retry_none/continue_all/continue_4xx/continue_none |

Also: `errorHandlingOptions: { continueOnFailure: {hide:true}, retryOnFailure: {hide:true} }` —
the piece hides the engine-level toggles and re-implements retry/continue as its own prop.
Second action `parse_url` (url, returnArrays) present; no triggers.

## 4. Execution (§5)

**Happy path** — `GET https://httpbin.org/get?spike=s6a`, `authType:"NONE"`, `timeout:10`:
returned `{ status: 200, headers: {...}, body: { args: { spike: "s6a" }, ... } }`. Output shape is
`{status, headers, body}`. **PASS.**

**Context members touched:** `propsValue` only — measured with a Proxy that also flags reads of
undocumented members (none occurred). Matches doc 08 §4.2's "all pieces" tier; nothing else on the
mock was exercised, so the rest of the mock's shape guesses remain unvalidated by this piece.

**`requireAuth: true` is not evidence a credential is needed** — piece `auth` is `undefined` and
the action ran with `auth: undefined`. Treat `requireAuth` as UI metadata, not a contract.

**🔴 Security finding:** the inlined `FetchHttpClient.sendRequest` (from `@activepieces/pieces-common`)
executes `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` on **every request** — it disables TLS
certificate verification **process-wide, permanently**. Observed live (Node printed the insecurity
warning during the spike). In-process hosting is therefore not just risky but self-poisoning: after
the first piece HTTP call, *the host's own* outbound TLS is unverified. This hard-mandates the
worker isolation of doc 08 §7.5 and needs an explicit env-hardening note in §10.

### Error paths (§5.3)

| Case | Thrown | Shape |
|---|---|---|
| HTTP 404 (`failureMode: continue_none`) | `HttpError` | own keys `[requestBody, status, responseBody]`; `message` is JSON: `{"response":{"status":404},"request":{}}` |
| Timeout (2 s vs 10 s delay) | `DOMException` | `message: "This operation was aborted"`, `code: 20` (AbortError) |
| HTTP 404 (`failureMode: continue_all`) | **nothing** | resolves normally with `{ response: { status: 404 }, request: {} }` |

Raw errors are heterogeneous (custom class vs platform DOMException) and, with `continue_*` modes,
failures can come back as *successful output with a different shape*. `ctx.failure.classify`
(doc 08 §4.3) must handle all three.

## 5. S6b-lite, adapted (§6)

`piece-http` has no dynamic DROPDOWN (only STATIC_DROPDOWNs, whose `options` are plain data), so
the literal `options()` probe could not run under the http-only restriction. The mechanically
equivalent channel — a DYNAMIC prop's `props()` function — **is invocable out-of-band**:

```js
await action.props.authFields.props(
  { authType: "BASIC" },                                    // refresher values
  { searchValue: undefined, connections: { get: async () => null } },  // minimal PropertyContext
)
// NONE → {}   BASIC → { username: SHORT_TEXT, password: SHORT_TEXT }   BEARER_TOKEN → { token: SHORT_TEXT }
```

Full pass on the mechanical question for DYNAMIC; `Property.Dropdown.options()` itself remains
untested (needs a piece with a dynamic dropdown — residual for the follow-up spike).

## 6. Decision table (§7)

| # | Question | Answer |
|---|---|---|
| 1 | `import()` + duck-typing loads a published bundle? | **Yes.** Minified CJS, loaded ESM-first via interop; `constructor.name === "Piece"` worked (keepNames on) |
| 2 | Descriptor enumerates cleanly? | **Yes** — actions, props (names/types/required/defaults), auth, `metadata()` all clean. (One piece only) |
| 3 | No-auth action end-to-end under mock context? | **Yes** — 200 + echo of `spike=s6a`; output `{status, headers, body}` |
| 4 | Credentialed action (Discord webhook)? | **Not tested** — excluded by operator instruction |
| 5 | Context members touched? Undocumented members? | `propsValue` only; none undocumented (Proxy-verified) |
| 6 | Raw error shapes? | `HttpError {requestBody,status,responseBody}` for HTTP errors; `DOMException` AbortError for timeout; `continue_*` modes convert failure into normal output |
| 7 | (S6b-lite) `options()` invocable out-of-band? | DROPDOWN untested (no candidate in piece-http); DYNAMIC `props(refresherValues, minimalCtx)` **yes**, signature above |
| 8 | **Decision** | **PASS WITH CAVEATS** — doc 08 §6.3 stands; caveats below feed §4.2/§4.3/§7.5/§7.6/§10 |

## 7. Corrections to docs 06 / 08 / 09

1. **doc 08 §10 (new, load-bearing):** pieces-common's HTTP client sets
   `NODE_TLS_REJECT_UNAUTHORIZED="0"` process-wide on every `sendRequest`. The worker boundary
   (§7.5) is mandatory, and the worker should re-pin the env var (or refuse to inherit env) —
   the egress guard cannot assume TLS verification is intact inside the piece process.
2. **doc 08 §7.6 (retries):** pieces can self-retry/self-swallow via their own `failureMode` prop
   while `errorHandlingOptions` hides the engine toggles. Host retry authority must account for
   piece-side retry (double-retry risk) and for failures surfacing as successful output.
3. **doc 08 §4.3 (`failure.classify`):** classify at minimum `HttpError`-shaped
   (`status`/`responseBody` own-props) and `DOMException` AbortError; do not rely on `message`
   being human-readable (HttpError's message is JSON).
4. **doc 08 §4.2:** validated for `piece-http` — only `propsValue` touched; `requireAuth` is UI
   metadata, not a credential contract. Duck-typing + no-`instanceof` rule confirmed workable.
5. **doc 09 §5.1:** real prop set differs from the guess — `timeout` is in **seconds**;
   `authType`/`authFields`/`body_type`/`failureMode` exist; `headers`/`queryParams` are required.
6. **doc 09 §3:** the ESM-first/CJS-fallback loader is right but the fallback was unnecessary for
   this bundle; expect the stray `'module.exports'` export key from esbuild.

## 8. Recommended next step (doc 06 §2.8)

- `descriptor.ts`: build straight from `piece.metadata()` — it exists on current bundles and
  carries everything Tier-1 conformance needs (actions with props, auth, release bounds,
  `contextInfo`). Normalize prop descriptors to `{name, type, required, defaultValue,
  hasDynamicResolver}` where `hasDynamicResolver = typeof prop.options === "function" ||
  typeof prop.props === "function"`.
- `context/action.ts`: implement `propsValue` + `auth` + `store` first (doc 08 §4.2 tiers);
  everything else as throwing stubs that log — the Proxy-based touch tracker from this spike is
  worth keeping in dev builds to catch undocumented member reads in the long tail of pieces.
- Loader: ESM-first `import()`, `constructor.name` check with structural fallback, entry from
  `main` — as spiked. Ban `instanceof` (confirmed: bundle inlines its own framework copy).
- Follow-up spikes: (a) a credentialed action + a real dynamic `options()` on a piece with a
  dynamic dropdown; (b) trigger lifecycle; (c) worker-boundary env hardening for the TLS finding.
