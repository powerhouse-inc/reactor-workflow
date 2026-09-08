# Workflow Automation — Document Set

Prepared 2026-08-28 from the repositories checked out in `D:\projects\ph-win`.
Audience: the agent (and humans) implementing standardized workflow automation in Powerhouse.

Read in order:

| # | Document | What it gives you |
|---|---|---|
| 1 | [`01-repository-landscape.md`](./01-repository-landscape.md) | Architecture and technical design of all six repositories, with the consolidated **touch-point index** (§7): what must be extended, what must be reused, and the constraints that shape the design |
| 2 | [`02-feature-spec.md`](./02-feature-spec.md) | The feature specification: document models with GraphQL schemas, the connector module contract, block taxonomy, runtime architecture, execution semantics, security model, host integration per surface, the IDP suite, acceptance criteria |
| 3 | [`03-implementation-plan.md`](./03-implementation-plan.md) | Eleven phases with per-phase files, exit criteria and explicit "do not do this yet" boundaries; testing strategy; risk register; definition of done |
| 4 | [`04-open-questions.md`](./04-open-questions.md) | 17 decisions that need a human, each with a recommendation so work can proceed |
| 5 | [`05-sota-research.md`](./05-sota-research.md) | Should the runtime be built on an existing open-source library? A survey of ~20 candidates against seven hard gates, a recommendation, and four further questions (Q18–Q21) |
| 6 | [`06-ap-red-compatible-architecture.md`](./06-ap-red-compatible-architecture.md) | Can we run Activepieces pieces and Node-RED nodes unmodified? Measured against both checkouts: yes for pieces (gated on one missing surface), no for nodes; which of their MIT/Apache components to reuse; questions Q22–Q25 |
| 7 | [`07-domain-providers-spec.md`](./07-domain-providers-spec.md) | **Value domains** — a document-model-layer feature unifying **scalars** (shippable as a new module kind) and **domain providers** under one contract with three reaches, plus how an impure check coexists with portable, verifiable documents (attestation). Questions Q26–Q31 |
| 8 | [`08-workflow-automation-spec.md`](./08-workflow-automation-spec.md) | **The feature specification, rewritten** as an Activepieces-compatible runtime. **Supersedes doc 2.** |
| 9 | [`09-secrets-service-spec.md`](./09-secrets-service-spec.md) | How a secret is stored, minted and rotated, replacing env-var resolution. *Proposed* |
| 10 | [`10-http-routes-spec.md`](./10-http-routes-spec.md) | **Package-hosted HTTP routes and webhooks** — the three-layer design that lets any package serve REST alongside the switchboard API, and the token-addressed webhook preset on top. *Implemented, awaiting release* |

Also: [`09-spike-activepieces-loader.md`](./09-spike-activepieces-loader.md) — a
self-contained spike instruction de-risking the Path B piece loader (doc 6
§2.4/§6). Numbered 09 alongside the secrets spec; not a step in the reading
order.

Original input: [`20260828-briefing.md`](./20260828-briefing.md).

---

## The short version

> **Docs 5–8 changed the design.** Doc 8 supersedes doc 2: the connector contract is no longer ours to
> invent — it *is* the Activepieces piece contract, vendored and extended, so a large majority of
> their 728 open-source pieces run on Powerhouse unmodified. Doc 7 spins the configuration half out
> into **domain providers**, a document-model-layer feature that outlives this project. Docs 2–4
> remain accurate on everything neither doc revises.

**What is being built.** Four things: a `connector` module type (a fifth kind alongside document
models, editors, processors and subgraphs) whose interface is the Activepieces piece interface; a
workflow runtime that supervises triggers and executes runs in isolated workers with a durable
journal; `powerhouse/workflow` as a document model, so automations are configured at runtime by users
rather than compiled in; and **value domains**, which bind a schema field's legal values either to a
shippable scalar or to live state — the mechanism that makes both their dropdowns and our own
reference fields work.

**Why it fits.** Almost every mechanism already exists and is being extended rather than duplicated:

- the package loader and manifest gain one more module key (`packages/reactor-api/src/packages/`,
  `packages/shared/document-model/schemas.ts`)
- the worker wire protocol and its sanitiser/error-marshalling are reused verbatim
  (`packages/reactor/src/executor/worker/protocol.ts`)
- processor cursor/backfill/errored-state semantics are the model for trigger supervision
  (`packages/reactor/src/processors/processor-manager.ts`)
- the Vetra spec-document → codegen pipeline gains one more generator
  (`packages/vetra/processors/codegen/document-handlers/generators/`)
- ph-clint's `defineTrigger`/`defineCommand` become the two-way agent bridge
- PFNÜR's ports/adapters, delivery-authority and containment discipline become the engine's
  execution semantics
- three recipes (`inbound-webhook-bridge`, `external-feed-ingest`, `saga`) are lifted almost
  literally into the trigger supervisor

**The four things most likely to go wrong**, and where they are handled:

1. Third-party connector code destabilising the reactor → **worker isolation from Phase 4**, not an
   optimisation.
2. Secrets reaching the run journal → **secrets never enter a `StepJob`**; the host resolves them
   per step and journals a **separately-resolved censored copy** of every input (doc 8 §10 — string-
   matching a secret value misses one that was base64'd or sliced); a security test in CI.
3. A run-document storm through sync → **relational journal is authoritative**, documents are
   opt-in per workflow plus always for failures.
4. The desktop having no Redis and no Postgres → **the queue is a port** whose default driver runs
   on PGlite; this is spiked in Phase 0 before any schema is committed.

**Two corrections to the briefing.** The Tauri desktop prototype is `ph-win-desktop/`, not
`win-test/` (which holds only a stale boilerplate README). The registry is not a separate checkout —
it lives at `powerhouse/packages/registry`.

**Build or adopt?** Doc 5: **build the engine** (no candidate survives the licence and
runtime-configurability gates), **take `pg-boss`** as the embedded queue driver (MIT, and it runs on
PGlite — this retires the desktop-queue risk), and **adopt MCP as the connector ecosystem for
actions** rather than any of the automation platforms, whose licences (n8n, Pipedream, Nango,
Restate) or shape rule them out. Doc 6 then measured Activepieces directly and found the third
answer: **adopt their contract, not their engine** — the compatibility surface is four module
specifiers and one context object, and 642 of 728 pieces route every network call through a single
injectable client. Node-RED is closed at the code level and reached as a sidecar instead.

**The questions that matter most.** Doc 8 answers **Q4** (what identity a run writes as) by observing
it is the same authority that vouches for domain checks — a per-workflow **attester**, bounded at
enable time by the enabling user's grants. Still open in doc 4: where the workflow document models
live (Q1), whether Connect gets a real browser runtime in v1 (Q8), and whether v1 must support OAuth2
(Q10) — which doc 6 sharpened, since 117 pieces need it and they correlate with the ones that need
dynamic properties. Docs 5–7 add Q18–Q29; the load-bearing new ones are **Q23** (the domain
resolution channel's place in the editor) and **Q26** (whether the attester is a Renown identity).
