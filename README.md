# Reactor Workflow

Powerhouse workflow automation: document models, runtime, editors and the
connector engine, extracted from the powerhouse monorepo
(`feat/reactor-connectors`, history preserved).

- `packages/workflow` — the reactor package: `powerhouse/workflow` and
  `powerhouse/connection` document models, the workflow-runtime subgraph and
  run journal, the document-event trigger processor, three editors (workflow
  builder, connection editor, Workflow Studio drive app) and the tools this
  package offers Connect's AI assistant.
- `packages/reactor-connectors` — the engine: Activepieces piece loading with
  worker isolation, block executor, expressions, connection auth shaping.

Design notes and specs live in [`plan/`](plan/), for example the
[workflow automation spec](plan/08-workflow-automation-spec.md) and the
[secrets service spec](plan/09-secrets-service-spec.md).

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 24 or newer | `@powerhousedao/ph-cli` refuses to run on older versions. |
| pnpm | 11.5 | Pinned via `packageManager`; `corepack enable` picks it up. |
| `ph` CLI | dev channel | `pnpm add -g ph-cmd@dev` — used for `ph vetra`, `ph update`, `ph generate`. |

The packages consume published `@powerhousedao/*` releases from the `dev`
dist-tag, pinned to an exact version in `packages/workflow/package.json`.

## Setup

```sh
git clone git@github.com:powerhouse-inc/reactor-workflow.git
cd reactor-workflow
pnpm install
pnpm build          # builds reactor-connectors, then the workflow package
pnpm test
```

`pnpm-workspace.yaml` disables the native build scripts of a few transitive
dependencies (`allowBuilds`) and excludes the Powerhouse scopes from pnpm's
minimum-release-age policy, so freshly published dev builds install without
manual approval. If `pnpm install` ever exits non-zero, read its last lines:
those two settings are the usual cause.

## Run it locally

Vetra is the local development environment: Vetra Studio (a local Connect)
plus a local switchboard that hosts the reactor, the workflow runtime and an
MCP server.

```sh
cd packages/workflow
ph vetra --strictPort --watch
```

| Service | URL | Configured in |
| --- | --- | --- |
| Connect (studio) | http://localhost:3000 | `powerhouse.config.json` → `studio.port` |
| Switchboard GraphQL | http://localhost:4001/graphql | `powerhouse.config.json` → `reactor.port` |
| Workflow runtime API | http://localhost:4001/graphql/workflow-runtime | subgraph of the switchboard |
| reactor-mcp | http://localhost:4001/mcp | `.mcp.json` |

`--strictPort` makes a port clash fail loudly instead of silently binding a
neighbouring port. To run next to another Vetra project, pass
`--connect-port` and `--switchboard-port`; Vetra then rewrites `.mcp.json` to
the new switchboard port. That edit is local, do not commit it.

Vetra creates two drives: `vetra-<hash>` for source documents (document
models, editors) and `preview-<hash>` for document instances such as
workflows. Its state lives in `packages/workflow/.ph/` (PGlite storage,
attachments, cached piece bundles, `vetra-runtime.json` describing the live
instance). Delete or move that folder for a clean slate.

`pnpm dev` at the repository root builds the connectors and starts Vetra in
one step.

### Firing and inspecting workflows without the UI

The workflow-runtime subgraph exposes, among others, `pieceCatalog`,
`pieceActions(packageName)`, `blockDescriptor(blockType)`, `runs`,
`triggerStates`, and the mutations `fire(workflowId, payload)`,
`testTrigger(workflowId)` and `rerun(runId)`:

```sh
curl -s http://localhost:4001/graphql/workflow-runtime \
  -H 'content-type: application/json' \
  -d '{"query":"{ workflowRuntime { health runs(limit: 5) { workflowName status error } } }"}'
```

Only workflows with status `ENABLED` register triggers and can be fired.

### Activepieces

There is no Activepieces server. The piece catalog and descriptors are read
from the Activepieces cloud API. Piece code is fetched on first use as the
pinned npm tarball into `.ph/ap-bundles/` and executed in worker processes
spawned by the connectors engine. First use of a piece therefore needs
network access; later runs work from the cache.

## First-party pieces

Two pieces are developed in this repo and published to npm for the
reactor's piece catalog (the same mechanism the cloud-sourced pieces use):

| Piece | Package | Target service |
| --- | --- | --- |
| Paperless-ngx | [`packages/piece-paperless-ngx`](packages/piece-paperless-ngx/README.md) | paperless-ngx 2.18.x (self-hosted) |
| Docling | [`packages/piece-docling`](packages/piece-docling/README.md) | docling-serve v1.32.0 (self-hosted or watsonx) |

Each package is a standalone Activepieces piece (its own npm tarball,
its own unit/e2e suites — `pnpm -F <package> test`), and each carries a
README documenting the exact service API line it was verified against,
including the version pins and the API oddities that shape the
implementation.

An end-to-end demo wires the two together — upload a document to
paperless, a workflow fetches the file and converts it to Markdown with
docling: see [`demo/README.md`](demo/README.md).

## Configuration

