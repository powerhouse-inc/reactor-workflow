# Reactor Workflow

Powerhouse workflow automation: document models, runtime, editors and the
connector engine, extracted from the powerhouse monorepo
(`feat/reactor-connectors`, history preserved).

- `packages/workflow` — reactor package: `powerhouse/workflow` and
  `powerhouse/connection` document models, the workflow-runtime subgraph and
  run journal, the document-event trigger processor, and three editors
  (workflow builder, connection editor, and the Workflow Studio drive app).
- `packages/reactor-connectors` — the engine: Activepieces piece loading with
  worker isolation, block executor, expressions, connection auth shaping.

## Develop

```sh
pnpm install
pnpm build && pnpm test
cd packages/workflow && ph vetra   # studio on :3001, switchboard on :4001
```

Specs live in the workflow-automation docs; design decisions that shaped this
split are recorded in the monorepo discussion (packages consume published
`@powerhousedao/*` dev-channel releases).
