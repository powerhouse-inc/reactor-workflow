# Reactor Workflow — Powerhouse's first-party pieces

A **piece** is one integration a workflow can call: a set of actions and
triggers against a real service, with its own authentication. This repository
holds the pieces Powerhouse maintains itself, each packaged so a reactor finds
it by installing the package.

| Piece | Package | Target service |
| --- | --- | --- |
| Paperless-ngx | [`packages/piece-paperless-ngx`](packages/piece-paperless-ngx/README.md) | paperless-ngx 2.18.x (self-hosted) |
| Docling | [`packages/piece-docling`](packages/piece-docling/README.md) | docling-serve v1.32.0 (self-hosted or watsonx) |

Each README documents the exact service API line the piece was verified
against, the version pins, and the API oddities that shape the implementation.

[`demo/`](demo/README.md) runs both against real services: upload a document
to paperless, and a workflow fetches the file and converts it to Markdown
with docling.

## Where the engine went

The workflow engine, the document models and the editors used to live here.
They were merged into the [powerhouse
monorepo](https://github.com/powerhouse-inc/powerhouse) on 17 September 2026
and publish from there:

| Package | What it is |
| --- | --- |
| `@powerhousedao/pieces-framework` | The piece contract — `createPiece`, `createAction`, `createTrigger`, `Property`, `PieceAuth`, and `reactorOf(ctx)` for the reactor handle. Powerhouse's vendored copy of Activepieces' MIT framework, widened with the reactor context. |
| `@powerhousedao/reactor-workflow` | The engine: the trigger supervisor, the run coordinator, the piece loader and the forked worker. Its `./testing` subpath is the conformance harness this repo's tests use. |
| `@powerhousedao/workflow` | What Connect loads: the `powerhouse/workflow` and `powerhouse/connection` document models, the workflow builder, Workflow Studio, and the `reactor` piece. |

The plan that moved them, with what each package contains and why, is
[`plan/20260915-monorepo-migration.md`](plan/20260915-monorepo-migration.md).
The design documents that preceded it (`00`–`10` and the briefing) moved with
the code and now live at `packages/reactor-workflow/docs/plan/` in the
monorepo; the piece design notes stayed here, in [`plan/`](plan/).

> **Open: what is this repository called?** It contains no workflow code any
> more. `powerhouse-pieces` and `pieces` are the obvious candidates, and a
> GitHub rename redirects old URLs but invalidates every clone's remote. §6
> item 3 of the migration plan leaves this to a human; nothing here depends on
> the answer.

## What a piece package looks like

A piece package is an ordinary Powerhouse **reactor package** whose only
module kind is `pieces`. Three things make it one:

```
packages/piece-docling/
  pieces/docling/index.ts      the piece: createPiece, its actions and triggers
  pieces/index.ts              the pieces this package ships, as PackagePiece[]
  powerhouse.manifest.json     "pieces": [{ id, name }]
  index.ts                     the package's root entry, re-exporting the above
```

The piece itself imports from the framework and nothing else:

```ts
import { createAction, Property } from "@powerhousedao/pieces-framework";
import { httpClient, HttpMethod } from "@powerhousedao/pieces-framework/common";
```

`pieces/index.ts` says where the build puts each piece, which is the path the
reactor's registry resolves:

```ts
import type { PackagePiece } from "@powerhousedao/pieces-framework";

export const pieces: PackagePiece[] = [
  {
    name: "@powerhousedao/piece-docling",
    version: "1.0.0",
    entry: "dist/node/pieces/docling/index.mjs",
  },
];
```

A piece that needs the reactor — to read or write documents — takes it from
the action context with `reactorOf(ctx)`, which throws a legible error when
the piece runs outside Powerhouse. Neither piece here does; they talk to
outside services only.

### Build

```sh
pnpm -F @powerhousedao/piece-docling build
```

`scripts/build-piece.mjs` is shared by every package: it runs tsdown over
`@powerhousedao/shared`'s build config — the same configuration `ph build`
uses — emitting `dist/node/pieces/<name>/index.mjs` with the framework
**inlined**, copies the manifest into `dist/`, writes types with `tsc`, and
fails if a piece the manifest declares did not come out of the build.

It is not `ph build` itself, and the script says why: `ph build` runs a
browser build and a Tailwind pass first, and a package that ships only pieces
has neither an entry for the one nor a stylesheet for the other.

Inlining is the point. The reactor loads a piece by absolute path in a forked
worker with no `node_modules` of its own, so the emitted module carries
everything it imports.

### Tests

```sh
pnpm -F @powerhousedao/piece-docling test
```

Three tiers, following the piece spec:

1. **Unit** — actions and triggers against an in-process mock of the service
   (`test/mock-*.ts`), covering the API contract, the error taxonomy and the
   output schemas.
2. **Conformance** (`test/conformance.test.ts`) — the acceptance gate. The
   built module has to load through the reactor's own duck-typed loader,
   describe into a piece descriptor, be found by `PieceRegistry` where a
   reactor looks for it, and execute inside the forked worker. Everything it
   imports comes from `@powerhousedao/reactor-workflow/testing`.
3. **Live e2e** — the real service in Docker, skipped unless its environment
   variable is set. Each piece README has the compose invocation.

`pnpm test` builds first, because the conformance gate reads what the build
emitted rather than the sources.

### Using a piece before it is published

Neither package is on npm yet. A reactor project picks one up from a checkout
of this repository:

```sh
pnpm -F @powerhousedao/piece-docling build
cd ../my-reactor-project
pnpm add link:../reactor-workflow/packages/piece-docling
```

`link:` and not `file:`, so a rebuild here is picked up there without
reinstalling. It writes a path relative to one checkout into that project's
lockfile, which is fine locally and must not be committed.

then names it in `powerhouse.config.json`:

```jsonc
{
  "packages": [{ "packageName": "@powerhousedao/piece-docling" }],
  "workflows": { "enabled": true }
}
```

The registry reads the installed package's `dist/node/pieces/index.mjs`, so
the package has to have been **built** — a linked but unbuilt package is
reported as declared-and-missing in the reactor's log and its blocks are
absent from the catalog.

## Adding a piece

1. Copy either package as the scaffold: `package.json`, `tsconfig.json`,
   `tsconfig.build.json`, `vitest.config.ts` and `.oxlintrc.json` are the
   same everywhere, and the build script is shared.
2. Write `pieces/<name>/index.ts` and list it in `pieces/index.ts` and in
   `powerhouse.manifest.json`. The manifest's `name` must equal the
   package's, or the build fails: Connect and the registry resolve an
   installed package by its manifest name.
3. Write the mock service first. Every unit test in both pieces runs against
   one, which is what keeps the suites offline and fast.
4. Keep `test/conformance.test.ts` — it is the only test that says the thing
   you publish loads and runs.

Versioning is per package: any removal is breaking, any new required prop is
breaking, everything else is a patch.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24 or newer | |
| pnpm | 11.5 | Pinned via `packageManager`; `corepack enable` picks it up. |
| Docker | any recent | Only for the live e2e suites and the demo. |

## Setup

```sh
git clone git@github.com:powerhouse-inc/reactor-workflow.git
cd reactor-workflow
pnpm install
pnpm build
pnpm test
```

`pnpm-workspace.yaml` disables the native build scripts of a few transitive
dependencies (`allowBuilds`) and excludes the Powerhouse scopes from pnpm's
minimum-release-age policy, so freshly published dev builds install without
manual approval. If `pnpm install` ever exits non-zero, read its last lines:
those two settings are the usual cause.

## Development

```sh
pnpm build   # every package: tsdown over the shared build config, then tsc
pnpm tsc     # typecheck every package, tests included
pnpm lint    # oxlint with type-aware rules
pnpm test    # build, then vitest in every package
```

CI (`.github/workflows/ci.yml`) runs exactly these after
`pnpm install --frozen-lockfile` on Node 24.

The two Powerhouse packages are pinned to an exact `dev` version in each
package's `package.json` — `@powerhousedao/pieces-framework` as a dependency,
`@powerhousedao/reactor-workflow` as a devDependency for the conformance
harness. Bump them together: they publish in lockstep, and a mixed pair is
usually unresolvable.

## Troubleshooting

- **`pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS` or a release-age
  violation** — see the notes under Setup; `pnpm-workspace.yaml` is the place
  to fix it.
- **The conformance suite is skipped** — the package has not been built. Run
  `pnpm build` in it, or `pnpm test`, which builds first.
- **A reactor does not offer a piece's blocks** — the package is installed but
  not built, or `powerhouse.config.json` does not name it. The reactor logs
  the piece as declared and not built at the path it looked in.
- **A piece run fails on egress** — the engine denies private address space
  unless `WORKFLOW_EGRESS_ALLOW_ADDRESSES` lists it, which is what a local
  service on loopback needs (`127.0.0.1/32,::1/128`).
