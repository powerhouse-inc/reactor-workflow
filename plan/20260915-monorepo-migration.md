# Migrating `reactor-workflow` into the monorepo — handoff and plan

**Written:** 15 September 2026, revised 16 September (three times; §4 records what landed, with pull request numbers). **Audience:** whoever reviews and merges the stack, and
whoever does step 4.
**Companions:** [`03-implementation-plan.md`](./03-implementation-plan.md) for the
phase structure this replaces the tail of, [`08-workflow-automation-spec.md`](./08-workflow-automation-spec.md)
§1.1, §4.1, §7.1 and §12 for the piece contract and where the runtime was always
meant to live, and [`10-http-routes-spec.md`](./10-http-routes-spec.md) §8.4 for
the release ordering that already bit us once.

## What this is

`reactor-workflow` was extracted from the monorepo on 1 September 2026 so the
engine could be built without dragging a 26-package release train behind every
commit. That worked: 183 commits, 1,077 tests, a runtime that fires real
triggers against real services. The cost is now the dominant one — the repo
consumes `@powerhousedao/*` at a pinned dev version, so every core change is a
publish-then-bump round trip, and the two repos have already deadlocked on each
other twice (doc 10 §8.4, and the `6.2.3-dev.8`/`dev.9` unresolvable set on
14 September).

This document says what moves, where it goes, in what order, and what the move
is allowed to change on the way.

**Four decisions are fixed going in**, all from the person who asked for this:

1. The workflow engine moves into `reactor-api` and is composed there **as its
   own component**, not bootstrapped by a processor factory.
2. **Enabling it loads the workflow document models and subgraphs
   automatically**, the way `@powerhousedao/vetra` is loaded today.
3. **The pieces stay here.** `piece-paperless-ngx` and `piece-docling` do not
   move; this repo becomes the library of first-party pieces Powerhouse
   maintains — §2.6.
4. **The Activepieces piece framework is vendored** under a Powerhouse name,
   as doc 08 §4.1 intended and nobody built — §2.4.

**Two goals shape everything else:** add as few packages to the monorepo as
the work allows, and keep the path for an external developer adding a piece to
their reactor package short. The first draft of this plan proposed three
packages and a `shared` subpath; the second collapsed that to two; the third,
this one, is back to **three packages** — but for a reason the first draft did
not have, and with the dependency arrows all pointing one way (§2.3).

---

## 1. What exists today

Measured on `workflow/piece-umh` at `b7535e5`, excluding `node_modules`, `dist`
and `coverage`.

| Area | Files | Lines | Notes |
| --- | ---: | ---: | --- |
| `packages/workflow/subgraphs/` | 63 | 16,565 | **The engine.** `service.ts` alone is 2,120 lines; `trigger-supervisor.ts` 970; `store.ts` 1,039 |
| `packages/workflow/editors/` | 77 | 12,669 | Workflow builder (react-flow), connection editor, Workflow Studio drive app |
| `packages/reactor-connectors/src/` | 36 | 6,131 | Activepieces loading, worker pool, block executor, expressions, connection shaping |
| `packages/workflow/document-models/` | 117 | 5,402 | `powerhouse/workflow` + `powerhouse/connection`; 68 generated files, 49 hand-written |
| `packages/workflow/pieces/` | 14 | 1,243 | The `reactor` piece this package ships |
| `packages/workflow/ai/` | 6 | 1,280 | Tools this package offers Connect's assistant |
| `packages/workflow/processors/` | 9 | 183 | `document-event-trigger` — and the engine's current boot path |
| `packages/piece-paperless-ngx/` | 67 | 8,194 | Standalone Activepieces piece, 134 tests |
| `packages/piece-docling/` | 55 | 3,225 | Standalone Activepieces piece, 72 tests |
| `packages/piece-umh/` | 61 | 3,702 | Already moving to `umh-production-ledger` — see PR #31 |
| `demo/`, `demo-umh/` | 7 | 1,739 | Compose files, seeds, and the graph tests |

1,077 test cases across 129 files. Every live test is guarded
(`describe.skipIf(!process.env.…)`), so none of them needs a service in CI.

### 1.1 What a piece author actually imports from us

This number decides the package layout, so it was measured rather than
assumed. Every `@powerhousedao/*` import across the two standalone pieces, the
`reactor` piece and the demos, by symbol:

| Who | Imports from `reactor-connectors` | What for |
| --- | --- | --- |
| `pieces/reactor/lib/reactor.ts` | `type ReactorService` | the type of `ctx.reactor` |
| `pieces/index.ts` | `type PackagePiece` | the shape of the `pieces` barrel |
| `piece-*/test/conformance.test.ts` | `loadPieceFromDir`, `buildDescriptor`, `PieceWorkerPool`, `ensurePieceBundle` | the tier-1 gate — behind a dynamic import that skips when the package is absent |
| `demo-umh/test/*.mjs` | `CompositeBlockExecutor`, `runWorkflow` | run a graph through the real coordinator with the piece blocks faked |

Two types at build time, and a test harness. Everything else in the package —
egress, redaction, the worker pool, the coordinator, the block executor — is
host machinery a piece author never names. The framework they *do* write
against is `@activepieces/pieces-framework`, in every file (nine imports in the
`reactor` piece alone).

