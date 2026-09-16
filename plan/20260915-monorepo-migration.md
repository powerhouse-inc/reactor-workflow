# Migrating `reactor-workflow` into the monorepo — handoff and plan

**Written:** 15 September 2026. **Audience:** whoever does the move.
**Companions:** [`03-implementation-plan.md`](./03-implementation-plan.md) for the
phase structure this replaces the tail of, [`08-workflow-automation-spec.md`](./08-workflow-automation-spec.md)
§7.1 and §12 for where the runtime was always meant to live, and
[`10-http-routes-spec.md`](./10-http-routes-spec.md) §8.4 for the release ordering
that already bit us once.

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

**Two decisions are fixed going in**, both from the person who asked for this:

1. The workflow engine moves into `reactor-api` and is composed there **as its
   own component**, not bootstrapped by a processor factory.
2. **Enabling it loads the workflow document models and subgraphs
   automatically**, the way `@powerhousedao/vetra` is loaded today.
3. **The pieces stay here.** `piece-paperless-ngx` and `piece-docling` do not
   move; this repo becomes the library of first-party pieces Powerhouse
   maintains — §2.4.

Everything else below is a recommendation with its reasoning attached.

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

### How the engine boots today, and why that has to change

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
looking at" to survive hot reload.

---

## 2. Where it goes

### 2.1 Naming — what the plans said, and what shipped

The specs were written before the implementation found its shape. Both
vocabularies are in the code and the docs, so fix the mapping once, here.

| Doc 03/08 name | What actually exists | Decision |
| --- | --- | --- |
| `connector` module kind, `connectors/` dir, manifest key `connectors` | **`pieces`** — landed in the monorepo on 14–15 September (`46c64869`, `1b8730ae`): `ManifestSchema.pieces`, `MODULE_KEYS`, the node build entry, the export map | **Keep `pieces`.** The plan's `connector` was our own contract; we adopted theirs instead (doc 08 §4.1), and the name should say so |
| `@powerhousedao/reactor-workflow` (Node runtime) | `packages/workflow/subgraphs/workflow-runtime/` | Becomes the package. Name unchanged |
| `@powerhousedao/shared/workflow` | Nothing — types are split between `reactor-connectors` and the subgraph | Create it. It is what lets `reactor-api` type the runtime without depending on it (§3.2) |
| `@powerhousedao/workflow-compat` (doc 08 §7.1, never elaborated) | Nothing by that name. The compat layer is `reactor-connectors/src/activepieces/` | **Drop the name.** The compat layer ships inside `reactor-connectors` — §2.3 |
| `packages/workflow-models` (doc 04 Q1, option A) | `packages/workflow/document-models/` | **Do not create it.** The models stay beside the editors — §2.2 |
| `packages/reactor-workflow/src/subgraph/` (doc 03 §6.1) | `subgraphs/workflow-runtime/{schema,resolvers}.ts` | Keep the name `workflow-runtime`; it is on live registrations |
| — (no plan proposed it) | `@powerhousedao/reactor-connectors` | **Rename to `@powerhousedao/reactor-pieces`** — see below |

`@powerhousedao/reactor-connectors` is **not published** — `npm view` 404s — so
the name is free and the `6.2.2-dev.70` in its `package.json` is aspirational.
This is the only cheap moment to rename it, and it should be renamed:

* **The vocabulary lost.** The module kind shipped as `pieces`
  (`ManifestSchema.pieces`, `MODULE_KEYS`, the `./pieces` export subpath). A
  package called `connectors` keeps a dead word in the most visible place there
  is.
* **The collision doc 04 Q14 warned about is now real.** Q14 noted that
  `connector` "collides conceptually with 'connector' in the diagramming sense
  used in some Powerhouse UI code" and kept the name anyway. There is now a
  react-flow canvas in this very repo with an `ap-edge.tsx` in it, where a
  connector is the line between two nodes.
* **It describes the contents.** `src/activepieces/` is 4,699 lines against
  `src/engine/`'s 1,430 — 77% of the package is loading, describing and
  isolating pieces. It is also all the piece packages import from it
  (`buildDescriptor`, `loadPieceFromDir`).