Environment variables read by the switchboard side:

| Variable | Purpose |
| --- | --- |
| `PH_SECRETS_MASTER_KEY` | 64 hex chars (32 bytes) encrypting managed secrets at rest. Without it a key file is generated for development. Set it in any shared or production deployment. |
| `PH_SECRETS_ALLOW_WRITE` | Must be `true` to create or rotate secrets when `NODE_ENV` is not `development`. |
| `WORKFLOW_POLL_INTERVAL_MS` | Development override for the default polling cadence of piece triggers; a 60 s floor still applies. |
| `WORKFLOW_EGRESS_ALLOW_ADDRESSES` | Comma-separated addresses or CIDRs piece code may reach inside private address space, e.g. `127.0.0.1/32,::1/128`. Unset, every private address is denied — including the loopback services a local demo connects to. A bare address means that one host. |

Connect-side flags live in `packages/workflow/powerhouse.config.json` under
`connect`. `connect.ai.assistantEnabled` turns on the in-browser AI assistant.

### AI assistant

With the flag on, Connect shows an "AI Assistant" tab under Settings and a
chat button bottom-right. Enter any OpenAI-compatible endpoint there (base
URL ending in `/v1`, optional API key, model id); the browser talks to the
endpoint directly, so it must allow the Connect origin via CORS. Settings are
stored in the browser, not on the server.

Besides Connect's built-in reactor tools, the assistant gets this package's
tools from `packages/workflow/ai/` (exported as `aiTools` from `index.ts`):
connector search and connection health, a piece's version-pinned block types,
block config props, the core blocks with the expression syntax, run history,
and firing manual workflows. Tool-calling support in the model is required.

### Coding agents

`packages/workflow/AGENTS.md` and `CLAUDE.md` are generated from the
`@powerhousedao/codegen` template and tell an agent how to work with the
reactor through reactor-mcp, including starting Vetra itself. `.mcp.json` at
the root and in the package point at the local MCP server. After a Powerhouse
version bump, re-sync those files from the new codegen template.

## Development

```sh
pnpm build   # connectors (tsdown) then ph-cli build
pnpm tsc     # typecheck every package
pnpm lint    # oxlint with type-aware rules
pnpm test    # vitest in every package
```

CI (`.github/workflows/ci.yml`) runs exactly these four after
`pnpm install --frozen-lockfile` on Node 24.

- Document models are edited in Connect and regenerated with `pnpm generate`
  inside `packages/workflow` (`ph-cli generate`); never edit `gen/` folders
  by hand.
- `packages/workflow/ai/workflow-tools.live.test.ts` runs the assistant tools
  against a running runtime when `WORKFLOW_RUNTIME_URL` is set, e.g.
  `WORKFLOW_RUNTIME_URL=http://localhost:4001/graphql/workflow-runtime pnpm vitest run ai/workflow-tools.live.test.ts`.
- Format with `pnpm format` (oxfmt).

### Updating Powerhouse dependencies

```sh
cd packages/workflow
ph update
```

Run it inside the package, not at the root, since only the package depends
on `@powerhousedao/*`. `ph update` also writes two junk fields (`readme`,
`_id`) into `package.json`; remove them before committing. Storage formats
can change between dev builds: if the switchboard refuses to start on existing
`.ph/reactor-storage`, move that folder aside and let Vetra create a fresh one.

## Docker

`packages/workflow/Dockerfile` is the codegen-generated multi-stage build
producing two images from a **published** package:

```sh
cd packages/workflow
docker build --target connect     --build-arg TAG=dev --build-arg PACKAGE_NAME=<npm name> -t reactor-workflow/connect .
docker build --target switchboard --build-arg TAG=dev --build-arg PACKAGE_NAME=<npm name> -t reactor-workflow/switchboard .
```

The `connect` image serves the built Connect through nginx on `PORT`
(default 3001) under `PH_CONNECT_BASE_PATH`. The `switchboard` image runs
`ph switchboard` on `PORT` (default 3000) and, when `DATABASE_URL` points at
Postgres, applies the Prisma schema and migrations unless
`SKIP_DB_MIGRATIONS=true`. Pass the secrets variables above as well.

Without `PACKAGE_NAME` the build falls back to installing the copied
`package.json`, which depends on `@powerhousedao/reactor-connectors` via
`workspace:*` and cannot resolve outside this monorepo. Building images from
the local checkout therefore needs the connectors package published (or the
Dockerfile adapted to copy the workspace). This path has not been exercised
in this repository yet.

## Troubleshooting

- **Port already in use**: another Vetra (or another app) holds 3000/4001.
  Stop it or pass `--connect-port` / `--switchboard-port`.
- **Connect shows duplicated or stuck drives after resetting `.ph`**: the
  browser still holds the old drives. Clear site data for the Connect origin
  and reload.
- **`pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS` or a release-age
  violation**: see the notes under Setup; `pnpm-workspace.yaml` is the place
  to fix it.
- **AI assistant tab missing**: `connect.ai.assistantEnabled` is false, or
  Vetra was not restarted after changing `powerhouse.config.json`.