### 1.2 What the engine actually imports from `reactor-api`

This number decides whether the engine can be its own package, and the first
two drafts got it wrong by assuming rather than measuring. Every import of
`@powerhousedao/reactor-api` in the runtime, by file:

| File | Imported | Kind |
| --- | --- | --- |
| `service.ts` | `BaseSubgraph`, `Context`, `IWebhookEndpoints`, `IWebhookScope`, `WebhookPolicy`, `WebhookReply`, `WebhookRequest` | type-only |
| `lib.ts`, `reactor-port.ts` | `BaseSubgraph` | type-only |
| `webhook.ts`, `piece-handshake.ts` | webhook field and reply types | type-only |
| `resolvers.ts` | `BaseSubgraph`, `Context` | type-only |
| `index.ts` (the subgraph class) | `BaseSubgraph` | **value** — the only one |
| tests | `getDbClient`, `HttpRouteService`, `WebhookService`, `MemoryWebhookStore`, `createHttpAdapter` | value, tests only |

The webhook types originate in `@powerhousedao/shared/processors`;
`reactor-api` re-exports them. `BaseSubgraph` is used as a bag of four things
— `relationalDb`, `reactorClient`, `assertCanRead`, `http.webhooks` — and
`Context` is passed through opaquely. So the engine's real dependency on
`reactor-api` is one class, the GraphQL subgraph, plus test helpers. Both can
live in `reactor-api`.

### 1.3 How the engine boots today, and why that has to change

`WorkflowRuntimeService` is a module-level singleton in
`subgraphs/workflow-runtime/service.ts:2120`. Two unrelated things start it:

* **The subgraph** (`subgraphs/workflow-runtime/index.ts`) calls `configure()`
  from its constructor — which opens the run store and seeds the trigger
  registry off `subgraph.relationalDb` and `subgraph.reactorClient` — and
  registers the webhook endpoint family from `onSetup()`.
* **A processor factory** (`processors/document-event-trigger/factory.ts`)
  hands it the attachment client and calls `startTriggerSupervisor()`, because
  `IProcessorHostModule` is the only host surface that carries
  `attachments`. Its `onDisconnect` is also the only teardown that fires on a
  hot reload, so it owns `shutdown()` too.

So the runtime's lifetime is stitched together from a GraphQL object's
constructor and a per-drive processor's disconnect callback, neither of which
is about workflows. That is the thing to delete. It also explains a class of
bug we have already paid for: seeding races registration
(doc 10 §8.2), and the singleton is keyed on "which subgraph instance am I
looking at" to survive hot reload. Three pieces of module state break the
moment a process holds two runtimes: the SIGTERM hook guard, the processor
factory's `live` guard, and the store's `runsInFlight` set.

---

## 2. Where it goes

### 2.1 Naming — what the plans said, and what shipped

The specs were written before the implementation found its shape. Both
vocabularies are in the code and the docs, so fix the mapping once, here.

| Doc 03/08 name | What actually exists | Decision |
| --- | --- | --- |
| `connector` module kind, `connectors/` dir, manifest key `connectors` | **`pieces`** — landed in the monorepo on 14–15 September (`46c64869`, `1b8730ae`): `ManifestSchema.pieces`, `MODULE_KEYS`, the node build entry, the `./pieces` export map | **Keep `pieces`.** The plan's `connector` was our own contract; we adopted theirs instead (doc 08 §4.1), and the name should say so |
| `@powerhousedao/reactor-workflow` (Node runtime) | `packages/workflow/subgraphs/workflow-runtime/` + `packages/reactor-connectors/src/` | **Becomes the package, with the spec's name.** The engine, node-only, no dependency on `reactor-api` — §2.2, §2.3 |
| `@powerhousedao/shared/workflow` | Nothing | **Do not create it.** The piece-facing types live in the framework package; the runtime's host contract lives in the engine; the webhook types were already in `shared/processors` |
| `@powerhousedao/workflow-compat` (doc 08 §4.1, §7.1) | Nothing. The pieces pinned the last npm release of `@activepieces/*` | **Became `@powerhousedao/pieces-framework`** — §2.4 |
| `packages/workflow-models` (doc 04 Q1, option A) | `packages/workflow/document-models/` | **Do not create it.** The models stay beside the editors — §2.2 |
| `packages/reactor-workflow/src/subgraph/` (doc 03 §6.1) | `subgraphs/workflow-runtime/{index,schema,resolvers}.ts` | **Moves into `reactor-api`** as `src/graphql/workflow/`, a conditional core subgraph. The name `workflow-runtime` is kept; it is on live registrations |
| — (no plan proposed it) | `@powerhousedao/reactor-connectors` | **Not a package.** Its source is `packages/reactor-workflow/src/pieces/`. The name was never published (`npm view` 404s) |

**The six descriptor types were renamed** — `ConnectorDescriptor`,
`ConnectorPropDescriptor`, `ConnectorActionDescriptor`,
`ConnectorTriggerDescriptor`, `ConnectorAuthDescriptor`, `ConnectorSource`
are now `Piece*`. Doc 04 Q14's warning about `connector` colliding with the
diagramming sense was real: there is a react-flow canvas in this repo with an
`ap-edge.tsx` in it.