* **`reactor-X` already means "the reactor's X subsystem"** in this monorepo —
  `reactor-drive`, `reactor-group`, `reactor-attachments`, `reactor-hypercore`
  are machinery, not collections. So `reactor-pieces` does not read as "a bundle
  of first-party pieces", which was the one real objection.

**Rename the six exported descriptor types with it** — `ConnectorDescriptor`,
`ConnectorPropDescriptor`, `ConnectorActionDescriptor`,
`ConnectorTriggerDescriptor`, `ConnectorAuthDescriptor`, `ConnectorSource` all
describe a piece. Mechanical, and touching 38 files across the repo.

**Do not rename `connectorId`.** It is a field on `powerhouse/connection`
(doc 08 §5.2), it is in every live connection document, and
`packageFromConnectorId` parses it. Renaming a persisted field is a schema
migration, not a rename, and it is not in scope here.

### 2.2 Target packages

Three new packages plus one subpath of an existing one, chosen so that every
dependency edge is one a reader would predict:

```
@powerhousedao/shared/workflow      types, zod schemas, IWorkflowRuntimeHost    (subpath, leaf)
        ▲
@powerhousedao/reactor-pieces       piece loading, worker pool, executor, expressions (node)
        ▲
@powerhousedao/reactor-workflow     supervisor · coordinator · stores · subgraph (node)
        │   └─▶ @powerhousedao/workflow/document-models   (subpath import)
        ▲
@powerhousedao/reactor-api          composes it behind a flag (dynamic import)

@powerhousedao/workflow             document models · editors · AI tools ·
                                    the reactor piece · manifest
        └─▶ reactor-browser, document-model
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

Q1 listed three homes for the models — their own package, `packages/vetra`, or
the Node runtime — and the implementation chose a fourth it did not consider:
beside the editors, in the package Connect loads. That is the right answer and
this plan keeps it.

**What the engine actually needs from them** is narrow: one runtime value,
`actions as connectionActions` (`service.ts:39`), and four types. So the edge is
real but thin, and if the dependency ever becomes a problem the fix is to move
those action creators rather than to move the models.

**Why the editors stay separate from the engine.** They already are:
`editors/workflow-editor/ui/forms.ts:2` and `expression-tokens.ts:2` both
copy a shape out of `reactor-connectors` rather than import it, with a comment
saying why ("node-only pkg"). That discipline is what makes this split free.

### 2.3 Why two engine packages, when the plans proposed one

**What the plans proposed.** Collected, because it is scattered across four
documents:

| Proposed | Where | Contents |
| --- | --- | --- |
| `packages/shared/workflow/` | 02 §5.1, 03 §1.1, 08 §7.1 | `types.ts`, `constants.ts`, `schemas.ts`, later `validate.ts` and `relational/` — browser-safe, mirroring `shared/processors` |
| `packages/workflow-models/` | 03 §2.1, 04 Q1 | the two document models, "or fold into `packages/vetra`" |
| `packages/reactor-workflow/` | 02 §7.1, 03 §3, 08 §7.1 | **everything else**: `runtime.ts`, `registry/core-blocks/`, `engine/{run-coordinator,step-runner,expressions,errors,context}`, `queue/`, `store/`, `journal/`, `observability/`, later `src/subgraph/`, `src/worker/protocol.ts`, `src/agent/` |
| `@powerhousedao/workflow-compat` | 08 §7.1 only, one clause, never elaborated | "compat packages" — presumably the Activepieces adapter |

So: **one runtime package**, with the compat layer maybe beside it. Nothing in
any plan proposed `reactor-connectors`; that name came from the Phase-0 spike
(doc 09 `09-spike-activepieces-loader.md`) and the package grew around it.

**What exists instead.** The code drew a different line, and it drew it
somewhere the plans never looked:

| `@powerhousedao/reactor-pieces` — today `reactor-connectors` (6,131 lines) | `subgraphs/workflow-runtime/` (16,565 lines) |
| --- | --- |
| `engine/` — coordinator, block executor, expressions, connection shaping, the secrets *interface* | supervisor, trigger drivers, schedule, webhook binding |
| `activepieces/` — loader, resolver, descriptor, the six context channels, the worker pool and its protocol | the run store, the encrypted secret store, the piece registry, the GraphQL subgraph |
| **Zero runtime dependencies. Zero `@powerhousedao` imports.** Verified: its `package.json` has no `dependencies` and no `peerDependencies` key at all, and `grep -rn "@powerhousedao" src/` returns nothing | Every line of it is about a reactor: document models, `IRelationalDb`, `IReactorClient`, `BaseSubgraph`, `IWebhookScope` |

The boundary is **"does this know the reactor exists"**, and it is load-bearing
in three ways:

* Its 266 tests run with no reactor, no database and no GraphQL. That is why
  they are fast and why they are the suite people actually run.
* Zero dependencies is a property that can only be preserved by a package
  boundary. Merged, the first `import type { PHDocument }` would go unnoticed.
* **It is what the pieces consume.** `piece-paperless-ngx`, `piece-docling` and
  `demo-umh` all depend on it, and under §2.4 they stay in this repo and take
  it from npm. Merging means a piece author installs the reactor runtime to get
  piece types.

**Recommendation: keep both, rename the lower one** (§2.1). The plans' single
package was written before there was a piece ecosystem to serve; the split has
since earned itself. The alternative — merge into
`@powerhousedao/reactor-workflow` as proposed, with `/engine` and `/pieces`
subpaths — costs one publish unit less but makes every piece author depend on
`reactor-api` transitively, and nothing in this migration is a good moment to
find out what that breaks.

**The one thing the name still over-claims**, and what to do about it. The
`engine/` half — coordinator, block executor, expressions — is not about pieces,
so `reactor-pieces` is a 77% match rather than a 100% one. The clean version is
to move `engine/` up into `reactor-workflow` and leave `reactor-pieces` as
exactly what it says: load, describe and execute a piece in an isolated worker.
That is mechanically possible today — the dependency runs **one way**,
`engine/` → `activepieces/`, and `grep -rn "from \"../engine" activepieces/`
returns nothing.

It is not proposed here for one concrete reason: `demo-umh/test` imports
`CompositeBlockExecutor` and `runWorkflow` — both from `engine/` — to run its
graphs through the real coordinator with the piece blocks faked, and under §2.4
the demos stay in this repo. Moving `engine/` up puts those two symbols behind a
package that depends on `reactor-api`, which is the piece-author problem again,
one layer higher.

Now that the pieces staying is settled, this is no longer a "revisit later": it
is blocked on the demos specifically, and they are the only thing blocking it.
If the graph tests ever move to the monorepo — they test workflow routing, not
pieces, so there is a case — the split becomes free. Until then the seam stays
clean as long as nobody adds an `activepieces/` → `engine/` import.

### 2.4 What this repo becomes

**Settled:** the pieces stay, and this repo becomes the library of first-party
pieces Powerhouse maintains. So this is not a leftovers list — it is the other
half of the split, and it has its own work.

What stays:

* `packages/piece-paperless-ngx`, `packages/piece-docling` — and whatever
  follows them. Integrations, not framework; they have no business on a release
  train that is the reactor's.
* `demo/`, `demo-umh/` — the compose stacks and the graph tests, which need
  Docker and a factory simulator.
* `plan/20260908-*` — the piece design docs belong with the pieces.

What moves out: `plan/00`–`plan/10`, which describe framework work, alongside
the code in step 4.

**The dependency story gets very simple.** After the move this repo consumes
exactly one Powerhouse package — `@powerhousedao/reactor-pieces`, as a
**devDependency** (verified: it is the only `@powerhousedao/*` entry in all
three piece manifests). A published piece's runtime dependencies are
`@activepieces/pieces-framework` and `@activepieces/shared`, nothing of ours.
That is as loose a coupling as a downstream repo can have, and it is what makes
this split worth doing rather than merely tidy.

**Four things the library needs that a workspace of three packages did not.**
None is hard; all are invisible until the repo is the product:

1. **Publishing.** Neither piece is on npm today — `npm view` 404s for both.
   The repo has a `publish:bundle` script per package and no release process
   above it. A piece library needs per-piece versioning (the monorepo's
   lockstep is exactly wrong here) and a changelog; `piece-docling` already has
   a `CHANGELOG.md` and the other two do not.
2. **Scaffolding to share.** `tsconfig.json` and `vitest.config.ts` are already
   byte-identical across all three pieces, and `scripts/bundle.mjs` differs by
   86 lines that probably should not differ. A `create-piece` template, or at
   minimum a shared base config, stops the fourth piece from being a fourth
   copy.
3. **A conformance suite.** Doc 08 §13 specifies three tiers — descriptor,
   dry-execution, live — for the 728-piece upstream corpus. The same harness
   applied to our own pieces is what "maintained" means: a piece that stops
   loading under a new `reactor-pieces` should fail here, not in a demo.
4. **A name.** `reactor-workflow` will contain no workflow code. Renaming a
   GitHub repo is cheap and redirects, but it is the user's call — see §6.

---

## 3. The engine in `reactor-api`

This is the part the instruction is about. It is also the part with a real
architectural obstacle, so take it in order.

### 3.1 What "as its own component" means concretely

A `WorkflowRuntimeHost` constructed once in `_setupAPI`, alongside
`ProcessorManager`, given exactly what it needs and nothing more:

```ts
// packages/reactor-api/src/workflow/host.ts  (new, ~150 lines)
const workflows = await createWorkflowRuntimeHost({
  enabled,                                   // §3.3
  reactorClient,                             // seeding, document reads/writes
  relationalDb,                              // "workflow_runtime" + secrets namespaces
  attachments: createAttachmentClient(attachments.service),
  webhooks: httpRoutes.hostScope("@powerhousedao/reactor-workflow", …),
  processorManager: reactorProcessorManager, // for the document-event feed
  logger,
});
dbClosers.push(() => workflows.stop());
```

Five things the processor factory does today move here, and each one gets
simpler for it:

| Today | Tomorrow |
| --- | --- |
| `configure(subgraph)` reads `relationalDb`/`reactorClient` off a GraphQL object | Both are constructor arguments |
| `setAttachments(module.attachments)` from a processor factory | A constructor argument |
| `startTriggerSupervisor()` from the same factory, after `initAndUpgrade()` | `host.start()`, once, after migrations |
| `shutdown()` from `processor.onDisconnect` | `host.stop()`, from the existing `dbClosers` chain |
| The `document-event-trigger` processor registered per drive with a singleton guard (`live` in `factory.ts:13`) | The host registers **one** factory through `reactorProcessorManager.registerFactory(...)` — the same call `_setupAPI` already makes for `options.processors` (`server.ts:1139`). The singleton guard disappears with the per-drive call |

The processor does not vanish — an `IProcessor` is still how operations reach
`onOperations`, and doc 08 §7.2 always specified "a *single* `IProcessor` whose
filter is the union of all `core#document-event` filters". It stops being the
thing that *boots* the runtime.

The subgraph correspondingly stops owning anything: it takes the runtime as a
constructor argument and exposes it over GraphQL. `onSetup`'s webhook
registration moves to the host, which removes the seeding-versus-registration
race that doc 10 §8.2 describes.

**No data migration.** The store opens `relationalDb.createNamespace("workflow_runtime")`
(`store.ts:558`) against the reactor-wide relational database, not a per-drive
processor namespace. The same `IRelationalDb` is in scope in `_setupAPI`, so
existing tables, tokens and cursors are found unchanged.

### 3.2 The dependency cycle, and how to not have one

`reactor-workflow`'s subgraph extends `BaseSubgraph`, which lives in
`reactor-api`. If `reactor-api` also depends on `reactor-workflow`, that is a
cycle — and the monorepo enforces against it twice, with `check-ts-references`
(`tsc --build` project references) and `dpdm` (`pnpm check-circular-imports`).
There is no precedent to copy: **no package `reactor-api` depends on extends
`BaseSubgraph`**, and `packages/vetra/subgraphs/index.ts` is empty. Vetra
avoids the question by being imported from `apps/switchboard`, which sits above
`reactor-api`, not beside it.

Three ways out. Take the third.

* **(a) Compose in the host instead** — `apps/switchboard/src/server.mts`, as
  doc 08 §7.1 and doc 04 Q16 both recommend. No cycle, and it is what vetra
  does. Rejected because it was ruled out explicitly, and because it means
  every other host (`ph reactor`, `ph vetra`, `ph service`, connect's node
  side) needs the same wiring pasted in. Vetra's is duplicated in exactly one
  place and has already drifted.
* **(b) Put the engine inside `packages/reactor-api/src/workflow/`.** No cycle,
  no new package. Rejected: 23,000 lines and a child-process worker pool land
  inside the package every host imports, and doc 08's "a Switchboard with the
  runtime disabled carries none of its dependencies" becomes unmeetable.
* **(c) Invert through `@powerhousedao/shared/workflow`.** `reactor-api`
  declares `IWorkflowRuntimeHost` in `shared` (a leaf both sides already
  depend on), types a **dynamic `import()`** against it, and never names the
  concrete package in its own `package.json` except as an optional peer.
  `reactor-workflow` depends on `reactor-api` normally, for `BaseSubgraph`.
  The build graph has one edge, pointing the way it always did.

  This is the same shape as `apps/switchboard/src/server.mts:752` —
  `dev ? (await import("@powerhousedao/vetra/processors")).processorFactory : undefined`
  — with the flag moved down a layer and the type made explicit.

### 3.3 Enabling

Add a `workflows` block to `PowerhouseConfig`
(`packages/shared/clis/types.ts:293`), beside the `vetra` block that is already
there, shaped as doc 08 §12 specifies:

```jsonc
"workflows": {
  "enabled": true,
  "queue":   { "driver": "embedded" },
  "workers": { "count": 2 },
  "egress":  { "allowAddresses": ["127.0.0.1/32"] },  // today: WORKFLOW_EGRESS_ALLOW_ADDRESSES
  "secrets": { "provider": "local-encrypted" }
}
```

with `PH_WORKFLOWS_ENABLED` as the env override, matching how every other
reactor feature is flagged. Default **off**: enabling forks child processes and
opens outbound sockets, which no switchboard should do because it happened to
upgrade.

When enabled, `reactor-api` does three dynamic imports and nothing else:

| What | From | Goes to |
| --- | --- | --- |
| Document models | `@powerhousedao/workflow/document-models` | `PackageManager.loadDocumentModels`'s static-prereq block (`package-manager.ts:168–183`), next to `document-drive`, `document-model`, `reactor-drive` and `reactor-group` |
| The subgraph | `@powerhousedao/reactor-workflow/subgraphs` | `coreSubgraphs.push(...)` at `server.ts:1195`, exactly as `AuthSubgraph` is pushed conditionally at `:1199` |
| The runtime | `@powerhousedao/reactor-workflow` | `createWorkflowRuntimeHost(...)` in `_setupAPI` |

That is the answer to "similar to how the vetra package is loaded", and it is
strictly better than vetra's: one place instead of one-place-per-host, a named
config block instead of `dev`, and the document models arriving through the
prereq path that already exists rather than being concatenated into
`documentModels` by each caller (`server.mts:567`).

A miss on any of the three imports must fail the boot loudly with the package
name. "Workflows are enabled but the runtime is not installed" is a deployment
mistake, and the precedent for shouting about it is right there at
`server.mts:831` for the renown read model.

---

## 4. The sequence

Five pull requests. The ordering constraint is that the monorepo publishes
`@powerhousedao/*` in lockstep, so anything the pieces repo still consumes must
be published before the pieces repo is repointed at it.

**0. Prepare `reactor-workflow`.** Land the open PRs (#30 carries three core
fixes; #31 removes `packages/piece-umh` and is waiting on a
`umh-production-ledger` release), get `main` green, and confirm no `link:` or
absolute-path overrides survive in any manifest or the lockfile — that mistake
has been made once already (doc 10 §8.4) and it fails `pnpm install` for
everyone else.

**1. `packages/reactor-pieces`.** The leaf, renamed on the way in (§2.1) —
package name, directory, the six `Connector*Descriptor` types, and every
importer. Nothing in the monorepo imports it yet, so this PR is pure addition:
move the source with history, wire it into
the root `build` and `test:ci` filter lists, `tsconfig` references, eslint, and
the release config. **Delete the untracked leftovers first** —
`monorepo/packages/reactor-connectors/` already exists in the working tree with
`dist/`, `.tsbuild/`, `node_modules/` and `spikes/` in it, from the original
spike. It is not tracked (`git ls-files` is empty) and it will collide.
Publish. *Gate: root `tsc --build`, `pnpm lint`, 266 tests.*

**2. `packages/shared/workflow`.** Types, zod schemas, constants, and
`IWorkflowRuntimeHost`. Small, and it unblocks everything above it. Doc 03 §1.1
lists the intended contents; take what is real and leave the rest.

This PR also deletes a workaround worth naming: `store.ts:5–9` declares a
structural `NamespaceFactory` interface because *"the subgraph's `relationalDb`
types against shared source while this package resolves shared dist, so the
nominal types never match"*. Inside one workspace that stops being true.

**3. `packages/workflow`.** The reactor package Connect loads: the two document
models, the editors, the AI tools, the `reactor` piece and the manifest —
shaped like `packages/vetra`. Landing it before the engine means the
conditional static prereq in `package-manager.ts` can go in with it, so a
reactor with the flag on gains two document types and nothing that acts on
them: a clean, testable state.

**4. `packages/reactor-workflow` + the `reactor-api` seam.** The big one: the
engine, the subgraph, `WorkflowRuntimeHost`, the config block, and the deletion
of the processor-factory boot path. Everything in §3 happens here.

*Gate:* the 549 tests that live in `packages/workflow` today, minus the editor
suites, plus a new one that belongs to `reactor-api` — **boot with the flag
off and assert nothing workflow-shaped is loaded, imported or registered.**
Doc 08's "adds < 5 ms when disabled" is only honest if something checks it.

**5. This repo, as the piece library.** Delete what moved. Repoint the two
pieces and the demos at the published `@powerhousedao/reactor-pieces` — the one
Powerhouse dependency left, and a devDependency at that. Rewrite the README
around what the repo now is. Keep the `plan/20260908-*` piece design docs; the
rest went in step 4.

Then the four items §2.4 lists — publishing, shared scaffolding, a conformance
suite, a name. None of them blocks the migration, and none of them should be
allowed to drift far behind it: a library nobody can install is not a library.

### History

`git filter-repo` a subdirectory-scoped clone per package and merge with
`--allow-unrelated-histories`. 58,000 lines of dense, comment-heavy code is
exactly the kind that gets read via `git blame`, and the comments routinely
name the bug they exist to prevent — throwing that away costs more than the
merge does.

One wrinkle, and it is benign: the monorepo still has branch
`feat/reactor-connectors` carrying rewritten ancestors of this repo's first
nine commits (`2cb4264e8` here is `87d6378` there). It was never merged —
`git log origin/main -- packages/reactor-connectors` is empty — so a merge onto
`main` introduces no duplicates. Delete that branch when step 1 lands.

---

## 5. Cross-cutting adaptations

These are the things that are green here and will not be green there. None is
hard; all of them are surprises if met one at a time.

| | `reactor-workflow` | monorepo | Cost |
| --- | --- | --- | --- |
| Linter | `oxlint` 1.70 + `oxfmt` | `eslint` | Real. ~60k lines meet a different rule set; budget a commit per package for the mechanical half and read the rest |
| TypeScript | 5.9.3 | catalog `6.0.3` | Unknown until tried. Do it in step 1, on the smallest package |
| `@types/node` | ^24.9.2 | catalog `25.2.3` | Small |
| Build | `ph-cli build` (builder-tools) for `workflow`, `tsdown` for `reactor-pieces` | `tsdown` for `packages/vetra` | `packages/workflow` switches to tsdown; `packages/vetra/tsdown.config.ts` is the template, including the `neverBundle` note |
| Everything else | vitest 4.1.1, zod 4.3.6, react 19.2.6, graphql ^16, tsdown 0.21.1 | identical in the catalog | None — switch to `catalog:` |

Plus the monorepo-only chores each new package needs: an entry in the root
`build` **and** `test:ci` filter lists (both are hand-maintained lists of
`--filter` flags), `pnpm update-ts-references`, `knip`, `dpdm`, conventional
commits under commitlint, and the nx release config.

**CI has one genuinely new need.** `reactor-pieces`' tests fetch
Activepieces bundles from the network and cache them
(`.github/workflows/ci.yml` caches `node_modules/.cache/ap-bundles`, keyed on
the test files that name versions). Port that step, or those tests are slow and
flaky in the monorepo's CI rather than merely slow here.

---

## 6. Decisions that need a human

1. **Does `reactor-api` gain an optional peer dependency on the runtime, or
   does the runtime register itself?** §3.2(c) assumes the former. The
   alternative — a `registerWorkflowRuntime()` the host calls — pushes wiring
   back into hosts and re-opens Q16. Recommend (c); it is one line in
   `peerDependenciesMeta`.
2. **What is this repo called?** It will contain no workflow code. A GitHub
   rename is cheap and redirects old URLs, but it invalidates every clone's
   remote and every link in a doc that is not this one. `powerhouse-pieces` and
   `pieces` are the obvious candidates. Do it in step 5 or never — a rename
   mid-migration is the worst timing.
3. **Do the demos stay?** §2.4 says yes and §2.3 shows what it costs: while
   `demo-umh/test` imports `runWorkflow` from `engine/`, that half cannot move
   up into `reactor-workflow` where it belongs. The demos test workflow
   routing, not pieces, so there is a case for moving them with the engine.
4. **Do `reactor-pieces` and `reactor-workflow` stay two packages?** §2.3
   says keep both and gives the evidence. The merge the plans proposed is the
   live alternative and costs one publish unit less. Decide before step 1,
   because step 1 is the package.
5. **Is doc 08's `workflow-run` document model in scope?** It is specified
   (§5.3) and not built — the relational journal is authoritative and
   `journalAsDocument` has no consumer. If it is not being built, say so in doc
   08 rather than carrying the specification across.

---

## Landmines

**The two repos deadlock if you bump in the wrong order.** Doc 10 §8.4 records
the rule: merge the monorepo side, publish, bump, merge the other side. The
cost of getting it wrong is an absolute path under one developer's home
committed into a lockfile.

**`ph update` produces unresolvable dependency sets.** It takes the highest
version per package, which mixes dev.8 and dev.9 — and `reactor-browser@6.2.3-dev.9`
needs an `analytics-engine-browser@6.2.3-dev.9` that was never published. Pin
by hand. This problem is the single strongest argument for the migration, and
it disappears the moment these packages are `workspace:*`.

**The package-local typecheck is not the gate; `tsc --build` at the root is.**
Doc 10 §8.6: per-package `tsc` was green while the root build had seven errors,
one of which was a runtime bug that emptied every streamed response body. Run
`pnpm typecheck` at the monorepo root before believing any step.

**The piece manifest is regenerated behind your back.** `pnpm build` and the
workflow package's own test suite both rewrite `dist/pieces/index.mjs` from the
tracked manifest. In this repo that silently drops the demo's unpublished
pieces and *no trigger registers at all*, with no error anywhere. Whatever
shape the build takes in the monorepo, check this specifically.

**The piece worker entry is resolved by walking up from its own module URL**
(`transport.ts:50`) to the nearest `package.json`, then `dist/worker-entry.js`.
It is correct today — doc 10 §8.5 describes an older, broken version — but it
assumes `reactor-pieces` is installed as its own package on disk. Anything
in the monorepo build that bundles it into a consumer breaks piece execution
with an error that points at a missing build rather than a wrong path.

**Webhook tokens live in the reactor's database, not the workflow's.** The
workflow-local `webhook_endpoint` table was dropped without migration (doc 10
§8.3) because no provider had a URL registered at the time. That is no longer
true: the UMH demo has live registrations in paperless. Moving the composition
does not move the namespace — but *renaming* it would silently orphan every
registered URL.

**`ISubgraph.path` is still a hole** (doc 10, deferred to powerhouse#2972), and
the workflow subgraph is the only consumer of `IHttpScope` in existence. When
the engine lands in the monorepo it stops being a downstream consumer and
becomes an in-tree one, which is the moment to close it.