**`connectorId` was not renamed.** It is a field on `powerhouse/connection`
(doc 08 §5.2), it is in every live connection document, and
`packageFromConnectorId` parses it. Renaming a persisted field is a schema
migration, not a rename, and it is not in scope here.

### 2.2 Target packages

Three new packages. Every dependency edge points the same way, and none of
them is a peer, an optional peer, or a host-supplied loader:

```
@powerhousedao/pieces-framework     vendored @activepieces/pieces-framework (+ ./common),
                                    widened with ctx.reactor; PackagePiece; reactorOf   (leaf, MIT)
        ▲                 ▲
        │                 └──────────────── every piece, ours or anyone's (inlined at build)
        │
@powerhousedao/workflow             the Connect-loaded package, ph-build layout:
  ./document-models[/*]               powerhouse/workflow, powerhouse/connection        (browser + node)
  ./editors, ./reactor, ./manifest    builder, connection editor, Studio; the worker's entry (browser)
  ./pieces[/*]                        the reactor piece, framework inlined              (node)
  ./style.css                         Tailwind output plus the editors' emitted CSS
        ▲
@powerhousedao/reactor-workflow     the engine, node-only:
  src/reactor                         supervisor · coordinator · stores · ports · registry
  src/pieces                          loader · worker pool · egress · executor · expressions
  ./testing                           loadPieceFromDir, buildDescriptor, the pool, runWorkflow
        │   deps: workflow (action creators, model types), pieces-framework, shared, reactor,
        │         document-model, croner.  NEVER reactor-api — not even as a devDependency.
        ▲
@powerhousedao/reactor-api          depends on both; reads the flag; imports the engine lazily
  src/workflow/{flag,host}.ts         with a literal import(); ships the workflow-runtime
  src/graphql/workflow/               subgraph as a conditional core subgraph; loads the
                                      models through PackageManager's static-prereq path
```

**Why the models are not their own package.** An earlier draft of this plan
split them out as `@powerhousedao/workflow-models`, following doc 04 Q1 option
A, on the grounds that the engine and the editors both need them and the
editors carry `@xyflow/react`. Three facts kill that:

* **The models are not a leaf and cannot be made one.** Codegen emits
  `document-models/*/v1/hooks.ts`, which imports `useDocumentById`,
  `useSelectedDocument` and friends from `@powerhousedao/reactor-browser` as
  values, and the generated barrel (`v1/index.ts`) re-exports it. A
  `workflow-models` package would therefore put `reactor-browser` in the
  server's install — the exact cost the split was supposed to avoid.
* **It would break `ph generate`.** 68 of the 117 model files are generated
  from the specs beside them, into a project whose `powerhouse.config.json`
  names `documentModelsDir` and `editorsDir` together. Splitting them means two
  Vetra projects, or hand-maintaining generated output across a package
  boundary.
* **Vetra already answers the question.** `@powerhousedao/vetra` ships document
  models, editors and processors in one package with `react` and
  `@powerhousedao/design-system` in its `dependencies`, and `apps/switchboard`
  imports `@powerhousedao/vetra/document-models` on the server. The monorepo
  has already accepted this trade; a stricter rule here would be a local
  invention.

**Why the `ph build` layout and not vetra's.** Vetra is a Connect built-in,
imported statically. An external package is loaded by Connect from
`<pkg>/browser/index.js`, `<pkg>/style.css` and `<pkg>/package.json`
(`apps/connect/src/package-manager.ts`), so `@powerhousedao/workflow` builds
exactly as `ph build` builds a scaffolded project: browser and node bundles
from `@powerhousedao/shared/build-config`, types from `tsc --build` into
`dist/types`, Tailwind for the stylesheet, the export map `ph init` writes
plus `source` conditions for the root typecheck. `packages/powerhouse-vetra-packages`
was the in-tree template. It also means the reactor piece is emitted at
`dist/node/pieces/reactor/index.mjs` with the framework inlined — the same
shape an external developer's pieces take, so the package doubles as the
example.

### 2.3 Why the engine is its own package after all

The second draft merged the engine into `@powerhousedao/workflow` on the
argument that it had to depend on `reactor-api` for `BaseSubgraph` anyway, so
a separate package bought nothing. §1.2 shows the premise was wrong: the only
value import is the subgraph class, and everything else is types that either
live in `shared` already or are a four-field host contract. Once the subgraph
moves into `reactor-api`, the engine depends on nothing above it, and the
picture in §2.2 is a straight line.

What that buys, concretely:

* **No inversion at the seam.** `reactor-api` declares
  `@powerhousedao/reactor-workflow` as an ordinary dependency and imports it
  with a literal `import()` behind the flag. `tsc --build` resolves it,
  `dpdm` sees no cycle, no host passes a loader, no variable-specifier trick,
  no optional peer. The second draft needed all four because it had the
  arrow pointing the wrong way — and it would not have worked anyway, because
  `update-ts-references` derives project references from `peerDependencies`
  and `devDependencies` too, so even an optional peer creates a reference
  cycle.
* **The subgraph is registered like `AuthSubgraph`.** One conditional push
  onto `coreSubgraphs`, no `extended` map, no namespace trickery. The class is
  created by a factory that closes over the runtime instance, which is how the
  singleton goes away.
* **The pieces repo gets a node-only devDependency.** Its conformance tests
  and the demos import from `@powerhousedao/reactor-workflow/testing`, not
  from a package that carries react-flow.
* **The seam between "knows the reactor" and "does not" is a directory plus a
  lint rule**, exactly as the second draft proposed: `src/pieces/**` may not
  import `@powerhousedao/*` or `../reactor`, enforced by a `no-restricted-imports`
  block in the root ESLint config. The 266 loader tests still run with no
  reactor, no database and no GraphQL.

What it costs: one more package than the second draft, and three constraints
the engine must hold forever. It may not depend on `reactor-api`, not even in
`devDependencies`. Its tests build their own PGlite relational db instead of
borrowing `getDbClient`. And the three webhook integration suites, which need
`HttpRouteService` and `WebhookService`, live in `reactor-api`'s test tree with
the subgraph, which is where the composed webhook path belongs.

### 2.4 The vendored framework: `@powerhousedao/pieces-framework`

**What upstream did, and why.** Checked on 16 September against
`activepieces/activepieces` at 0.91.0 and against npm:

* From v0.86.0 (1 July 2026) every piece builds into a self-contained bundle
  with `@activepieces/*` inlined — PR #13822, "so the engine can provision a
  piece by downloading one artifact instead of running `bun install` at
  runtime". Installs went from seconds to under 100 ms. That is the whole
  motivation: cold-start, not licensing.
* PRs #13830/#13834 then stopped publishing `pieces-framework`,
  `pieces-common`, `shared` and `core-*`, since no published piece declares
  them any more. npm agrees: `pieces-framework` stops at **0.32.0
  (17 June 2026)**, `pieces-common` at 0.12.5, `shared` at 0.96.2. The source
  has kept moving — `pieces-framework` is at **0.39.0** in the repo, `shared`
  at 0.171.0.
* Their bundling doc: "These libraries are never published to npm; they only
  exist as part of each piece's bundle." Their `release-pieces.yml` says the
  same in a comment.
* The documented way to build a piece is to fork the monorepo. There is no
  standalone path, no tarball, no alternate name, no git-dependency recipe.
* They tightened the authoring surface at the same time: a piece imports only
  from `pieces-framework`, which now re-exports what pieces used to take from
  `shared` (`PieceCategory`, `isNil`, `SeekPage`, …). A `no-restricted-imports`
  rule enforces it and `npm run cli -- pieces migrate` rewrites old pieces.

**What shipped** (PR 1, [powerhouse#3031](https://github.com/powerhouse-inc/powerhouse/pull/3031)):

* `packages/pieces-framework/upstream/` holds the MIT source of
  `packages/pieces/framework`, `packages/pieces/common` (the `./common`
  subpath) and the two build-time-only core packages, 99 files, generated by
  `scripts/sync-upstream.mts` and never hand-edited. The script fetches a tag,
  codemods the tree to ESM (`.js` extensions, `node:` prefixes, workspace
  specifiers rewritten to relative paths, `import type` fixes through an
  ESLint pass), applies seven recorded patches that each must match or the
  sync fails, and writes a manifest with the original bytes' hashes. Running
  it twice yields no diff; a test asserts every value the emitted `.d.ts`
  claims is really exported at runtime.
* **License MIT, not AGPL.** `ph build` inlines this package into every piece
  an external developer publishes; AGPL here would infect their pieces.
  Upstream's notice is reproduced verbatim. Flagged in the PR for review.
* **Version in lockstep** (`6.2.3-dev.10`), not upstream's 0.39.0 as the
  second draft said. The release tooling runs a fixed relationship over
  `packages/*` and would overwrite an upstream-numbered version at the next
  publish. The upstream tag, commit and package versions are recorded under
  `package.json#upstream` and in `UPSTREAM.md`, which is where drift is read.
* **The widening lives in `src/powerhouse/`.** Upstream's `ActionContext` is a
  type alias, not an interface, so declaration merging is impossible; the
  widening is a wrapper type — `PowerhouseActionContext<Auth, Props> =
  ActionContext<Auth, Props> & { reactor: ReactorService }` — plus
  `reactorOf(ctx)`, which throws a legible error when a piece runs outside
  Powerhouse. `PackagePiece` lives here too.
* Runtime dependencies are exactly `form-data`, `nanoid` and `zod`; a dist
  test pins that set. `mime-db` still rides into every piece bundle through
  `form-data`; upstream aliases it to a minimal table in their bundler, and
  the equivalent belongs in `packages/shared/clis/build-config.mts` when
  someone next touches it.
* Publishing a piece to Activepieces is one specifier rewrite plus their
  `pieces create` scaffold and `build-piece`. Doc 08 §1.1's "unchanged" is
  now "one rewrite".

**What this costs the pieces we have.** `piece-docling` and `piece-paperless-ngx`
pin the frozen npm versions and import `@activepieces/shared` for
`PieceCategory`. Step 4 changes the specifier, drops the `shared` import in
favour of the framework's re-export, and rebuilds — the same migration upstream
ran on 750 pieces.

### 2.5 What an external piece author does

1. `ph init my-package`. Add one dependency, `@powerhousedao/pieces-framework`.
2. Write `pieces/my-piece/index.ts` with `createPiece`, `createAction`,
   `createTrigger` and `Property.*` from that package. `reactorOf(ctx)` gives
   the typed reactor. List it in `pieces/index.ts` as a `PackagePiece` whose
   `entry` is the built path, `dist/node/pieces/my-piece/index.mjs`, and in the
   manifest under `pieces`.
3. `ph build`. The pieces land under `dist/node/pieces/` with the framework
   inlined, and the `./pieces` export map already exists (`1b8730ae`).
4. Set `workflows.enabled: true` in `powerhouse.config.json` (§3.3) and start
   the reactor. The runtime finds the pieces through the manifest and serves
   `ctx.reactor`.

Optionally, add `@powerhousedao/reactor-workflow` as a devDependency and
import the tier-1 conformance harness from `./testing`, which is what this
repo's two pieces do. Nothing in the loop mentions `reactor-api`.

### 2.6 What this repo becomes

**Settled:** the pieces stay, and this repo becomes the library of first-party
pieces Powerhouse maintains.

What stays:

* `packages/piece-paperless-ngx`, `packages/piece-docling` — and whatever
  follows them.
* `demo/`, `demo-umh/` — the compose stacks and the graph tests, which need
  Docker and a factory simulator.
* `plan/20260908-*` — the piece design docs belong with the pieces.

What moved out: `plan/00`–`plan/10` and the briefing, now under
`packages/reactor-workflow/docs/plan/` in the monorepo, with the code.

**The dependency story.** After step 4 this repo consumes two Powerhouse
packages: `@powerhousedao/pieces-framework` as each piece's one dependency,
inlined at build so the published tarball declares nothing of ours, and
`@powerhousedao/reactor-workflow` as a **devDependency** for the conformance
harness and the demos' `runWorkflow`. Both are node-only; neither carries React.

**Four things the library needs that a workspace of three packages did not:**

1. **Publishing.** Neither piece is on npm today. A piece library needs
   per-piece versioning (the monorepo's lockstep is exactly wrong here) and a
   changelog. Upstream's rule is worth adopting verbatim: "any removal is
   breaking, any new required prop is breaking, everything else is PATCH."
2. **Scaffolding to share.** `tsconfig.json` and `vitest.config.ts` are
   byte-identical across the pieces. Once `ph build` inlines the framework, the
   per-piece `scripts/bundle.mjs` should disappear.
3. **A conformance suite.** Doc 08 §13's three tiers, applied to our own
   pieces through `@powerhousedao/reactor-workflow/testing`.
4. **A name.** `reactor-workflow` will contain no workflow code — see §6.

---

## 3. The engine in `reactor-api`

> **Since written (step 4, 17 September):** composition moved to switchboard —
> [powerhouse#3042](https://github.com/powerhouse-inc/powerhouse/issues/3042),
> merged as [#3045](https://github.com/powerhouse-inc/powerhouse/pull/3045). The
> flag, the host deps and the subgraph are as described; the place that composes
> them is not `reactor-api`'s `_setupAPI`.

### 3.1 What "as its own component" means concretely

`WorkflowRuntimeService` takes its dependencies in the constructor and nothing
else:

```ts
// @powerhousedao/reactor-workflow
type WorkflowRuntimeHostDeps = {
  relationalDb: IRelationalDb;      // "workflow_runtime" + secrets namespaces
  reactorClient: IReactorClient;    // seeding, document reads/writes
  assertCanRead: …;                 // the same signature BaseSubgraph has
  webhooks?: IWebhookScope;         // httpRoutes.scopeFor("@powerhousedao/workflow").webhooks
  attachments?: …;                  // createAttachmentClient(attachments.service)
  logger?: ILogger;
};
```

`reactor-api`'s `src/workflow/host.ts` builds those from what `_setupAPI`
already has in scope, imports the engine with a literal `import()`, and returns
`{ subgraph, start, stop }`. `_setupAPI` pushes the subgraph onto
`coreSubgraphs` when the flag is on, calls `start()` after the GraphQL manager
is up — which registers the webhook endpoint, registers **one** processor
factory under `@powerhousedao/workflow`, and starts the trigger supervisor —
and pushes `stop()` onto the existing `dbClosers` chain.

| Today | Tomorrow |
| --- | --- |
| `configure(subgraph)` reads `relationalDb`/`reactorClient` off a GraphQL object | Constructor arguments |
| `setAttachments(module.attachments)` from a processor factory | A constructor argument |
| `startTriggerSupervisor()` from the same factory, after `initAndUpgrade()` | `host.start()`, once |
| `shutdown()` from `processor.onDisconnect`, plus a `process.once("SIGTERM")` guarded by module state | `host.stop()`, from `dbClosers` |
| The `document-event-trigger` processor registered per drive with a module-level `live` guard | The same one-live-processor rule, as instance state of the factory the host registers |
| `getResolvers(subgraph)` configuring the singleton as a side effect | `getResolvers(runtime)` |

The processor does not vanish — an `IProcessor` is still how operations reach
`onOperations`, and doc 08 §7.2 always specified "a *single* `IProcessor` whose
filter is the union of all `core#document-event` filters". It stops being the
thing that *boots* the runtime.

**No data migration.** The store opens `relationalDb.createNamespace("workflow_runtime")`
against the reactor-wide relational database, not a per-drive processor
namespace. The same `IRelationalDb` is in scope in `_setupAPI`, so existing
tables, tokens and cursors are found unchanged.

### 3.2 The dependency cycle, and why there is not one

The second draft spent a section on inverting a cycle. There is no cycle to
invert once the subgraph lives in `reactor-api`: `reactor-api → reactor-workflow
→ workflow → {reactor-browser, shared, design-system, reactor, document-model,
pieces-framework}`, and nothing in that closure depends on `reactor-api`.
`check-circular-imports` confirms it over 1,269 modules.

Two tooling facts made this the only workable shape, and are worth keeping in
mind for anything built on top:

* **`update-ts-references` follows `peerDependencies` and `devDependencies`.**
  A package that names `reactor-api` anywhere in its manifest gets a project
  reference to it, and if `reactor-api` names it back — even as an optional
  peer — `tsc --build` refuses the cycle. This is why the engine may not have
  `reactor-api` as a devDependency for test helpers.
* **`dpdm` follows literal dynamic imports.** That is fine here because the
  arrow points down; it is why the second draft's `reactor-api ⇢ workflow`
  literal import would have been reported.

### 3.3 Enabling

`PowerhouseConfig` has a `workflows` block (`packages/shared/clis/types.ts`,
beside `vetra`, also in the source-config JSON schema):

```jsonc
"workflows": { "enabled": true }
```

`reactor-api` resolves the flag as: the host's `options.workflows.enabled`,
then `PH_WORKFLOWS_ENABLED` (`1`/`true`/`0`/`false`), then the config file,
then off. Default **off**: enabling forks child processes and opens outbound
sockets, which no switchboard should do because it happened to upgrade. The
`dev.ts` host passes no config file and gets the env behaviour.

When enabled, `reactor-api` does two literal imports of two declared
dependencies and nothing else:

| What | From | Goes to |
| --- | --- | --- |
| Document models | `@powerhousedao/workflow/document-models` | `PackageManager.loadDocumentModels`'s static-prereq block, next to `document-drive`, `document-model`, `reactor-drive` and `reactor-group`, under the key `@powerhousedao/workflow` |
| The runtime | `@powerhousedao/reactor-workflow` | `composeWorkflowRuntime(...)` in `_setupAPI` |
| The subgraph | `reactor-api`'s own `src/graphql/workflow/` | `coreSubgraphs.push(...)`, exactly as `AuthSubgraph` is pushed conditionally |

Both loaders are injectable so the tests can prove the negative: with the flag
off the loaders are never called, and the built `reactor-api` has no static
import of either package. A miss on either import fails the boot with the
package's name, on the precedent of `apps/switchboard/src/server.mts` refusing
to serve without the Renown read model. Switchboard needs no wiring at all —
that is the answer to "similar to how the vetra package is loaded", minus the
one-place-per-host duplication vetra has.

The egress allow-list stays on `WORKFLOW_EGRESS_ALLOW_ADDRESSES`; the rest of
doc 08 §12's block (`queue`, `workers`, `secrets`) is not consumed by anything
yet and was not added.

---

## 4. The sequence — what landed

> **Since written (step 4, 17 September):** the stack merged **squashed** on
> 2026-09-17, so §6 item 1's merge commits did not happen and the imported
> histories are not in the monorepo. Composition also moved to switchboard
> (powerhouse#3042, merged as #3045).

Four pull requests, stacked, each built by an agent pipeline and verified
adversarially before opening. The monorepo publishes `@powerhousedao/*` in
lockstep, so step 4 waits for the publish that follows the stack.

**0. Prepare.** The source snapshot is this repo's `main` at `fafc848` plus the
two unmerged fix branches, PR #29 (build pieces with `ph-cli`) and PR #30
(state matching, egress allow-list, model JSON), merged in a scratch clone; both
merged cleanly. Histories were cut from it with `git filter-repo` per
destination. The untracked `monorepo/packages/reactor-connectors/` leftovers
(cached bundles and a stray `node_modules`) were deleted. PR #31 (the UMH
piece) is independent of the migration and still open.

**1. `packages/pieces-framework`** — [powerhouse#3031](https://github.com/powerhouse-inc/powerhouse/pull/3031),
`feat/pieces-framework`, 8 commits, no history import (its provenance is the
sync manifest). Gates: build, 100 tests, lint, `tsc --build`, ts-references,
the `constructor.name === "Piece"` smoke, no `@activepieces/` specifier in the
emitted types, sync idempotency, frozen install.

**2. `packages/workflow` + the flag** — [powerhouse#3032](https://github.com/powerhouse-inc/powerhouse/pull/3032),
`feat/workflow-package` on top of 1. **Merge with a merge commit, not squash:**
it carries the 76-commit history of `packages/workflow` minus `subgraphs/`,
`processors/` and the reactor piece's runtime test, then nine commits of
adaptation: scaffold removal, the `ph build` shape, the framework swap, ESLint
and TypeScript 6, the `reactor-api` flag with `PackageManager` loading, the
workspace wiring, and two fixes from verification — the exported stylesheet
had dropped react-flow's CSS, and a log line rendered `null/workflow`. Test
counts matched the baseline exactly (editors 16/111, models 14/46, ai 3/19,
pieces 1/9); `reactor-api`'s full suite of 1,079 tests passes.

**3. `packages/reactor-workflow` + the seam** — [powerhouse#3035](https://github.com/powerhouse-inc/powerhouse/pull/3035),
`feat/reactor-workflow` on top of 2. Merge commit again: the 85-commit history
of the runtime, the loader and their tests, imported at their final paths —
`packages/reactor-workflow/src/{reactor,pieces}` and `test/pieces`, and for the
subgraph and the webhook integration suites `packages/reactor-api/src/graphql/workflow/`
and `packages/reactor-api/test/workflow/`. Then nine commits in two phases: land
the engine standalone with zero `reactor-api` imports, a local PGlite test
helper, the `Piece*` renames, the lint boundaries, the CI bundle cache and the
design documents; then invert the singleton into `WorkflowRuntimeHostDeps`, add
`composeWorkflowRuntime` and the conditional core subgraph in `reactor-api`,
move the processor factory into the host, and rebuild the integration harness
on the public constructor. Gates: 558 engine tests, the full `reactor-api`
suite of 1,138 including a boot test that shows the `workflowRuntime` GraphQL
field present with the flag on and absent with it off, root typecheck, `dpdm`
over 1,269 modules, one dynamic and zero static references to the engine in
`reactor-api`'s dist, and a 49-line additions-only lockfile diff.

**3b. The engine reuses the framework** — [powerhouse#3036](https://github.com/powerhouse-inc/powerhouse/pull/3036),
`feat/reactor-workflow-reuse` on top of 3. A review of the duck-typed piece
layer against the vendored framework found that most of it is genuinely ours —
upstream's engine, sandbox and API client were never vendored — but that its
type declarations were hand-flattened copies of `ActionBase`, `TriggerBase`,
`PieceBase` and the context types, and that comparing against the real
contract exposed three gaps: no `run.createWaitpoint`/`waitForWaitpoint`
stubs, `setSchedule({ intervalMs })` accepted and never armed, and a
check-connection context built for a hook that does not exist (auth validation
is `PieceAuth.validate({ auth, server })`). The PR adds a `./host` subpath to
the framework — upstream's property processors and `dynamicPropKeys` vendored
from `packages/server/engine` (MIT), plus `ssrfIpClassifier` and
`formatPieceError` from `core-utils` — carves `@powerhousedao/pieces-framework`
out of the `src/pieces` boundary, derives every `Ap*` type from the framework,
imports `PackagePiece`, `ReactorService` and `DEDUPE_KEY_PROPERTY` instead of
duplicating them, fixes the three gaps, coerces values with upstream's
processors (seven test expectations moved to upstream semantics, listed in the
commit), classifies egress with the framework's table (our stricter `::/96`
rule kept in front), and formats piece errors before redaction. `"NONE"` stays
at the persistence boundary because it is an enum value in the connection
document model. Gates as for 3, plus the framework's sync idempotency.

**4. This repo, as the piece library.** Blocked on the publish that includes
1–3. Delete `packages/workflow` and `packages/reactor-connectors`; repoint the
two pieces at `@powerhousedao/pieces-framework`, dropping `@activepieces/shared`;
repoint the conformance tests and the demos at
`@powerhousedao/reactor-workflow/testing`; rewrite the README; move `plan/00`–`10`
out (they are in the monorepo now). Then §2.6's four items.

### History

`git filter-repo` a subdirectory-scoped clone per destination and merge with
`--allow-unrelated-histories`. 58,000 lines of dense, comment-heavy code is
exactly the kind that gets read via `git blame`, and the comments routinely
name the bug they exist to prevent. The reactor piece's runtime test rode with
the engine rather than the browser half, because it drives the executor; the
subgraph's three files and the webhook harness rode straight to their
`reactor-api` paths. The vendored framework got no history import.

One wrinkle, and it is benign: the monorepo still has branch
`feat/reactor-connectors` carrying rewritten ancestors of this repo's first
nine commits. It was never merged, so the imports introduce no duplicates.
Delete that branch when 3 lands.

---

## 5. Cross-cutting adaptations — what they turned out to cost

| | `reactor-workflow` | monorepo | What happened |
| --- | --- | --- | --- |
| Linter | `oxlint` 1.70 + `oxfmt` | `eslint` + prettier | One `eslint --fix` pass per package plus hand fixes. The workflow editors needed 12 `react-hooks/set-state-in-effect` and `react-hooks/refs` disables with reasons, the same pattern vetra's editors use. The vendored framework is ignored by the root config; the sync script runs its own ESLint pass |
| TypeScript | 5.9.3 | catalog `6.0.3` | Two upstream patches in the framework (`Buffer` is no longer a `BodyInit`; a `@ts-expect-error` moved by prettier). Nothing structural |
| Build | `ph-cli build` / `tsdown` / esbuild per piece | `tsdown` | `workflow` builds with a `build.ts` over the shared browser/node configs (§2.2); the engine with a three-entry `tsdown` config whose `worker-entry` matches what `defaultEntryPath()` walks to |
| Lockfile | — | `pnpm install --frozen-lockfile` only | **Any resolver run under pnpm 11.5 rewrites ~1,100 lines of the viem/wagmi peer-suffix graph** (real changes, e.g. `zod@4.3.6 → 3.25.76` for viem). New dependencies were resolved in a throwaway project and merged by hand, then validated with a forced real frozen install and a byte-identical `.pnpm/lock.yaml`. Additions only, every time |
| Hooks | — | husky: lint-staged + commitlint | `lint-staged` would have run `eslint --fix` over 219 imported files inside the history merge, so PR 2's first seven commits ran with `HUSKY=0` and the equivalent checks explicitly. Every message passes `commitlint` |
| Vitest | resolves dist | `source` condition | `server.deps.inline: true` in `workflow`, because the `source` condition also selects third-party packages' TypeScript sources, which Node refuses under `node_modules` |
| CI | `ap-bundles` cache in `ci.yml` | `check-commit.yml` | The cache step moves with the engine tests, keyed on the test files that name bundle versions |

Plus the monorepo-only chores each new package needs: an entry in the root
`build` **and** `test:ci` filter lists, `pnpm install` for the reference churn,
`dpdm`, conventional commits under commitlint, and nothing for the release —
`packages/*` joins automatically.

---

## 6. Decisions that still need a human

1. **Merge strategy for 2 and 3.** They must merge with merge commits or the
   imported history is squashed away. Repository settings allow all three
   strategies; a reviewer has to pick the right one.
2. **The framework's licence.** MIT for `pieces-framework` (§2.4) is the only
   choice that does not infect external pieces, but it is a departure from the
   workspace's AGPL and someone should confirm it.
3. **What is this repo called?** It will contain no workflow code.
   `powerhouse-pieces` and `pieces` are the obvious candidates. Do it in step 4
   or never.
4. **Should the piece build alias `@activepieces/pieces-framework` to the
   vendored copy?** It would restore doc 08's "unchanged" for upstream
   publishing at the cost of two names for one thing. Recommend no.
5. **Which upstream tag to vendor next, and who watches.** 0.91.0 is
   current. A monthly sync that opens a PR is probably right.
6. **Is doc 08's `workflow-run` document model in scope?** Specified, not
   built. If not, say so in doc 08 rather than carrying the specification
   across.

Closed by this revision and recorded so nobody reopens them by accident: the
demos stay (they import from `./testing`); there are **three** packages, with
the engine standing alone because it never needed `reactor-api`; the
framework is versioned in lockstep, not to upstream.

---

## Landmines

**The two repos deadlock if you bump in the wrong order.** Doc 10 §8.4 records
the rule: merge the monorepo side, publish, bump, merge the other side. Three
packages must be out before step 4.

**`ph update` produces unresolvable dependency sets.** It takes the highest
version per package, which mixes dev.8 and dev.9. Pin by hand until step 4,
after which this repo pins two packages and the problem shrinks to them.

**The package-local typecheck is not the gate; `tsc --build` at the root is.**
Doc 10 §8.6. In a fresh worktree the root typecheck also reports `TS2307` in
`test/test-fusion` until the workspace `dist` directories exist — build first,
then typecheck, as CI does.

**Never let pnpm re-resolve the lockfile.** §5. The symptom is a thousand-line
diff in packages you did not touch; the fix is to revert and merge entries by
hand from a throwaway resolution.

**`update-ts-references` follows peers and devDependencies.** §3.2. A test
helper import from `reactor-api` inside the engine is a build-breaking cycle,
not a convenience.

**The piece manifest is regenerated behind your back.** `pnpm build` rewrites
`dist/node/pieces/index.mjs` from the tracked barrel. In this repo that
silently dropped the demo's unpublished pieces and *no trigger registered at
all*, with no error anywhere.

**The piece worker entry is resolved by walking up from its own module URL**
to the nearest `package.json`, then `dist/worker-entry.js`. Inside
`@powerhousedao/reactor-workflow` that is the package's own root, and the
`tsdown` config emits exactly that file. Anything that bundles the engine into
a consumer breaks piece execution with an error that points at a missing
build.

**Webhook tokens live in the reactor's database, not the workflow's.** The
namespace is the package name the scope was created for, stored as a column
value. The host creates it as `@powerhousedao/workflow` — the same name the
integration harness always used — and it must not drift.

**`ISubgraph.path` is still a hole** (doc 10, deferred to powerhouse#2972), and
the workflow subgraph is the only consumer of `IHttpScope` in existence. It is
an in-tree consumer now, which is the moment to close it.

**The vendored framework is a fork the moment it is patched.** Every local
change to `packages/pieces-framework/upstream/` that is not one of the sync
script's recorded patches makes the next sync a merge. Keep Powerhouse code in
`src/powerhouse/`, keep patches in the script, and let the script overwrite
everything else.
