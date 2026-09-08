# Docling Piece Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@powerhousedao/piece-docling` — an Activepieces piece for Docling (docling-serve v1 REST) with 6 actions and piece-level auth validation — plus the small reactor-host change (first-party catalog entry) that makes it run unmodified in the Powerhouse workflow runtime.

**Architecture:** One new pnpm workspace package `packages/piece-docling` written against the *published* `@activepieces/pieces-framework@0.32.0` / `@activepieces/pieces-common@0.12.5` (pinned, reproducible). A small esbuild script produces a self-contained CJS bundle (keepNames, no deps) in exactly the shape the reactor's Path-B pipeline loads (spike S6a). All HTTP goes through the framework's `httpClient` so thrown errors keep the `HttpError` shape the reactor's failure classifier expects. The piece never touches `ctx.files` (a throwing stub in the reactor) — every output is JSON-safe. Tests run fully offline against a mock docling-serve; the conformance suite proves the bundle loads and executes through the real `PieceWorker`.

**Tech Stack:** TypeScript 5.9.3 (repo-pinned), Node 24, pnpm 11.5.0 workspace, ESM sources, esbuild 0.28.2 (bundle), vitest 4.1.1, oxlint, `@activepieces/pieces-framework@0.32.0`, `@activepieces/pieces-common@0.12.5`, `@activepieces/shared@0.95.1`.

**Spec:** `plan/20260908-docling-piece-design.md` (read it first — this plan implements it)

## Global Constraints

- **Branch:** `feat/docling-piece` (already created from `main`). Never commit to `main`.
- **Framework pin:** `@activepieces/pieces-framework: 0.32.0`, `@activepieces/pieces-common: 0.12.5`, `@activepieces/shared: 0.95.1` — exact, no carets.
- **Version status (2026-09-08):** `0.32.0` is the **latest published** `@activepieces/pieces-framework` (2026-06-17); the AP `main` branch is **0.39.0 and unpublished** (0.33–0.39 have no npm releases) — do not "upgrade" the pin during this work. Our 0.32.0-subset source compiles unmodified against main too, which is what makes the Task 17 upstream rename a rename and not a rewrite.
- **0.32.0 API boundary (verified against the published .d.ts, re-checked in review round 1):** `createAction` has **no** `classification` param (it landed after 0.32 — do not add it); `Property.File` has **no** `streaming` option; auth has **no** `getConnectionIdentifier` (only `validate`); `createPiece` has **no** `i18n` param; `PieceCategory` is exported from `@activepieces/shared`, not the framework; `SecretTextProperty` is a **zod schema value, not a factory** — secret properties use the `PieceAuth.SecretText(...)` factory (or a plain `{ type: "SECRET_TEXT", ... }` literal); `CustomAuth.validate` receives the **flat** property value (`{ base_url, api_key }`) — the shaped `{ type, props }` object only exists on runtime `ctx.auth`; `createAction`'s `outputSchema` is a **UI field list** (`{ fields: [{ key, label?, description? }] }`), not a validator; `HttpRequest` carries `body` (not `data`) and `timeout` in **milliseconds**; `Authentication` supports only `BEARER_TOKEN`/`BASIC` — docling's key goes in `headers` as `x-api-key`.
- **Bundle contract (spike S6a):** single CJS file, esbuild `keepNames`, `platform: node`, `target: node20`, **no externals** (everything inlined), npm tarball with `main: "./src/index.js"`, `dependencies: {}`, plus `src/i18n/translation.json`. Acceptance = the reactor Tier-1 conformance suite (Task 4, 11, 15).
- **Never call `ctx.files`** (reactor throwing stub). All action outputs are JSON-serializable (no Buffers).
- **All HTTP via `httpClient.sendRequest`** with `retries: 0` (the piece owns retry policy: 429/503 backoff in `client.ts`).
- **Offline tests only:** no test may reach the Activepieces cloud, npm registry, or a real docling-serve. The only allowed network is the in-process `node:http` mock (127.0.0.1).
- **docling-serve v1 contract (target 1.32.0):** sync endpoints 504 after the server's `max_sync_wait` (120s default); `max_sources_per_request` default 3; request body uses `sources[]` with `kind: "file" | "http"` and `target: {kind:"inbody"}`; `options.to_formats` defaults to `["md"]` server-side, `page_range` is 1-based `[start,end]`; auth header `X-Api-Key` (server may have it unset → header optional); async = `POST …/async` → `TaskStatusResponse{task_id,task_status,…}` → `GET /v1/status/poll/{id}?wait=` → `GET /v1/result/{id}`; health is `GET /health` (root-level, **not** `/v1/health`); `GET /version` returns **hyphenated** keys — `"docling-serve"`, `"docling"`, `"docling-core"`, `"docling-parse"`, `"docling-jobkit"`, `"python"`, `"plaform"` (the last is an upstream typo in 1.32.0 — match it verbatim, don't fix it).
- **License:** MIT (docling is MIT; AP community pieces commonly are; keeps the upstream PR clean).
- **Commits:** one per task (message given in each task). Small and incremental; never batch unrelated changes.
- **Repo commands:** package scripts `build` = `tsc -p tsconfig.json && node scripts/bundle.mjs`, `test` = `vitest run`, `tsc` = `tsc -p tsconfig.json`, `lint` = `oxlint --type-aware --type-check`. Root CI (`pnpm run build && pnpm run tsc && pnpm run lint && pnpm run test`) must stay green — Task 1 adds the package to the root `build` filter; `test`/`tsc`/`lint` are recursive (`pnpm -r`) and pick the package up automatically.

## File Structure

```
packages/piece-docling/
├── package.json              # workspace identity + npm-publish metadata (Task 1)
├── tsconfig.json             # extends ../../tsconfig.options.json (Task 1)
├── vitest.config.ts          # copy of reactor-connectors' (Task 1)
├── .oxlintrc.json            # copy of reactor-connectors' (Task 1)
├── scripts/bundle.mjs        # esbuild → dist/ npm-shape tarball source (Task 1)
├── src/
│   ├── index.ts              # createPiece + checkConnection shim (Task 4)
│   ├── lib/
│   │   ├── auth.ts           # doclingAuth: CustomAuth{base_url,api_key} + validate (Task 3)
│   │   ├── errors.ts         # DoclingError typed error (Task 3)
│   │   ├── files.ts          # normalizeFile: 3 runtime shapes → base64 (Task 5)
│   │   ├── options.ts        # action props → ConvertDocumentsOptions + shared prop defs (Task 6)
│   │   ├── client.ts         # request/headers/url helpers, error mapping, async loop (Task 7)
│   │   ├── output-schemas.ts # UI field descriptors for action outputs (Task 11)
│   │   └── actions/
│   │       ├── convert-file.ts   (Task 8)
│   │       ├── convert-url.ts    (Task 9)
│   │       ├── submit-job.ts     (Task 10)
│   │       ├── get-result.ts     (Task 10)
│   │       ├── chunk.ts          (Task 12)
│   │       └── health.ts         (Task 3)
│   └── i18n/translation.json # identity-mapped English keys (Task 12)
└── test/
    ├── mock-docling-serve.ts # in-process node:http mock of the v1 API (Task 2)
    ├── mock-context.ts       # hand-built ActionContext factory for piece tests (Task 3)
    ├── files.test.ts         (Task 5)
    ├── options.test.ts       (Task 6)
    ├── client.test.ts        (Task 7)
    ├── auth.test.ts          (Task 3)
    ├── convert.test.ts       (Tasks 8–9)
    ├── job.test.ts           (Task 10)
    ├── output-schemas.test.ts (Task 11)
    ├── chunk.test.ts         (Task 12)
    └── conformance.test.ts   # bundle → loadPiece → buildDescriptor → PieceWorker (Task 4, extended 11/15)
packages/reactor-connectors/
└── test/activepieces/
    ├── mock-docling-serve.ts           # copy of the piece's mock (Task 14)
    └── piece-docling.test.ts           # E2E: executor + worker + mock (Task 14)
packages/workflow/subgraphs/workflow-runtime/
├── piece-catalog.ts                     # MODIFY: FIRST_PARTY_PIECES merge + dedupe (Task 13)
├── piece-catalog.test.ts               # NEW (Task 13)
└── check-connection-docling.test.ts    # NEW: docling through the real subgraph path (Task 15)
reactor-workflow root
└── package.json                         # MODIFY: build filter (Task 1)
```

---

## Phase P0 — Scaffold, mock server, connection

### Task 1: Package scaffold + bundle script + stub-piece conformance smoke

**Files:**
- Create: `packages/piece-docling/package.json`, `tsconfig.json`, `vitest.config.ts`, `.oxlintrc.json`, `scripts/bundle.mjs`, `src/index.ts`, `src/i18n/translation.json`
- Create: `packages/piece-docling/test/conformance.test.ts`
- Modify: `package.json` (root: add piece to `build` filter)

**Interfaces:**
- Consumes: `@powerhousedao/reactor-connectors` exports `loadPieceFromDir(dir: string): Promise<{ piece: ApPiece; entryPath: string; check: "constructor-name" | "structural" }>` and `buildDescriptor(piece, source: {packageName, version}): ConnectorDescriptor` (from `src/activepieces/index.js` via the package root).
- Produces: a buildable package whose `pnpm build` emits `dist/` (npm-shape: `package.json` with `main: "./src/index.js"`, `src/index.js` single CJS file, `src/i18n/translation.json`) and whose stub piece passes the reactor loader. Later tasks replace the stub in `src/index.ts`.

- [ ] **Step 1: Create `packages/piece-docling/package.json`**

```json
{
  "name": "@powerhousedao/piece-docling",
  "version": "1.0.0",
  "description": "Activepieces piece for Docling (docling-serve v1): convert documents to Markdown, docling-document JSON, HTML, DocTags and plain text.",
  "type": "module",
  "main": "./src/index.js",
  "files": ["src"],
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/bundle.mjs",
    "tsc": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "oxlint --type-aware --type-check"
  },
  "dependencies": {
    "@activepieces/pieces-common": "0.12.5",
    "@activepieces/pieces-framework": "0.32.0",
    "@activepieces/shared": "0.95.1",
    "zod": "4.3.6"
  },
  "devDependencies": {
    "@powerhousedao/reactor-connectors": "workspace:*",
    "@types/node": "^24.13.3",
    "esbuild": "0.28.2",
    "oxlint": "1.70.0",
    "oxlint-tsgolint": "0.23.0",
    "typescript": "5.9.3",
    "vitest": "4.1.1"
  },
  "publishConfig": { "access": "public" },
  "license": "MIT"
}
```

- [ ] **Step 2: Create `packages/piece-docling/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.options.json",
  "compilerOptions": {
    "outDir": "./.tsbuild",
    "types": ["vitest/globals"]
  },
  "include": ["**/*"],
  "exclude": ["dist", "node_modules", ".tsbuild"]
}
```

- [ ] **Step 3: Create `packages/piece-docling/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
```

- [ ] **Step 4: Create `packages/piece-docling/.oxlintrc.json`** — copy the file from `packages/reactor-connectors/.oxlintrc.json` verbatim (`cp packages/reactor-connectors/.oxlintrc.json packages/piece-docling/.oxlintrc.json`).

- [ ] **Step 5: Create `packages/piece-docling/scripts/bundle.mjs`**

```js
// Builds the self-contained npm-shape bundle (spike S6a format):
// one CJS file, keepNames, everything inlined, "package/" -> dist/ layout.
//   node scripts/bundle.mjs [--out DIR] [--name NAME]
import { build } from "esbuild";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const args = process.argv.slice(2);
const outArg = args[args.indexOf("--out") + 1];
const nameArg = args[args.indexOf("--name") + 1];
const outDir = outArg ?? path.join(root, "dist");
const pkg = JSON.parse(
  await (await import("node:fs/promises")).readFile(path.join(root, "package.json"), "utf8"),
);

await rm(outDir, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  keepNames: true,
  outfile: path.join(outDir, "src/index.js"),
  external: [],
  logLevel: "silent",
});
await writeFile(
  path.join(outDir, "package.json"),
  JSON.stringify(
    {
      name: nameArg ?? pkg.name,
      version: pkg.version,
      description: pkg.description,
      main: "./src/index.js",
      dependencies: {},
      license: pkg.license,
    },
    null,
    2,
  ) + "\n",
);
// i18n is a data file the AP UI reads from the bundle.
const i18n = path.join(root, "src/i18n/translation.json");
await mkdir(path.join(outDir, "src/i18n"), { recursive: true });
await (await import("node:fs/promises")).copyFile(i18n, path.join(outDir, "src/i18n/translation.json"));
console.log(`bundle: ${outDir}`);
```

- [ ] **Step 6: Create `packages/piece-docling/src/i18n/translation.json`**

```json
{
  "en": {
    "Docling": "Docling",
    "Convert documents (PDF, DOCX, PPTX, images, HTML, …) to Markdown, docling-document JSON, HTML, DocTags and plain text via a docling-serve v1 API (self-hosted or Docling for IBM watsonx).": "Convert documents (PDF, DOCX, PPTX, images, HTML, …) to Markdown, docling-document JSON, HTML, DocTags and plain text via a docling-serve v1 API (self-hosted or Docling for IBM watsonx)."
  }
}
```

- [ ] **Step 7: Create the stub piece `packages/piece-docling/src/index.ts`**

```ts
import { createPiece } from "@activepieces/pieces-framework";
import { PieceCategory } from "@activepieces/shared";

// Stub — replaced by Task 4. Kept minimal so the bundle/loader pipeline is
// proven before any real logic exists.
const stub = createPiece({
  displayName: "Docling",
  description: "Docling document conversion (stub).",
  logoUrl: "data:image/svg+xml,stub",
  authors: ["froid"],
  categories: [PieceCategory.CONTENT_AND_FILES],
  auth: undefined,
  actions: [],
  triggers: [],
});

export { stub as docling };
export default stub;
```

Note: `createPiece`'s `auth` parameter is required in the 0.32.0 `CreatePieceParams` type but accepts `undefined` (see `auth: PieceAuth | undefined`). If the pinned types reject `undefined` at compile time, use `PieceAuth.None()` instead — `PieceAuth` is exported by the framework.

- [ ] **Step 8: Register in the root build filter** — in the root `package.json`, change the `build` script to:

```json
"build": "pnpm --filter @powerhousedao/reactor-connectors build && pnpm --filter workflow build && pnpm --filter @powerhousedao/piece-docling build"
```

- [ ] **Step 9: Install and verify the toolchain** (from the repo root — the docling worktree or the primary checkout, whichever you're working in)

```bash
pnpm install
pnpm --filter @powerhousedao/reactor-connectors build
pnpm --filter @powerhousedao/piece-docling build
```

Build `reactor-connectors` first: the conformance test imports it by package name, and its `exports` map resolves to `dist/` under vitest (the `source` condition is a tsconfig-only feature — `tsc` sees source, vitest does not).

Expected: `tsc` typechecks (no errors), esbuild prints `bundle: <abs>/dist`, and `dist/package.json` contains `"main": "./src/index.js"` and `"dependencies": {}`. If esbuild's binary fails to run (repo disables its install script via `allowBuilds`), the platform binary comes from the `@esbuild/linux-x64` optional dependency — verify with `node -e "require('esbuild').transformSync('let x=1')"`. If that fails, add `@esbuild/linux-x64` to the package's devDependencies explicitly.

- [ ] **Step 10: Write the conformance smoke test `packages/piece-docling/test/conformance.test.ts`**

```ts
// Tier-1 conformance (spec D8): our bundle loads and describes through the
// reactor's real loader/descriptor. The bundle is built on demand — the
// bundle script is the single source of the tarball format.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPieceFromDir } from "@powerhousedao/reactor-connectors";

const FIX = path.join(tmpdir(), `docling-conform-${process.pid}`);

function builtBundleDir(): string {
  const dist = path.resolve("dist");
  if (!existsSync(path.join(dist, "src/index.js"))) {
    execFileSync("node", ["scripts/bundle.mjs"], { cwd: path.resolve(".") });
  }
  const dir = path.join(FIX, "bundle");
  rmSync(dir, { recursive: true, force: true });
  cpSync(dist, dir, { recursive: true });
  return dir;
}

describe("bundle conformance (Tier-1)", () => {
  it("loads via the reactor duck-typed loader", async () => {
    const loaded = await loadPieceFromDir(builtBundleDir());
    expect(loaded.check).toBe("constructor-name");
    expect(loaded.piece.displayName).toBe("Docling");
  });
});
```

The extra conformance cases (descriptor auth/action assertions, the checkConnection shim) are added in Task 4.

- [ ] **Step 11: Run the test — it must pass against the stub**

Run: `pnpm --filter @powerhousedao/piece-docling test`
Expected: PASS (`constructor-name` check — esbuild `keepNames` preserved the `Piece` class name). If it reports `structural`, the bundle lost keepNames — re-check `scripts/bundle.mjs` before proceeding.

- [ ] **Step 12: Commit**

```bash
git add packages/piece-docling package.json pnpm-lock.yaml
git commit -m "feat(piece-docling): scaffold package, esbuild bundle script, Tier-1 conformance smoke"
```

---

### Task 2: Mock docling-serve

**Files:**
- Create: `packages/piece-docling/test/mock-docling-serve.ts`
- Create: `packages/piece-docling/test/mock-docling-serve.test.ts` (the mock's own contract tests)

**Interfaces:**
- Consumes: nothing (node:http only).
- Produces (used by every later test):

```ts
export interface MockDoclingOptions {
  /** When set, every request must carry X-Api-Key with this value. */
  apiKey?: string;
  /** Force 401 on every request regardless of header. */
  failAuthAlways?: boolean;
  /** Sync convert/chunk endpoints respond 504 (simulates max_sync_wait). */
  syncSlow?: boolean;
  /** Filenames whose async jobs end in failure. */
  failJobs?: string[];
  /** First N convert/chunk submissions respond 429 with Retry-After: 0. */
  backpressure?: number;
}
export interface MockDocling {
  baseUrl: string;            // http://127.0.0.1:<port>
  close(): Promise<void>;
  requests: Array<{ method: string; path: string; query: URLSearchParams; headers: Record<string, string | string[]> }>;
  /** number of /v1/status/poll calls (assert long-poll usage) */
  pollCount: number;
}
export async function startMockDocling(opts?: MockDoclingOptions): Promise<MockDocling>;
```

Canned response constants (exported for assertions):
```ts
export const MOCK_MD = "# Mock doc\n\nParagraph one.";
export const MOCK_JSON = { version: "1.7.0", records: [{ subject: "Mock Document" }] };
export const MOCK_HTML = "<h1>Mock doc</h1><p>Paragraph one.</p>";
export const MOCK_TEXT = "Mock doc Paragraph one.";
export const MOCK_DOCTAGS = "<docling><document><text>Mock doc</text></document></docling>";
export const MOCK_CHUNKS = [
  { text: "chunk one", page_no: 1, start_chunk_no: 1, end_chunk_no: 1 },
  { text: "chunk two", page_no: 1, start_chunk_no: 2, end_chunk_no: 2 },
];
```

- [ ] **Step 1: Write the failing contract test `test/mock-docling-serve.test.ts`**

```ts
import { startMockDocling, MOCK_MD, type MockDocling } from "./mock-docling-serve.js";

let mock: MockDocling;

async function get(path: string, key?: string) {
  const url = new URL(path, mock.baseUrl);
  if (key) url.searchParams.set("api_key", key);
  const res = await fetch(url, { headers: key ? { "x-api-key": key } : {} });
  return { status: res.status, body: (await res.json()) as unknown };
}

beforeAll(async () => {
  mock = await startMockDocling({ apiKey: "k-test" });
});
afterAll(async () => await mock.close());

it("enforces X-Api-Key when configured", async () => {
  expect((await get("/health")).status).toBe(401);
  const res = await fetch(mock.baseUrl + "/health", { headers: { "x-api-key": "k-test" } });
  expect(res.status).toBe(200);
  expect((await res.json()) as unknown).toEqual({ status: "ok" });
});

it("serves /version with the real 1.32.0 hyphenated key set", async () => {
  const res = await fetch(mock.baseUrl + "/version", { headers: { "x-api-key": "k-test" } });
  const body = (await res.json()) as Record<string, string>;
  expect(body["docling-serve"]).toBe("1.32.0");
  expect(body["docling"]).toBe("2.126.0");
  expect(body.plaform).toBeDefined(); // upstream typo, matched verbatim
});

it("sync /v1/convert/source returns the canned document for the requested formats", async () => {
  const res = await fetch(mock.baseUrl + "/v1/convert/source", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k-test" },
    body: JSON.stringify({
      sources: [{ kind: "file", base64_string: "AAAA", filename: "a.pdf" }],
      options: { to_formats: ["md"] },
      target: { kind: "inbody" },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; document: { md_content: string; json_content: unknown } };
  expect(body.status).toBe("success");
  expect(body.document.md_content).toBe(MOCK_MD);
  expect(body.document.json_content).toBeNull(); // not requested
});

it("async: submit → poll (started → success) → result", async () => {
  const sub = await fetch(mock.baseUrl + "/v1/convert/source/async", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k-test" },
    body: JSON.stringify({
      sources: [{ kind: "http", url: "https://example.com/x.pdf" }],
      options: { to_formats: ["md", "json"] },
      target: { kind: "inbody" },
    }),
  });
  const task = (await sub.json()) as { task_id: string; task_status: string };
  expect(task.task_status).toBe("pending");
  const before = mock.pollCount;
  const p1 = await get(`/v1/status/poll/${task.task_id}?wait=5`);
  expect(p1.body).toMatchObject({ task_status: "started" });
  const p2 = await get(`/v1/status/poll/${task.task_id}?wait=5`);
  expect(p2.body).toMatchObject({ task_status: "success" });
  expect(mock.pollCount).toBe(before + 2);
  const result = await get(`/v1/result/${task.task_id}`);
  expect(result.body).toMatchObject({ status: "success" });
  expect((result.body as { document: { json_content: unknown } }).document.json_content).toBeTruthy();
});

it("reports 429 with Retry-After for backpressure, then succeeds", async () => {
  const m2 = await startMockDocling({ apiKey: "k-test", backpressure: 2 });
  try {
    const doConvert = () =>
      fetch(m2.baseUrl + "/v1/convert/source/async", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k-test" },
        body: JSON.stringify({ sources: [{ kind: "http", url: "https://example.com/y.pdf" }] }),
      });
    const r1 = await doConvert();
    expect(r1.status).toBe(429);
    expect(r1.headers.get("retry-after")).toBe("0");
    expect((await doConvert()).status).toBe(429);
    expect((await doConvert()).status).toBe(200);
  } finally {
    await m2.close();
  }
});

it("504 on sync when syncSlow", async () => {
  const m3 = await startMockDocling({ apiKey: "k-test", syncSlow: true });
  try {
    const res = await fetch(m3.baseUrl + "/v1/convert/source", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k-test" },
      body: JSON.stringify({ sources: [{ kind: "http", url: "https://example.com/z.pdf" }] }),
    });
    expect(res.status).toBe(504);
  } finally {
    await m3.close();
  }
});

it("async job failure surfaces TaskFailureResult on /v1/result", async () => {
  const m4 = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
  try {
    const sub = await fetch(m4.baseUrl + "/v1/convert/source/async", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k-test" },
      body: JSON.stringify({ sources: [{ kind: "file", base64_string: "AAAA", filename: "bad.pdf" }] }),
    });
    const task = (await sub.json()) as { task_id: string };
    // drain to failure
    let status = "started";
    for (let i = 0; i < 5 && status !== "failure"; i++) {
      const p = await fetch(`${m4.baseUrl}/v1/status/poll/${task.task_id}`, { headers: { "x-api-key": "k-test" } });
      status = ((await p.json()) as { task_status: string }).task_status;
    }
    expect(status).toBe("failure");
    const result = await fetch(`${m4.baseUrl}/v1/result/${task.task_id}`, { headers: { "x-api-key": "k-test" } });
    expect(result.status).toBe(200);
    expect((await result.json()) as unknown).toMatchObject({
      failure: { category: "inference_failure", retryable: false },
    });
  } finally {
    await m4.close();
  }
});

it("chunk endpoint returns the canned chunks", async () => {
  const res = await fetch(mock.baseUrl + "/v1/chunk/hybrid/source", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k-test" },
    body: JSON.stringify({ sources: [{ kind: "http", url: "https://example.com/c.pdf" }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()) as unknown).toMatchObject({ chunks: expect.any(Array) });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/mock-docling-serve.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `test/mock-docling-serve.ts`**

```ts
// In-process stand-in for docling-serve v1 (1.32.0 surface). Implements only
// what the piece calls, with enough fidelity to test auth, sync/async,
// polling, backpressure and failure mapping. Offline by construction.
import http from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_MD = "# Mock doc\n\nParagraph one.";
export const MOCK_JSON = { version: "1.7.0", records: [{ subject: "Mock Document" }] };
export const MOCK_HTML = "<h1>Mock doc</h1><p>Paragraph one.</p>";
export const MOCK_TEXT = "Mock doc Paragraph one.";
export const MOCK_DOCTAGS = "<docling><document><text>Mock doc</text></document></docling>";
export const MOCK_CHUNKS = [
  { text: "chunk one", page_no: 1, start_chunk_no: 1, end_chunk_no: 1 },
  { text: "chunk two", page_no: 1, start_chunk_no: 2, end_chunk_no: 2 },
];

export interface MockDoclingOptions {
  apiKey?: string;
  failAuthAlways?: boolean;
  syncSlow?: boolean;
  failJobs?: string[];
  backpressure?: number;
}

export interface MockDocling {
  baseUrl: string;
  close(): Promise<void>;
  requests: Array<{
    method: string;
    path: string;
    query: URLSearchParams;
    headers: Record<string, string | string[]>;
  }>;
  pollCount: number;
}

interface Task {
  id: string;
  polls: number;
  failing: boolean;
  filename: string;
  formats: string[];
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function documentPayload(filename: string, formats: string[]) {
  return {
    filename,
    md_content: formats.includes("md") ? MOCK_MD : null,
    json_content: formats.includes("json") ? MOCK_JSON : null,
    html_content: formats.includes("html") ? MOCK_HTML : null,
    text_content: formats.includes("text") ? MOCK_TEXT : null,
    doctags_content: formats.includes("doctags") ? MOCK_DOCTAGS : null,
  };
}

function successResponse(filename: string, formats: string[]) {
  return {
    document: documentPayload(filename, formats),
    status: "success",
    errors: [],
    processing_time: 0.4,
  };
}

export async function startMockDocling(opts: MockDoclingOptions = {}): Promise<MockDocling> {
  const tasks = new Map<string, Task>();
  const requests: MockDocling["requests"] = [];
  let pollCount = 0;
  let seq = 0;
  let backpressureLeft = opts.backpressure ?? 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: req.method ?? "",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers as Record<string, string | string[]>,
    });

    if (opts.failAuthAlways || (opts.apiKey && req.headers["x-api-key"] !== opts.apiKey)) {
      return json(res, 401, { detail: "Invalid API Key." });
    }

    const p = url.pathname;
    if (req.method === "GET" && p === "/health") return json(res, 200, { status: "ok" });
    if (req.method === "GET" && p === "/version") {
      // Key set mirrors the real 1.32.0 DOCLING_VERSIONS, including the
      // upstream "plaform" typo.
      return json(res, 200, {
        "docling-serve": "1.32.0",
        docling: "2.126.0",
        "docling-core": "2.126.0",
        "docling-parse": "2.126.0",
        "docling-jobkit": "1.32.0",
        python: "3.11.9",
        plaform: "linux",
      });
    }

    let body: {
      sources?: Array<{ kind?: string; base64_string?: string; filename?: string; url?: string }>;
      options?: { to_formats?: string[] };
    } = {};
    if (req.method === "POST") {
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 422, { detail: "invalid JSON" });
      }
    }

    const isConvert = p.startsWith("/v1/convert");
    const isChunk = p.startsWith("/v1/chunk");
    const isAsync = p.endsWith("/async");
    const isSync = isConvert || isChunk;

    if (isSync && !isAsync && opts.syncSlow) return json(res, 504, { detail: "sync timeout" });
    if (isSync && backpressureLeft > 0) {
      backpressureLeft--;
      return json(res, 429, { detail: "server busy" }, { "retry-after": "0" });
    }

    if (isSync && isAsync) {
      const sources = body.sources ?? [];
      if (sources.length === 0) return json(res, 422, { detail: "sources must be non-empty" });
      const filename = sources[0]?.filename ?? sources[0]?.url ?? "doc";
      const id = `task-${++seq}`;
      tasks.set(id, {
        id,
        polls: 0,
        failing: (opts.failJobs ?? []).includes(sources[0]?.filename ?? ""),
        filename: String(filename).split("/").pop() ?? "doc",
        formats: body.options?.to_formats ?? ["md"],
      });
      return json(res, 200, {
        task_id: id,
        task_type: p.startsWith("/v1/chunk") ? "chunk" : "convert",
        task_status: "pending",
        task_position: 1,
        task_meta: { num_docs: sources.length, num_processed: 0 },
      });
    }

    if (req.method === "GET" && p.startsWith("/v1/status/poll/")) {
      const id = p.slice("/v1/status/poll/".length);
      const task = tasks.get(id);
      if (!task) return json(res, 404, { detail: "task not found" });
      pollCount++;
      const done = task.polls >= 1 || task.failing;
      task.polls++;
      if (!done) {
        return json(res, 200, {
          task_id: id,
          task_status: "started",
          task_meta: { num_docs: 1, num_processed: 0 },
        });
      }
      return json(res, 200, {
        task_id: id,
        task_status: task.failing ? "failure" : "success",
        task_meta: { num_docs: 1, num_processed: 1, num_succeeded: task.failing ? 0 : 1 },
        failure: task.failing
          ? { category: "inference_failure", message: "mock inference failure", retryable: false }
          : null,
      });
    }

    if (req.method === "GET" && p.startsWith("/v1/result/")) {
      const id = p.slice("/v1/result/".length);
      const task = tasks.get(id);
      if (!task) return json(res, 404, { detail: "task not found" });
      if (task.failing) {
        return json(res, 200, {
          task_id: id,
          failure: { category: "inference_failure", message: "mock inference failure", retryable: false },
        });
      }
      if (p.startsWith("/v1/chunk")) {
        return json(res, 200, { chunks: MOCK_CHUNKS, processing_time: 0.3 });
      }
      return json(res, 200, successResponse(task.filename, task.formats));
    }

    if (req.method === "POST" && isSync) {
      const sources = body.sources ?? [];
      if (sources.length === 0) return json(res, 422, { detail: "sources must be non-empty" });
      const first = sources[0]!;
      if (first.kind === "http" && String(first.url).endsWith(".zip")) {
        return json(res, 422, { detail: "zip sources are not supported" });
      }
      const filename = first.filename ?? String(first.url ?? "doc").split("/").pop() ?? "doc";
      if (p.startsWith("/v1/chunk")) {
        return json(res, 200, { chunks: MOCK_CHUNKS, processing_time: 0.3 });
      }
      if ((opts.failJobs ?? []).includes(first.filename ?? "")) {
        return json(res, 200, {
          document: null,
          status: "failure",
          errors: [{ category: "inference_failure", error_message: "mock inference failure" }],
          processing_time: 0.1,
        });
      }
      return json(res, 200, successResponse(String(filename), body.options?.to_formats ?? ["md"]));
    }

    return json(res, 404, { detail: `no route ${p}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    requests,
    get pollCount() {
      return pollCount;
    },
  };
}
```

- [ ] **Step 4: Run the contract tests — all pass**

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/mock-docling-serve.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/piece-docling/test/mock-docling-serve.ts packages/piece-docling/test/mock-docling-serve.test.ts
git commit -m "test(piece-docling): in-process docling-serve v1 mock with auth/async/backpressure/failure"
```

---

### Task 3: `doclingAuth` (validate) + `health` action + piece test context

**Files:**
- Create: `packages/piece-docling/src/lib/errors.ts`
- Create: `packages/piece-docling/src/lib/auth.ts`
- Create: `packages/piece-docling/src/lib/actions/health.ts`
- Create: `packages/piece-docling/test/mock-context.ts`
- Create: `packages/piece-docling/test/auth.test.ts`
- Modify: `packages/piece-docling/src/index.ts` (register health action on the stub piece)

**Interfaces:**
- Consumes: `PieceAuth.CustomAuth`, `PieceAuth.SecretText` (the 0.32.0 factory for secret properties — `SecretTextProperty` is a zod schema *value* in this version, not a factory), `Property.ShortText`, `httpClient`/`HttpMethod` (pieces-common 0.12.5), Task 2's mock.
- Produces:
  - `DoclingError extends Error` with `kind: 'AUTH' | 'VALIDATION' | 'SYNC_TIMEOUT' | 'OVERLOADED' | 'JOB_FAILED' | 'BAD_FILE' | 'DEADLINE'` and `retryable: boolean` (constructor `(kind, message, retryable = false)`).
  - `doclingAuth: CustomAuthProperty<{ base_url: ShortText property; api_key: SECRET_TEXT property }>` with `validate({ auth, server })` → `{ valid: true } | { valid: false, error: string }` (GET `/health`, 10s timeout). **0.32.0 hands `validate` the flat property value** (`{ base_url, api_key }`) — not a shaped `{props}` object (that shape only exists on runtime `ctx.auth`).
  - `export function authFromCtx(ctx: { auth?: unknown }): { baseUrl: string; apiKey?: string }` — reads `ctx.auth.props.{base_url,api_key}`, normalizes the base URL (trailing-slash stripped; empty → `http://localhost:5001`), returns the key only when non-empty.
  - `healthAction` — no props; `run` → `{ status: string; versions: Record<string, unknown> }`.
  - `makeActionContext(propsValue, auth?)` in `test/mock-context.ts` — a hand-built ActionContext (spike S6a pattern) for piece tests: real `propsValue`/`auth`, no-op `store` (Map-backed), throwing stubs for `server`/`files`/`agent`/`run`/`flows`/`project`/`step`/`connections` (each throw `new Error("unsupported: <name>")` when called), `executionType: "BEGIN"`.

- [ ] **Step 1: Create `src/lib/errors.ts`**

```ts
export type DoclingErrorKind =
  | "AUTH"
  | "VALIDATION"
  | "SYNC_TIMEOUT"
  | "OVERLOADED"
  | "JOB_FAILED"
  | "BAD_FILE"
  | "DEADLINE";

export class DoclingError extends Error {
  constructor(
    public readonly kind: DoclingErrorKind,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "DoclingError";
  }
}
```

- [ ] **Step 2: Write `test/auth.test.ts` (failing)**

```ts
import { doclingAuth, authFromCtx } from "../src/lib/auth.js";
import { startMockDocling } from "./mock-docling-serve.js";
import type { MockDocling } from "./mock-docling-serve.js";

const SERVER = { apiUrl: "", publicUrl: "" } as never; // validate never touches server

describe("doclingAuth.validate", () => {
  let mock: MockDocling;
  beforeAll(async () => {
    mock = await startMockDocling({ apiKey: "k-test" });
  });
  afterAll(async () => await mock.close());

  it("validates against a healthy server with a correct key", async () => {
    const res = await doclingAuth.validate!({
      auth: { base_url: mock.baseUrl, api_key: "k-test" },
      server: SERVER,
    });
    expect(res).toEqual({ valid: true });
  });

  it("reports a rejected key", async () => {
    const res = await doclingAuth.validate!({
      auth: { base_url: mock.baseUrl, api_key: "wrong" },
      server: SERVER,
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.error).toMatch(/401/);
  });

  it("reports an unreachable server", async () => {
    const res = await doclingAuth.validate!({
      auth: { base_url: "http://127.0.0.1:1", api_key: undefined },
      server: SERVER,
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.error).toMatch(/Could not reach/);
  });
});

describe("authFromCtx", () => {
  it("normalizes base URL and optional key", () => {
    expect(authFromCtx({ auth: { props: { base_url: "http://x:5001/", api_key: "k" } } })).toEqual({
      baseUrl: "http://x:5001",
      apiKey: "k",
    });
    expect(authFromCtx({ auth: { props: { base_url: "", api_key: "" } } })).toEqual({
      baseUrl: "http://localhost:5001",
    });
    expect(authFromCtx({ auth: undefined })).toEqual({ baseUrl: "http://localhost:5001" });
  });
});
```

- [ ] **Step 3: Run — verify it fails** (module not found).

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/auth.test.ts`
Expected: FAIL.

- [ ] **Step 4: Create `src/lib/auth.ts`**

```ts
import { PieceAuth, Property } from "@activepieces/pieces-framework";
import { httpClient, HttpMethod } from "@activepieces/pieces-common";
import { DoclingError } from "./errors.js";

export const DOCLING_DEFAULT_BASE_URL = "http://localhost:5001";

export function normalizeBaseUrl(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  if (!v) return DOCLING_DEFAULT_BASE_URL;
  return v.replace(/\/+$/, "");
}

export function authKeyHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { "x-api-key": apiKey } : {};
}

export const doclingAuth = PieceAuth.CustomAuth({
  displayName: "Docling Serve",
  description:
    "A docling-serve v1 API server — self-hosted, or Docling for IBM watsonx (same API).",
  required: true,
  props: {
    base_url: Property.ShortText({
      displayName: "Service URL",
      required: true,
      defaultValue: DOCLING_DEFAULT_BASE_URL,
      description:
        "Base URL of the docling-serve instance, e.g. http://localhost:5001 — or your Docling-for-IBM-watsonx service URL.",
    }),
    // SecretTextProperty is a zod schema value in 0.32.0, not a factory —
    // the factory form is PieceAuth.SecretText.
    api_key: PieceAuth.SecretText({
      displayName: "API Key",
      required: false,
      description:
        "The server's DOCLING_SERVE_API_KEY value, sent as the X-Api-Key header. Leave empty for an unauthenticated local server.",
    }),
  },
  // 0.32.0 passes the FLAT property value here ({ base_url, api_key }) —
  // the shaped { type, props } object only exists on runtime ctx.auth.
  validate: async ({ auth }) => {
    const base = normalizeBaseUrl(auth.base_url);
    try {
      const res = await httpClient.sendRequest({
        method: HttpMethod.GET,
        url: `${base}/health`,
        headers: authKeyHeaders(typeof auth.api_key === "string" ? auth.api_key : undefined),
        timeout: 10_000,
        retries: 0,
      });
      if (res.status === 401) {
        return { valid: false, error: "The API key was rejected by the server (401)." };
      }
      if (res.status < 200 || res.status >= 300) {
        return { valid: false, error: `Server responded ${res.status}.` };
      }
      return { valid: true };
    } catch (err) {
      if ((err as { status?: unknown })?.status === 401) {
        return { valid: false, error: "The API key was rejected by the server (401)." };
      }
      return {
        valid: false,
        error: `Could not reach docling-serve at ${base}. ${(err as Error)?.message ?? String(err)}`,
      };
    }
  },
});

// Reads the shaped connection value (AP: ctx.auth; reactor: shapeAuthValue's
// CUSTOM_AUTH value) into a plain pair. Both runtimes produce
// { type: "CUSTOM_AUTH", props: { base_url, api_key } }.
export function authFromCtx(ctx: { auth?: unknown }): { baseUrl: string; apiKey?: string } {
  const props = (ctx.auth as { props?: Record<string, unknown> } | undefined)?.props ?? {};
  const key = props.api_key;
  return {
    baseUrl: normalizeBaseUrl(props.base_url),
    apiKey: typeof key === "string" && key.length > 0 ? key : undefined,
  };
}

export { DoclingError };
```

- [ ] **Step 5: Create `src/lib/actions/health.ts`**

```ts
import { createAction } from "@activepieces/pieces-framework";
import { httpClient, HttpMethod } from "@activepieces/pieces-common";
import { doclingAuth, authFromCtx, authKeyHeaders } from "../auth.js";
import { DoclingError } from "../errors.js";

export const healthAction = createAction({
  auth: doclingAuth,
  name: "health",
  displayName: "Check Health",
  description:
    "Checks the docling-serve connection (GET /health and /version). Use as a pre-flight step.",
  audience: "both",
  aiMetadata: {
    description: "Verifies the docling-serve endpoint is reachable and returns its component versions.",
    idempotent: true,
  },
  props: {},
  run: async (ctx) => {
    const { baseUrl, apiKey } = authFromCtx(ctx);
    const h = authKeyHeaders(apiKey);
    const healthRes = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${baseUrl}/health`,
      headers: h,
      timeout: 10_000,
      retries: 0,
    });
    if (healthRes.status === 401) {
      throw new DoclingError(
        "AUTH",
        "docling-serve rejected the API key (401). Check the connection's API key against the server's DOCLING_SERVE_API_KEY.",
      );
    }
    if (healthRes.status < 200 || healthRes.status >= 300) {
      throw new DoclingError("JOB_FAILED", `docling-serve /health responded ${healthRes.status}.`);
    }
    const versionRes = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${baseUrl}/version`,
      headers: h,
      timeout: 10_000,
      retries: 0,
    });
    return {
      status: (healthRes.body as { status?: string })?.status ?? "ok",
      versions: (versionRes.body as Record<string, unknown>) ?? {},
    };
  },
});
```

- [ ] **Step 6: Create `test/mock-context.ts`**

```ts
// Hand-built ActionContext (spike S6a pattern): the members the piece reads
// are real; everything else throws named, so any undocumented dependency
// fails loudly in tests instead of in production.
type Stub = { (...args: never[]): never };

function throwingStub(name: string): Stub {
  return Object.assign(
    (...(_args: unknown[]): never => {
      throw new Error(`unsupported context member: ${name}`);
    }),
    {},
  );
}

export function makeActionContext(propsValue: Record<string, unknown>, auth?: unknown) {
  const store = new Map<string, unknown>();
  return {
    executionType: "BEGIN",
    propsValue,
    auth,
    store: {
      put: async (k: string, v: unknown) => v,
      get: async (k: string) => store.get(k) ?? null,
      delete: async (k: string) => {
        store.delete(k);
      },
    },
    connections: throwingStub("connections"),
    tags: throwingStub("tags"),
    server: throwingStub("server"),
    files: throwingStub("files"),
    output: throwingStub("output"),
    agent: { tools: [] as unknown[] },
    run: {
      id: "test-run",
      stop: throwingStub("run.stop"),
      pause: throwingStub("run.pause"),
      respond: throwingStub("run.respond"),
    },
    project: {
      id: "test-project",
      externalId: async () => "test-project",
    },
    flows: {
      list: throwingStub("flows.list"),
      current: { id: "test-flow", version: { id: "v1" } },
    },
    step: { name: "test-step" },
    generateResumeUrl: throwingStub("generateResumeUrl"),
  };
}

export type MockActionContext = ReturnType<typeof makeActionContext>;
```

- [ ] **Step 7: Register the health action in the stub piece** — replace `actions: []` in `src/index.ts` with `actions: [healthAction]` (import from `./lib/actions/health.js`).

- [ ] **Step 8: Add a health test to `test/auth.test.ts`** (append):

```ts
import { healthAction } from "../src/lib/actions/health.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling as startMock2 } from "./mock-docling-serve.js";

describe("health action", () => {
  it("returns status + versions", async () => {
    const mock = await startMock2({ apiKey: "k-test" });
    try {
      const out = await healthAction.run(
        makeActionContext(
          {},
          { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
        ) as never,
      );
      expect(out).toEqual({ status: "ok", versions: expect.objectContaining({ "docling-serve": "1.32.0", docling: "2.126.0" }) });
    } finally {
      await mock.close();
    }
  });

  it("throws a typed AUTH error on 401", async () => {
    const mock = await startMock2({ apiKey: "k-test" });
    try {
      await expect(
        healthAction.run(
          makeActionContext(
            {},
            { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "nope" } },
          ) as never,
        ),
      ).rejects.toMatchObject({ kind: "AUTH", name: "DoclingError" });
    } finally {
      await mock.close();
    }
  });
});
```

- [ ] **Step 9: Run the package tests — all pass**

Run: `pnpm --filter @powerhousedao/piece-docling test`
Expected: PASS (mock + auth + health + conformance).

- [ ] **Step 10: Commit**

```bash
git add packages/piece-docling/src packages/piece-docling/test
git commit -m "feat(piece-docling): doclingAuth (CustomAuth + validate), health action, mock action context"
```

---

### Task 4: `createPiece` + `checkConnection` shim + full conformance

**Files:**
- Modify: `packages/piece-docling/src/index.ts`
- Modify: `packages/piece-docling/test/conformance.test.ts`

**Interfaces:**
- Consumes: `doclingAuth` (Task 3), `healthAction` (Task 3), the reactor's `loadPieceFromDir`/`buildDescriptor`/`PieceWorker`.
- Produces: default export = the `Piece` instance with `checkConnection: (ctx: unknown) => Promise<{ name: string } | undefined>` attached (throws on failure). `buildDescriptor` over the built bundle yields `auth.type === "CUSTOM_AUTH"` and an action list containing `health`.

- [ ] **Step 1: Extend the conformance test first (failing)**

In `test/conformance.test.ts`, add:

```ts
it("descriptor exposes the CUSTOM_AUTH auth and the health action", async () => {
  const loaded = await loadPieceFromDir(builtBundleDir());
  const descriptor = buildDescriptor(loaded.piece, {
    packageName: "@powerhousedao/piece-docling",
    version: "1.0.0",
  });
  expect(descriptor.auth?.type).toBe("CUSTOM_AUTH");
  expect(descriptor.actions.map((a) => a.name)).toContain("health");
});

it("exposes a checkConnection shim compatible with the reactor subgraph contract", async () => {
  const loaded = await loadPieceFromDir(builtBundleDir());
  const check = (loaded.piece as unknown as { checkConnection?: (ctx: unknown) => Promise<unknown> })
    .checkConnection;
  expect(typeof check).toBe("function");
  const mock = await startMockDocling({ apiKey: "k-test" });
  try {
    const out = await check!({
      auth: { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
    });
    expect(out).toMatchObject({ name: expect.stringContaining("docling-serve 1.32.0") });
    await expect(
      check!({
        auth: { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "bad" } },
      }),
    ).rejects.toThrow();
  } finally {
    await mock.close();
  },
  );
});
```

(import `buildDescriptor` and `startMockDocling` at the top of the file.)

- [ ] **Step 2: Run — verify the new tests fail** (stub has no checkConnection / no auth).

- [ ] **Step 3: Rewrite `src/index.ts`**

```ts
import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { PieceCategory } from "@activepieces/shared";
import { doclingAuth, authFromCtx, authKeyHeaders } from "./lib/auth.js";
import { DoclingError } from "./lib/errors.js";
import { httpClient, HttpMethod } from "@activepieces/pieces-common";
import { healthAction } from "./lib/actions/health.js";

const DOC_LOGO =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#1e3a8a"/><path d="M14 10h14l8 8v20a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#fff"/><path d="M28 10v8h8" fill="none" stroke="#1e3a8a" stroke-width="2"/><path d="M18 24h12M18 29h12M18 34h8" stroke="#1e3a8a" stroke-width="2"/></svg>`,
  );

const docling = createPiece({
  displayName: "Docling",
  description:
    "Convert documents (PDF, DOCX, PPTX, images, HTML, …) to Markdown, docling-document JSON, HTML, DocTags and plain text via a docling-serve v1 API (self-hosted or Docling for IBM watsonx).",
  logoUrl: DOC_LOGO,
  authors: ["froid"],
  categories: [PieceCategory.CONTENT_AND_FILES],
  auth: doclingAuth,
  actions: [healthAction],
  triggers: [],
});

// The Powerhouse workflow-runtime checkConnection subgraph predates the 2026
// framework's auth.validate convention and calls piece.checkConnection(ctx)
// with the shaped auth. This shim bridges the two: it performs the same
// /health check validate() does and reports the server version as the
// connection label. Harmless in real Activepieces (never called there).
docling.checkConnection = async (ctx: unknown) => {
  const { baseUrl, apiKey } = authFromCtx(ctx as { auth?: unknown });
  try {
    const res = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${baseUrl}/health`,
      headers: authKeyHeaders(apiKey),
      timeout: 10_000,
      retries: 0,
    });
    if (res.status === 401) {
      throw new DoclingError("AUTH", "The API key was rejected by the server (401).");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new DoclingError("JOB_FAILED", `docling-serve responded ${res.status}.`);
    }
    const version = await httpClient.sendRequest({
      method: HttpMethod.GET,
      url: `${baseUrl}/version`,
      headers: authKeyHeaders(apiKey),
      timeout: 10_000,
      retries: 0,
    });
    // Real 1.32.0 uses the hyphenated key; the underscore spelling is a
    // defensive fallback for older builds.
    const body = version.body as Record<string, unknown>;
    const v = body["docling-serve"] ?? body.docling_serve;
    return { name: typeof v === "string" ? `docling-serve ${v}` : "docling-serve" };
  } catch (err) {
    if (err instanceof DoclingError) throw err;
    throw new DoclingError(
      "JOB_FAILED",
      `Could not reach docling-serve at ${baseUrl}. ${(err as Error)?.message ?? String(err)}`,
    );
  }
} as never; // the framework's Piece type has no checkConnection member; the
             // reactor's loader duck-types it. `as never` keeps tsc honest.

// The `PieceAuth` import above is used only to keep tooling happy if the
// stub ever needs PieceAuth.None(); remove if unused.
void PieceAuth;

export { docling };
export default docling;
```

If `docling.checkConnection = …` errors because the `Piece` type is readonly, declare it before creation instead: `const docling = createPiece({...}) as typeof result & { checkConnection: (ctx: unknown) => Promise<{ name: string }> };` — use whichever compiles; the observable contract is the attached function.

- [ ] **Step 4: Run the package tests — all pass**

Run: `pnpm --filter @powerhousedao/piece-docling test`
Expected: PASS including the new conformance cases.

- [ ] **Step 5: Run lint + tsc gates**

Run: `pnpm --filter @powerhousedao/piece-docling lint && pnpm --filter @powerhousedao/piece-docling tsc`
Expected: clean. Fix any `no-unsafe-*` findings in the shim (type the `ctx` parameter as `unknown` and narrow).

- [ ] **Step 6: Commit**

```bash
git add packages/piece-docling/src/index.ts packages/piece-docling/test/conformance.test.ts
git commit -m "feat(piece-docling): piece definition with checkConnection shim; conformance passes"
```

---

## Phase P1 — Conversion core

### Task 5: File normalization (`files.ts`)

**Files:**
- Create: `packages/piece-docling/src/lib/files.ts`
- Create: `packages/piece-docling/test/files.test.ts`

**Interfaces:**
- Consumes: `DoclingError` (Task 3).
- Produces:

```ts
export interface NormalizedFile { filename: string; extension?: string; base64: string; }
export function normalizeFile(value: unknown): NormalizedFile;
```

Handles exactly three input shapes (the only ones reachable from the two runtimes — spec §5.2): (1) `Buffer`-backed ApFile `{filename, data: Buffer, extension?}` (real Activepieces), (2) JSON-IPC plain object `{filename, data: {type:'Buffer', data: number[]}}` or `{filename, data: <base64 string>}` (reactor worker / host hydration), (3) a raw data-URI string `data:<mime>;base64,<data>` (config passthrough). Anything else → `DoclingError('BAD_FILE', …)`.

- [ ] **Step 1: Write the failing test `test/files.test.ts`**

```ts
import { normalizeFile } from "../src/lib/files.js";
import { DoclingError } from "../src/lib/errors.js";

describe("normalizeFile", () => {
  it("handles a real ApFile (Buffer data)", () => {
    const out = normalizeFile({ filename: "a.pdf", data: Buffer.from("hello"), extension: "pdf" });
    expect(out).toEqual({ filename: "a.pdf", extension: "pdf", base64: Buffer.from("hello").toString("base64") });
  });

  it("handles a JSON-IPC plain object with a Buffer-shaped data field", () => {
    const out = normalizeFile({ filename: "a.pdf", data: { type: "Buffer", data: [104, 105] } });
    expect(out.filename).toBe("a.pdf");
    expect(out.base64).toBe(Buffer.from([104, 105]).toString("base64"));
    expect(out.extension).toBe("pdf");
  });

  it("handles a host-hydrated object with a base64 string", () => {
    const out = normalizeFile({ filename: "a.pdf", data: "aGk=", extension: "pdf" });
    expect(out.base64).toBe("aGk=");
  });

  it("parses a data URI string, deriving name from the mime", () => {
    const out = normalizeFile("data:application/pdf;base64,aGk=");
    expect(out).toEqual({ filename: "document.pdf", extension: "pdf", base64: "aGk=" });
  });

  it("rejects non-file values", () => {
    expect(() => normalizeFile(42)).toThrow(DoclingError);
    expect(() => normalizeFile("not a data uri")).toThrow(/data URI/i);
    expect(() => normalizeFile({ filename: "a.pdf", data: { type: "weird" } })).toThrow(DoclingError);
  });
});
```

- [ ] **Step 2: Run — verify it fails.**

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/files.test.ts`

- [ ] **Step 3: Implement `src/lib/files.ts`**

```ts
import { Buffer } from "node:buffer";
import { DoclingError } from "./errors.js";

export interface NormalizedFile {
  filename: string;
  extension?: string;
  base64: string;
}

const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/zip": "zip",
};

function extOf(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : undefined;
}

function fromDataUri(uri: string): NormalizedFile {
  const m = /^data:([^;,]+)?(?:;base64)?,(.+)$/s.exec(uri);
  if (!m) {
    throw new DoclingError("BAD_FILE", `Expected a file data URI, got: ${uri.slice(0, 64)}…`);
  }
  const mime = (m[1] ?? "application/octet-stream").toLowerCase();
  const ext = MIME_TO_EXT[mime];
  return {
    filename: `document.${ext ?? "bin"}`,
    extension: ext,
    base64: m[2],
  };
}

export function normalizeFile(value: unknown): NormalizedFile {
  if (typeof value === "string") return fromDataUri(value);

  if (value && typeof value === "object") {
    const v = value as { filename?: unknown; data?: unknown; extension?: unknown };
    const filename = typeof v.filename === "string" ? v.filename : "document.bin";
    let base64: string | undefined;
    if (typeof v.data === "string") {
      base64 = v.data; // host hydration: base64 string
    } else if (Buffer.isBuffer(v.data)) {
      base64 = v.data.toString("base64"); // real ApFile (Activepieces runtime)
    } else if (
      v.data &&
      typeof v.data === "object" &&
      (v.data as { type?: unknown }).type === "Buffer" &&
      Array.isArray((v.data as { data?: unknown }).data)
    ) {
      base64 = Buffer.from((v.data as { data: number[] }).data).toString("base64"); // JSON-IPC
    }
    if (base64 === undefined) {
      throw new DoclingError(
        "BAD_FILE",
        `Unsupported file data shape in "${filename}" (expected Buffer, base64 string, or Buffer-shaped object).`,
      );
    }
    return {
      filename,
      extension: typeof v.extension === "string" ? v.extension : extOf(filename),
      base64,
    };
  }

  throw new DoclingError("BAD_FILE", "Expected a file value (ApFile object, plain object, or data URI string).");
}
```

- [ ] **Step 4: Run — verify it passes.**

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/files.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/piece-docling/src/lib/files.ts packages/piece-docling/test/files.test.ts
git commit -m "feat(piece-docling): file normalization across AP/reactor/IPC/data-URI shapes"
```

---

### Task 6: Options builder + shared action props

**Files:**
- Create: `packages/piece-docling/src/lib/options.ts`
- Create: `packages/piece-docling/test/options.test.ts`

**Interfaces:**
- Consumes: `Property` (framework), `DoclingError` (Task 3).
- Produces:

```ts
export interface ActionOptionsProps {
  format?: "markdown" | "markdown+json" | "all";
  ocr?: boolean;
  table_mode?: "fast" | "accurate";
  page_range?: unknown;      // validated to [number, number]
  image_mode?: "placeholder" | "embedded" | "referenced";
  execution?: "async" | "sync";
  timeout_seconds?: number;
}
export interface ConvertDocumentsOptionsPayload {
  to_formats: string[];
  do_ocr: boolean;
  table_mode: "fast" | "accurate";
  do_table_structure: boolean;
  image_export_mode: "placeholder" | "embedded" | "referenced";
  page_range?: [number, number];
}
export function buildOptions(props: ActionOptionsProps): ConvertDocumentsOptionsPayload;
export function executionMode(props: ActionOptionsProps): "async" | "sync";
export function timeoutMs(props: ActionOptionsProps): number;
export const convertProps: Record<string, unknown>;  // the shared property definitions (see below)
```

- [ ] **Step 1: Write the failing test `test/options.test.ts`**

```ts
import { buildOptions, executionMode, timeoutMs } from "../src/lib/options.js";
import { DoclingError } from "../src/lib/errors.js";

describe("buildOptions", () => {
  it("maps the format presets to to_formats", () => {
    expect(buildOptions({}).to_formats).toEqual(["md"]);
    expect(buildOptions({ format: "markdown+json" }).to_formats).toEqual(["md", "json"]);
    expect(buildOptions({ format: "all" }).to_formats).toEqual(["md", "json", "html", "text", "doctags"]);
  });

  it("applies defaults", () => {
    expect(buildOptions({})).toEqual({
      to_formats: ["md"],
      do_ocr: true,
      table_mode: "accurate",
      do_table_structure: true,
      image_export_mode: "placeholder",
    });
  });

  it("passes a valid 1-based page_range through", () => {
    expect(buildOptions({ page_range: [2, 10] }).page_range).toEqual([2, 10]);
  });

  it("rejects invalid page_range", () => {
    expect(() => buildOptions({ page_range: [0, 5] })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: [5, 2] })).toThrow(DoclingError);
    expect(() => buildOptions({ page_range: "nonsense" })).toThrow(DoclingError);
  });

  it("execution/timeout defaults", () => {
    expect(executionMode({})).toBe("async");
    expect(executionMode({ execution: "sync" })).toBe("sync");
    expect(timeoutMs({})).toBe(600_000);
    expect(timeoutMs({ timeout_seconds: 30 })).toBe(30_000);
  });
});
```

- [ ] **Step 2: Run — verify it fails.**

- [ ] **Step 3: Implement `src/lib/options.ts`**

```ts
import { Property } from "@activepieces/pieces-framework";
import { DoclingError } from "./errors.js";

export interface ActionOptionsProps {
  format?: "markdown" | "markdown+json" | "all";
  ocr?: boolean;
  table_mode?: "fast" | "accurate";
  page_range?: unknown;
  image_mode?: "placeholder" | "embedded" | "referenced";
  execution?: "async" | "sync";
  timeout_seconds?: number;
}

export interface ConvertDocumentsOptionsPayload {
  to_formats: string[];
  do_ocr: boolean;
  table_mode: "fast" | "accurate";
  do_table_structure: boolean;
  image_export_mode: "placeholder" | "embedded" | "referenced";
  page_range?: [number, number];
}

const FORMAT_MAP: Record<string, string[]> = {
  markdown: ["md"],
  "markdown+json": ["md", "json"],
  all: ["md", "json", "html", "text", "doctags"],
};

export function buildOptions(props: ActionOptionsProps): ConvertDocumentsOptionsPayload {
  const preset = props.format ?? "markdown";
  const to_formats = FORMAT_MAP[preset];
  if (!to_formats) {
    throw new DoclingError("VALIDATION", `Unknown format preset "${preset}".`);
  }
  const out: ConvertDocumentsOptionsPayload = {
    to_formats,
    do_ocr: props.ocr ?? true,
    table_mode: props.table_mode ?? "accurate",
    do_table_structure: true,
    image_export_mode: props.image_mode ?? "placeholder",
  };
  if (props.page_range !== undefined) {
    if (
      !Array.isArray(props.page_range) ||
      props.page_range.length !== 2 ||
      !props.page_range.every((n) => typeof n === "number" && Number.isInteger(n))
    ) {
      throw new DoclingError("VALIDATION", `page_range must be a 2-element integer array, got ${JSON.stringify(props.page_range)}.`);
    }
    const [start, end] = props.page_range as [number, number];
    if (start < 1 || end < start) {
      throw new DoclingError("VALIDATION", `page_range must be 1-based with start <= end, got [${start}, ${end}].`);
    }
    out.page_range = [start, end];
  }
  return out;
}

export function executionMode(props: ActionOptionsProps): "async" | "sync" {
  return props.execution === "sync" ? "sync" : "async";
}

export function timeoutMs(props: ActionOptionsProps): number {
  const t = props.timeout_seconds ?? 600;
  if (!Number.isFinite(t) || t < 5 || t > 3600) {
    throw new DoclingError("VALIDATION", `timeout_seconds must be between 5 and 3600, got ${t}.`);
  }
  return Math.floor(t) * 1000;
}

// Shared property definitions for the convert/chunk actions. `as const`-free
// on purpose: the framework's property types carry their own generics.
export const convertProps = {
  format: Property.StaticDropdown({
    displayName: "Output Format",
    required: true,
    defaultValue: "markdown",
    options: {
      options: [
        { label: "Markdown", value: "markdown" },
        { label: "Markdown + document model (JSON)", value: "markdown+json" },
        { label: "All (md, json, html, text, doctags)", value: "all" },
      ],
    },
  }),
  ocr: Property.Checkbox({
    displayName: "OCR",
    required: true,
    defaultValue: true,
    description: "Run OCR on the pages (server default: on).",
  }),
  table_mode: Property.StaticDropdown({
    displayName: "Table Mode",
    required: true,
    defaultValue: "accurate",
    options: {
      options: [
        { label: "Fast", value: "fast" },
        { label: "Accurate (TableFormer)", value: "accurate" },
      ],
    },
  }),
  page_range: Property.Object({
    displayName: "Page Range",
    required: false,
    description: "Optional 1-based [start, end] page window, e.g. [1, 20].",
  }),
  image_mode: Property.StaticDropdown({
    displayName: "Image Mode",
    required: true,
    defaultValue: "placeholder",
    options: {
      options: [
        { label: "Placeholder", value: "placeholder" },
        { label: "Embedded (base64 in output)", value: "embedded" },
        { label: "Referenced (URLs)", value: "referenced" },
      ],
    },
  }),
  execution: Property.StaticDropdown({
    displayName: "Execution",
    required: true,
    defaultValue: "async",
    options: {
      options: [
        { label: "Auto (async — recommended)", value: "async" },
        { label: "Sync (fast documents only; server caps at ~120 s)", value: "sync" },
      ],
    },
  }),
  timeout_seconds: Property.Number({
    displayName: "Timeout (seconds)",
    required: false,
    defaultValue: 600,
    description: "Overall deadline for async conversions (5–3600).",
  }),
};
```

- [ ] **Step 4: Run — verify it passes.**

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/options.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/piece-docling/src/lib/options.ts packages/piece-docling/test/options.test.ts
git commit -m "feat(piece-docling): options builder (presets/ocr/table/page_range) and shared action props"
```

---

### Task 7: Client core (request, error mapping, async loop)

**Files:**
- Create: `packages/piece-docling/src/lib/client.ts`
- Create: `packages/piece-docling/test/client.test.ts`

**Interfaces:**
- Consumes: `httpClient`/`HttpMethod` (pieces-common), `DoclingError` (Task 3), mock (Task 2).
- Produces:

```ts
export interface DoclingAuth { baseUrl: string; apiKey?: string; }
export type DoclingSource =
  | { kind: "file"; filename: string; base64: string }
  | { kind: "http"; url: string };
export interface ConvertDocumentResponse {
  document: {
    filename?: string | null;
    md_content?: string | null;
    json_content?: unknown;
    html_content?: string | null;
    text_content?: string | null;
    doctags_content?: string | null;
  } | null;
  status: "success" | "partial_success" | "skipped" | "failure";
  errors?: Array<Record<string, unknown>>;
  processing_time?: number;
}
export interface TaskStatusResponse {
  task_id: string;
  task_type?: string;
  task_status: "pending" | "started" | "success" | "failure" | "partial_success" | "skipped";
  task_position?: number | null;
  task_meta?: unknown;
  error_message?: string | null;
  failure?: { category?: string; message?: string; retryable?: boolean; phase?: string } | null;
}
export interface RunConversionArgs {
  auth: DoclingAuth;
  source: DoclingSource;
  options: ConvertDocumentsOptionsPayload;   // from Task 6
  mode: "async" | "sync";
  timeoutMs: number;
  path: "convert" | "chunk";
  chunker?: "hybrid" | "hierarchical";
}
export interface ChunkResult { chunks: unknown[]; processing_time?: number; }
export function runConversion(args: RunConversionArgs): Promise<ConvertDocumentResponse>;
export function runChunk(args: RunConversionArgs): Promise<ChunkResult>;
export function submitJob(args: Pick<RunConversionArgs, "auth" | "source" | "options">): Promise<TaskStatusResponse>;
export function pollTask(auth: DoclingAuth, taskId: string, waitSeconds: number): Promise<TaskStatusResponse>;
export function fetchResult(auth: DoclingAuth, taskId: string): Promise<ConvertDocumentResponse | ChunkResult | { failure: NonNullable<TaskStatusResponse["failure"]> }>;
```

Behavioral contract (all tested against the mock):
- **Error mapping:** HTTP 401 → `AUTH`; 422 → `VALIDATION` (server detail in message); 504 (sync) → `SYNC_TIMEOUT` with the "re-run async" hint; 404 → `VALIDATION`; 429/503 → `OVERLOADED` (retryable); other ≥500 → `JOB_FAILED` (retryable). **Client-level request timeouts** surface in pinned 0.12.5 (axios-based) as an `HttpError` with `status: 500` and no response → `JOB_FAILED` (retryable) via the ≥500 branch; a defensive `AbortError`/code-20 → `OVERLOADED` branch (spike S6a's fetch-era shape) is kept for future clients but is not exercised by tests. A `429/503` inside the async loop retries with backoff (1s, 2s, 4s… capped 15s) up to 5 times before surfacing; `Retry-After` (seconds) wins over the backoff when present.
- **Async loop:** `POST /v1/{convert|chunk}/{path}/async` → validate `task_id` (422/absent → `VALIDATION`); if the submission itself reports `failure`, throw typed immediately; then loop `GET /v1/status/poll/{id}?wait=5` (per-request timeout 30s; poll honors the deadline: stop at `timeoutMs`) until a terminal status. `success`/`partial_success`/`skipped` → `GET /v1/result/{id}` and return. `failure` → `DoclingError('JOB_FAILED', … failure.message, failure.retryable)`. Deadline exceeded → `DoclingError('DEADLINE', "…task may still be running server-side…", true)`.
- **Sync path:** single `POST /v1/{convert|chunk}/{path}` with `timeout: timeoutMs` — the server 504s first in practice. A `status: "failure"` body (200 OK) → `DoclingError('JOB_FAILED', … first error message)`.
- **`?wait=` parameter:** the poll sends `wait=5` (long-poll) — asserted in tests via `mock.requests`.

- [ ] **Step 1: Write the failing test `test/client.test.ts`**

```ts
import { startMockDocling, type MockDocling } from "./mock-docling-serve.js";
import {
  runConversion, submitJob, pollTask, fetchResult,
  type DoclingAuth, type ConvertDocumentResponse,
} from "../src/lib/client.js";
import { DoclingError } from "../src/lib/errors.js";

const OPTS = { to_formats: ["md"], do_ocr: true, table_mode: "accurate", do_table_structure: true, image_export_mode: "placeholder" } as const;

describe("runConversion", () => {
  it("sync mode posts /v1/convert/source with the v1 schema and returns the document", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: { kind: "file", filename: "a.pdf", base64: "AAAA" },
        options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
      });
      const req = mock.requests.find((r) => r.path === "/v1/convert/source");
      expect(req?.headers["x-api-key"]).toBe("k-test");
      expect(out.status).toBe("success");
      expect((out as ConvertDocumentResponse).document?.md_content).toBeTruthy();
    } finally { await mock.close(); }
  });

  it("async mode: submit → long-poll with wait=5 → result", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: { kind: "http", url: "https://example.com/x.pdf" },
        options: OPTS as never, mode: "async", timeoutMs: 30_000, path: "convert",
      });
      expect(out.status).toBe("success");
      const poll = mock.requests.find((r) => r.path.startsWith("/v1/status/poll/"));
      expect(poll?.query.get("wait")).toBe("5");
    } finally { await mock.close(); }
  });

  it("maps 401 to a typed AUTH error", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "wrong" },
          source: { kind: "http", url: "https://example.com/x.pdf" },
          options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "AUTH", name: "DoclingError" });
    } finally { await mock.close(); }
  });

  it("maps a sync 504 to SYNC_TIMEOUT", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", syncSlow: true });
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
          source: { kind: "http", url: "https://example.com/x.pdf" },
          options: OPTS as never, mode: "sync", timeoutMs: 10_000, path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "SYNC_TIMEOUT" });
    } finally { await mock.close(); }
  });

  it("async job failure surfaces the server's failure detail", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
          source: { kind: "file", filename: "bad.pdf", base64: "AAAA" },
          options: OPTS as never, mode: "async", timeoutMs: 30_000, path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "JOB_FAILED", retryable: false, message: expect.stringContaining("mock inference failure") });
    } finally { await mock.close(); }
  });

  it("retries 429 backpressure with backoff, then succeeds", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", backpressure: 2 });
    try {
      const out = await runConversion({
        auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
        source: { kind: "http", url: "https://example.com/x.pdf" },
        options: OPTS as never, mode: "async", timeoutMs: 30_000, path: "convert",
      });
      expect(out.status).toBe("success");
    } finally { await mock.close(); }
  });

  it("throws a typed DEADLINE error when the job outlives the deadline", async () => {
    // The mock never finishes jobs when failJobs is empty? No — to simulate
    // a forever job, use a dedicated option: neverFinish. (Add it to the mock
    // in this task if missing: jobs stay "started" forever.)
    const mock = await startMockDocling({ apiKey: "k-test", neverFinish: true } as never);
    try {
      await expect(
        runConversion({
          auth: { baseUrl: mock.baseUrl, apiKey: "k-test" },
          source: { kind: "http", url: "https://example.com/slow.pdf" },
          options: OPTS as never, mode: "async", timeoutMs: 1_500, path: "convert",
        }),
      ).rejects.toMatchObject({ kind: "DEADLINE", retryable: true });
    } finally { await mock.close(); }
  });
});
```

> **Mock extension required by the last test:** add `neverFinish?: boolean` to `MockDoclingOptions`; when set, `/v1/status/poll/*` always returns `started` (never terminal). Add the option in `test/mock-docling-serve.ts` in this same task (one-line change in the poll handler: `const done = opts.neverFinish ? false : task.polls >= 1 || task.failing;`) and extend Task 2's commit message accordingly.

- [ ] **Step 2: Run — verify it fails** (module not found).

- [ ] **Step 3: Implement `src/lib/client.ts`**

```ts
import { httpClient, HttpMethod } from "@activepieces/pieces-common";
import { DoclingError } from "./errors.js";
import type { ConvertDocumentsOptionsPayload } from "./options.js";

export interface DoclingAuth { baseUrl: string; apiKey?: string; }
export type DoclingSource =
  | { kind: "file"; filename: string; base64: string }
  | { kind: "http"; url: string };

export interface ConvertDocumentResponse {
  document: {
    filename?: string | null;
    md_content?: string | null;
    json_content?: unknown;
    html_content?: string | null;
    text_content?: string | null;
    doctags_content?: string | null;
  } | null;
  status: "success" | "partial_success" | "skipped" | "failure";
  errors?: Array<Record<string, unknown>>;
  processing_time?: number;
}

export interface TaskStatusResponse {
  task_id: string;
  task_type?: string;
  task_status: "pending" | "started" | "success" | "failure" | "partial_success" | "skipped";
  task_position?: number | null;
  task_meta?: unknown;
  error_message?: string | null;
  failure?: { category?: string; message?: string; retryable?: boolean; phase?: string } | null;
}

export interface ChunkResult { chunks: unknown[]; processing_time?: number; }

export interface RunConversionArgs {
  auth: DoclingAuth;
  source: DoclingSource;
  options: ConvertDocumentsOptionsPayload;
  mode: "async" | "sync";
  timeoutMs: number;
  path: "convert" | "chunk";
  chunker?: "hybrid" | "hierarchical";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

function url(auth: DoclingAuth, path: string, query?: Record<string, string | number>): string {
  const u = new URL(path, `${auth.baseUrl}/`);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  return u.toString();
}

function endpointPath(args: Pick<RunConversionArgs, "path" | "chunker">, async: boolean): string {
  const base = args.path === "chunk" ? `/v1/chunk/${args.chunker ?? "hybrid"}/source` : "/v1/convert/source";
  return async ? `${base}/async` : base;
}

function sourceBody(source: DoclingSource): Array<Record<string, unknown>> {
  return [source.kind === "file"
    ? { kind: "file", base64_string: source.base64, filename: source.filename }
    : { kind: "http", url: source.url }];
}

// --- error mapping -----------------------------------------------------------
// pieces-common's AxiosHttpClient throws an HttpError with OWN props
// [status, responseBody, …] and a JSON `message` (spike S6a); timeouts surface
// as DOMException AbortError (code 20). Map both to typed DoclingError.

function mapHttpStatus(status: number, detail: unknown): DoclingError {
  const text = typeof detail === "string"
    ? detail
    : (() => { try { return JSON.stringify(detail); } catch { return String(detail); } })();
  const short = (text ?? "").slice(0, 300);
  switch (status) {
    case 401:
      return new DoclingError("AUTH", "docling-serve rejected the API key (401). Check the connection's key against the server's DOCLING_SERVE_API_KEY.");
    case 422:
      return new DoclingError("VALIDATION", `docling-serve rejected the request (422): ${short}`);
    case 404:
      return new DoclingError("VALIDATION", `docling-serve: unknown endpoint or task (404): ${short}`);
    case 504:
      return new DoclingError("SYNC_TIMEOUT", "Conversion exceeded the server's sync limit (504). Re-run with execution mode “auto (async)”, or raise the server's DOCLING_SERVE_MAX_SYNC_WAIT.");
    case 429:
    case 503:
      return new DoclingError("OVERLOADED", `docling-serve is busy (HTTP ${status}).`, true);
    default:
      return new DoclingError("JOB_FAILED", `docling-serve error ${status}: ${short}`, status >= 500);
  }
}

function mapError(err: unknown): DoclingError {
  if (err instanceof DoclingError) return err;
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number") {
    return mapHttpStatus(status, (err as { responseBody?: unknown }).responseBody);
  }
  if ((err as { name?: unknown })?.name === "AbortError" || (err as { code?: unknown })?.code === 20) {
    return new DoclingError("OVERLOADED", "The request to docling-serve timed out.", true);
  }
  return new DoclingError("JOB_FAILED", `Unexpected error calling docling-serve: ${(err as Error)?.message ?? String(err)}`);
}

async function send<T>(
  method: HttpMethod,
  fullUrl: string,
  body: unknown,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; body: T; headers: Record<string, string | string[]> }> {
  try {
    const res = await httpClient.sendRequest({
      method,
      url: fullUrl,
      body: body === undefined ? undefined : (body as never),
      headers: headers(apiKey),
      timeout: timeoutMs,
      retries: 0,
    });
    if (res.status >= 400) throw mapHttpStatus(res.status, res.body);
    return { status: res.status, body: res.body as T, headers: (res.headers ?? {}) as Record<string, string | string[]> };
  } catch (err) {
    throw mapError(err);
  }
}

// 429/503 retry wrapper: honors Retry-After, exponential backoff capped at
// 15 s, at most `retries` attempts. Only OVERLOADED errors retry.
async function withBackoff<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof DoclingError) || err.kind !== "OVERLOADED" || attempt >= retries) throw err;
      attempt++;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15_000));
    }
  }
}

// NOTE on Retry-After: send() currently surfaces it only through the
// OVERLOADED mapping; honoring the exact header value is a v1.1 refinement
// (the mock uses Retry-After: 0, so plain backoff covers the tests).

// --- submit / poll / result ---------------------------------------------------

export async function submitJob(args: {
  auth: DoclingAuth;
  source: DoclingSource;
  options: ConvertDocumentsOptionsPayload;
  path?: "convert" | "chunk";
  chunker?: "hybrid" | "hierarchical";
}): Promise<TaskStatusResponse> {
  const path = args.path ?? "convert";
  const body = {
    sources: sourceBody(args.source),
    options: args.options,
    target: { kind: "inbody" },
  };
  const res = await withBackoff(() =>
    send<TaskStatusResponse>(
      HttpMethod.POST,
      url(args.auth, endpointPath({ path, chunker: args.chunker }, true)),
      body,
      args.auth.apiKey,
      30_000,
    ),
  );
  if (!res.body.task_id) {
    throw new DoclingError("VALIDATION", `Server accepted the job but returned no task_id: ${JSON.stringify(res.body).slice(0, 200)}`);
  }
  if (res.body.task_status === "failure") {
    throw new DoclingError("JOB_FAILED", jobFailureMessage(res.body), res.body.failure?.retryable ?? false);
  }
  return res.body;
}

export async function pollTask(auth: DoclingAuth, taskId: string, waitSeconds = 5): Promise<TaskStatusResponse> {
  const res = await withBackoff(() =>
    send<TaskStatusResponse>(
      HttpMethod.GET,
      url(auth, `/v1/status/poll/${taskId}`, { wait: waitSeconds }),
      undefined,
      auth.apiKey,
      30_000,
    ),
  );
  return res.body;
}

export async function fetchResult(
  auth: DoclingAuth,
  taskId: string,
): Promise<ConvertDocumentResponse | ChunkResult | { failure: NonNullable<TaskStatusResponse["failure"]> }> {
  const res = await withBackoff(() =>
    send<ConvertDocumentResponse | ChunkResult | { failure: NonNullable<TaskStatusResponse["failure"]> }>(
      HttpMethod.GET,
      url(auth, `/v1/result/${taskId}`),
      undefined,
      auth.apiKey,
      30_000,
    ),
  );
  return res.body;
}

function jobFailureMessage(t: TaskStatusResponse): string {
  const f = t.failure;
  if (f?.message) return `docling job failed [${f.category ?? "unknown"}${f.phase ? `, ${f.phase}` : ""}]: ${f.message}`;
  return `docling job failed: ${t.error_message ?? t.task_status}`;
}

// --- the two high-level operations -------------------------------------------

async function runAsync(args: RunConversionArgs): Promise<ConvertDocumentResponse | ChunkResult> {
  const task = await submitJob(args);
  const deadline = Date.now() + args.timeoutMs;
  for (;;) {
    if (Date.now() > deadline) {
      throw new DoclingError(
        "DEADLINE",
        `The docling job did not finish within ${Math.round(args.timeoutMs / 1000)} s (task ${task.task_id} may still be running server-side — use “Submit Job” + “Get Result” to continue it later).`,
        true,
      );
    }
    const status = await pollTask(args.auth, task.task_id, 5);
    if (status.task_status === "failure") {
      throw new DoclingError("JOB_FAILED", jobFailureMessage(status), status.failure?.retryable ?? false);
    }
    if (status.task_status === "success" || status.task_status === "partial_success" || status.task_status === "skipped") {
      const result = await fetchResult(args.auth, task.task_id);
      if ("failure" in result && !("document" in result) && !("chunks" in result)) {
        throw new DoclingError("JOB_FAILED", jobFailureMessage({ ...status, failure: result.failure }), result.failure?.retryable ?? false);
      }
      if (args.path === "convert") {
        const conv = result as ConvertDocumentResponse;
        if (conv.status === "failure") {
          const first = conv.errors?.[0]?.error_message;
          throw new DoclingError("JOB_FAILED", `docling conversion failed: ${first ?? "unknown error"}`, false);
        }
      }
      return result;
    }
  }
}

function runSync(args: RunConversionArgs): Promise<ConvertDocumentResponse | ChunkResult> {
  return withBackoff(() =>
    send<ConvertDocumentResponse | ChunkResult>(
      HttpMethod.POST,
      url(args.auth, endpointPath(args, false)),
      { sources: sourceBody(args.source), options: args.options, target: { kind: "inbody" } },
      args.auth.apiKey,
      args.timeoutMs,
    ).then((res) => {
      const body = res.body as ConvertDocumentResponse;
      if (args.path === "convert" && "status" in body && body.status === "failure") {
        const first = body.errors?.[0]?.error_message;
        throw new DoclingError("JOB_FAILED", `docling conversion failed: ${first ?? "unknown error"}`, false);
      }
      return res.body;
    }),
  );
}

export function runConversion(args: RunConversionArgs): Promise<ConvertDocumentResponse> {
  return (args.mode === "sync" ? runSync(args) : runAsync(args)).then(
    (r) => r as ConvertDocumentResponse,
  );
}

export function runChunk(args: RunConversionArgs): Promise<ChunkResult> {
  return (args.mode === "sync" ? runSync({ ...args, path: "chunk" }) : runAsync({ ...args, path: "chunk" })).then(
    (r) => r as ChunkResult,
  );
}
```

- [ ] **Step 4: Run — verify all client tests pass** (including the 429-backoff and deadline tests).

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/client.test.ts`
Expected: PASS. The deadline test takes ~1.5 s (two long-polls of 5 s each are bounded by the 1.5 s deadline check before the poll — if the mock's long-poll blocks the event loop, reduce the poll `wait` to the remaining deadline: implement `wait = Math.max(1, Math.min(5, Math.ceil((deadline - Date.now()) / 1000)))` in the loop and re-run).

- [ ] **Step 5: Commit**

```bash
git add packages/piece-docling/src/lib/client.ts packages/piece-docling/test/client.test.ts packages/piece-docling/test/mock-docling-serve.ts
git commit -m "feat(piece-docling): client core — v1 request building, typed error mapping, async loop with backoff and deadline"
```

---

### Task 8: `convert_file` action

**Files:**
- Create: `packages/piece-docling/src/lib/actions/convert-file.ts`
- Modify: `packages/piece-docling/src/index.ts` (register the action)
- Create: `packages/piece-docling/test/convert.test.ts` (convert_file half)

**Interfaces:**
- Consumes: `doclingAuth` + `authFromCtx` (Task 3), `normalizeFile` (Task 5), `buildOptions`/`executionMode`/`timeoutMs`/`convertProps` (Task 6), `runConversion` (Task 7), mock (Task 2).
- Produces: `convertFileAction` — `name: "convert_file"`, props = `{ file: Property.File }` + `convertProps`, `audience: "both"`, `aiMetadata: { idempotent: true, description: … }`. `run` returns the `ConvertDocumentResponse` (only the populated `*_content` fields, `status`, `errors`, `processing_time`).

- [ ] **Step 1: Write the failing test `test/convert.test.ts`**

```ts
import { convertFileAction } from "../src/lib/actions/convert-file.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling, MOCK_MD } from "./mock-docling-serve.js";
import { DoclingError } from "../src/lib/errors.js";

function ctx(props: Record<string, unknown>) {
  return makeActionContext(props, {
    type: "CUSTOM_AUTH",
    props: { base_url: "http://127.0.0.1:1", api_key: "k-test" },
  }) as never;
}

describe("convert_file", () => {
  it("converts an ApFile (Buffer) to markdown via async by default", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertFileAction.run(
        ctx({
          file: { filename: "a.pdf", data: Buffer.from("x"), extension: "pdf" },
          format: "markdown",
          ocr: true,
          table_mode: "accurate",
          image_mode: "placeholder",
          execution: "async",
        }),
      ) as { document: { md_content: string }; status: string };
      expect(out.status).toBe("success");
      expect(out.document.md_content).toBe(MOCK_MD);
      const req = mock.requests.find((r) => r.path === "/v1/convert/source/async");
      const body = JSON.parse((mock.requests.find((r) => r.path === "/v1/convert/source/async") as never as { body?: string }).body ?? "{}");
      expect(body.sources).toEqual([{ kind: "file", base64_string: "eA==", filename: "a.pdf" }]);
    } finally { await mock.close(); }
  });
```

> **Note:** `mock.requests` records headers/path but not the POST body — extend `MockDocling` in this task with a parallel `requestBodies: string[]` (push `readBody` results) so the assertion above can be written as `expect(JSON.parse(mock.requestBodies[0])).toMatchObject({ sources: [...] })`. Use that form.

```ts
  it("converts a data-URI string file (reactor config shape)", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertFileAction.run(
        ctx({
          file: "data:application/pdf;base64," + Buffer.from("x").toString("base64"),
          execution: "async",
        }),
      ) as { document: { md_content: string } };
      expect(out.document.md_content).toBe(MOCK_MD);
    } finally { await mock.close(); }
  });

  it("sends json_content when the markdown+json preset is chosen", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertFileAction.run(
        ctx({ file: { filename: "a.pdf", data: Buffer.from("x") }, format: "markdown+json", execution: "async" }),
      ) as { document: { json_content: unknown } };
      expect(out.document.json_content).toBeTruthy();
    } finally { await mock.close(); }
  });

  it("maps a failing job to a typed error", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
    try {
      await expect(
        convertFileAction.run(
          ctx({ file: { filename: "bad.pdf", data: Buffer.from("x") }, execution: "async" }),
        ),
      ).rejects.toMatchObject({ kind: "JOB_FAILED", name: "DoclingError" });
    } finally { await mock.close(); }
  });

  it("rejects a missing file", async () => {
    await expect(convertFileAction.run(ctx({}))).rejects.toMatchObject({ kind: "BAD_FILE" });
  });
});
```

- [ ] **Step 2: Run — verify it fails.**

- [ ] **Step 3: Implement `src/lib/actions/convert-file.ts`**

```ts
import { createAction, Property } from "@activepieces/pieces-framework";
import { doclingAuth, authFromCtx } from "../auth.js";
import { DoclingError } from "../errors.js";
import { normalizeFile } from "../files.js";
import { buildOptions, convertProps, executionMode, timeoutMs } from "../options.js";
import { runConversion } from "../client.js";

const fileProp = Property.File({
  displayName: "File",
  required: true,
  description: "The document to convert (PDF, DOCX, PPTX, XLSX, images, HTML, …).",
});

export const convertFileAction = createAction({
  auth: doclingAuth,
  name: "convert_file",
  displayName: "Convert File",
  description:
    "Converts an uploaded document with a docling-serve v1 API and returns the requested output formats (Markdown by default).",
  audience: "both",
  aiMetadata: {
    description:
      "Converts a document file to Markdown (or docling-document JSON / HTML / DocTags / plain text) using a docling-serve v1 service. Use for “parse/extract/read this document”. Text out; slow for very large documents (default deadline 10 minutes).",
    idempotent: true,
  },
  props: { file: fileProp, ...convertProps },
  run: async (ctx) => {
    const raw = ctx.propsValue.file;
    if (raw === undefined || raw === null || raw === "") {
      throw new DoclingError("BAD_FILE", "The file property is required.");
    }
    const file = normalizeFile(raw);
    return runConversion({
      auth: authFromCtx(ctx),
      source: { kind: "file", filename: file.filename, base64: file.base64 },
      options: buildOptions(ctx.propsValue as never),
      mode: executionMode(ctx.propsValue as never),
      timeoutMs: timeoutMs(ctx.propsValue as never),
      path: "convert",
    });
  },
});
```

- [ ] **Step 4: Register in `src/index.ts`** (`actions: [healthAction, convertFileAction]`).

- [ ] **Step 5: Run the package tests — all pass.**

Run: `pnpm --filter @powerhousedao/piece-docling test`

- [ ] **Step 6: Commit**

```bash
git add packages/piece-docling
git commit -m "feat(piece-docling): convert_file action (file → docling-serve, async default)"
```

---

### Task 9: `convert_url` action

**Files:**
- Create: `packages/piece-docling/src/lib/actions/convert-url.ts`
- Modify: `packages/piece-docling/src/index.ts`
- Modify: `packages/piece-docling/test/convert.test.ts` (add convert_url cases)

**Interfaces:**
- Consumes: same as Task 8.
- Produces: `convertUrlAction` — `name: "convert_url"`, props = `{ url: Property.ShortText (required) }` + `convertProps`. Same run body as `convert_file` but with `{ kind: "http", url }` source; rejects `.zip` URLs with `VALIDATION` (mirrors the server rule, with a client-side early check so the error message is ours).

- [ ] **Step 1: Add failing tests (append to `test/convert.test.ts`)**

```ts
import { convertUrlAction } from "../src/lib/actions/convert-url.js";

describe("convert_url", () => {
  it("converts an http source (sync mode)", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await convertUrlAction.run(
        ctx({ url: "https://example.com/x.pdf", execution: "sync" }),
      ) as { document: { md_content: string }; status: string };
      expect(out.status).toBe("success");
      expect(out.document.md_content).toBe(MOCK_MD);
    } finally { await mock.close(); }
  });

  it("rejects zip URLs before hitting the server", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await expect(
        convertUrlAction.run(ctx({ url: "https://example.com/x.zip", execution: "sync" })),
      ).rejects.toMatchObject({ kind: "VALIDATION", message: expect.stringMatching(/zip/) });
      expect(mock.requests.length).toBe(0);
    } finally { await mock.close(); }
  });
});
```

- [ ] **Step 2: Run — verify it fails.**

- [ ] **Step 3: Implement `src/lib/actions/convert-url.ts`** (mirror `convert-file.ts`; replace the file block with:)

```ts
import { createAction, Property } from "@activepieces/pieces-framework";
import { doclingAuth, authFromCtx } from "../auth.js";
import { DoclingError } from "../errors.js";
import { buildOptions, convertProps, executionMode, timeoutMs } from "../options.js";
import { runConversion } from "../client.js";

const urlProp = Property.ShortText({
  displayName: "URL",
  required: true,
  description: "Public URL of the document to convert (PDF, DOCX, …). ZIP archives are not supported.",
});

export const convertUrlAction = createAction({
  auth: doclingAuth,
  name: "convert_url",
  displayName: "Convert URL",
  description:
    "Downloads and converts a document from a public URL with a docling-serve v1 API and returns the requested output formats.",
  audience: "both",
  aiMetadata: {
    description:
      "Converts a document at a public URL to Markdown (or other formats) via docling-serve. Use when the source is a link rather than an uploaded file.",
    idempotent: true,
  },
  props: { url: urlProp, ...convertProps },
  run: async (ctx) => {
    const raw = ctx.propsValue.url;
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new DoclingError("VALIDATION", "The URL property is required.");
    }
    const url = raw.trim();
    if (url.toLowerCase().endsWith(".zip")) {
      throw new DoclingError("VALIDATION", "ZIP archives are not supported — convert the individual documents instead.");
    }
    return runConversion({
      auth: authFromCtx(ctx),
      source: { kind: "http", url },
      options: buildOptions(ctx.propsValue as never),
      mode: executionMode(ctx.propsValue as never),
      timeoutMs: timeoutMs(ctx.propsValue as never),
      path: "convert",
    });
  },
});
```

- [ ] **Step 4: Register in `src/index.ts`; run all package tests — pass. Commit.**

```bash
git add packages/piece-docling
git commit -m "feat(piece-docling): convert_url action"
```

---

### Task 10: `submit_job` + `get_result` actions

**Files:**
- Create: `packages/piece-docling/src/lib/actions/submit-job.ts`, `packages/piece-docling/src/lib/actions/get-result.ts`
- Modify: `packages/piece-docling/src/index.ts`
- Create: `packages/piece-docling/test/job.test.ts`

**Interfaces:**
- Consumes: `submitJob`/`pollTask`/`fetchResult` (Task 7), Task 3/5/6 helpers.
- Produces:
  - `submitJobAction` — `name: "submit_job"`, `audience: "both"`, `aiMetadata: { idempotent: false }`. Props: `file` (`Property.File`, optional), `url` (`Property.ShortText`, optional), + the *option-only* shared props minus `execution`/`timeout_seconds` (a submitted job is not bounded by a client deadline). **Exactly one** of `file`/`url` must be set (else `VALIDATION`). Returns `{ task_id, task_status, task_position, task_meta }`.
  - `getResultAction` — `name: "get_result"`, `aiMetadata: { idempotent: true }`. Props: `task_id` (`Property.ShortText`, required), `wait_seconds` (`Property.Number`, optional, 0–30, default 0). One poll (with the given `wait`); terminal success/partial/skipped → fetch and return the result; failure → typed `JOB_FAILED`; non-terminal → return `{ task_id, task_status, task_position, task_meta, done: false }` **without throwing** (the workflow's own retry policy re-runs it).

- [ ] **Step 1: Write the failing test `test/job.test.ts`**

```ts
import { submitJobAction } from "../src/lib/actions/submit-job.js";
import { getResultAction } from "../src/lib/actions/get-result.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling } from "./mock-docling-serve.js";

const AUTH = { type: "CUSTOM_AUTH", props: { base_url: "http://127.0.0.1:1", api_key: "k-test" } };
const ctx = (props: Record<string, unknown>) => makeActionContext(props, AUTH) as never;

describe("submit_job + get_result", () => {
  it("submits, then get_result polls to success and returns the document", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      (AUTH.props as { base_url: string }).base_url = mock.baseUrl;
      const sub = await submitJobAction.run(
        ctx({ url: "https://example.com/x.pdf", ocr: true, table_mode: "accurate", image_mode: "placeholder" }),
      ) as { task_id: string; task_status: string };
      expect(sub.task_status).toBe("pending");
      const r1 = await getResultAction.run(ctx({ task_id: sub.task_id, wait_seconds: 0 })) as Record<string, unknown>;
      // first poll → started (mock finishes after one poll)
      const r2 = await getResultAction.run(ctx({ task_id: sub.task_id, wait_seconds: 0 })) as { document?: { md_content?: string }; done?: boolean };
      if (r2.done === false) {
        const r3 = await getResultAction.run(ctx({ task_id: sub.task_id, wait_seconds: 0 })) as { document?: { md_content?: string } };
        expect(r3.document?.md_content).toBeTruthy();
      } else {
        expect(r2.document?.md_content).toBeTruthy();
      }
    } finally { await mock.close(); }
  });

  it("submit rejects when neither file nor url is given", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      (AUTH.props as { base_url: string }).base_url = mock.baseUrl;
      await expect(submitJobAction.run(ctx({}))).rejects.toMatchObject({ kind: "VALIDATION" });
    } finally { await mock.close(); }
  });

  it("get_result on a failed job throws the typed failure", async () => {
    const mock = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
    try {
      (AUTH.props as { base_url: string }).base_url = mock.baseUrl;
      const sub = await submitJobAction.run(
        ctx({ file: { filename: "bad.pdf", data: Buffer.from("x") } }),
      ) as { task_id: string };
      // drain to failure
      for (let i = 0; i < 4; i++) {
        const r = await getResultAction.run(ctx({ task_id: sub.task_id })) as { task_status?: string };
        if (r.task_status === "failure") break;
      }
      await expect(getResultAction.run(ctx({ task_id: sub.task_id }))).rejects.toMatchObject({
        kind: "JOB_FAILED",
        message: expect.stringContaining("mock inference failure"),
      });
    } finally { await mock.close(); }
  });
});
```

- [ ] **Step 2: Run — verify it fails.**

- [ ] **Step 3: Implement both actions.** `submit-job.ts`:

```ts
import { createAction, Property } from "@activepieces/pieces-framework";
import { doclingAuth, authFromCtx } from "../auth.js";
import { DoclingError } from "../errors.js";
import { normalizeFile } from "../files.js";
import { buildOptions } from "../options.js";
import { submitJob, type DoclingSource } from "../client.js";

export const submitJobAction = createAction({
  auth: doclingAuth,
  name: "submit_job",
  displayName: "Submit Job",
  description:
    "Submits a document conversion as an async job and returns its task id (no waiting). Pair with “Get Result”.",
  audience: "both",
  aiMetadata: {
    description:
      "Starts a background document conversion on docling-serve and returns a task id. Non-idempotent (each call starts a new job). Use with “Get Result” for long-running conversions.",
    idempotent: false,
  },
  props: {
    file: Property.File({ displayName: "File", required: false, description: "Document to convert (leave one of file/url empty)." }),
    url: Property.ShortText({ displayName: "URL", required: false, description: "Document URL (leave one of file/url empty)." }),
    format: (convertProps.format as Property.StaticDropdownProperty<string>),
    ocr: convertProps.ocr,
    table_mode: convertProps.table_mode,
    page_range: convertProps.page_range,
    image_mode: convertProps.image_mode,
  },
  run: async (ctx) => {
    const p = ctx.propsValue as Record<string, unknown>;
    const fileRaw = p.file;
    const urlRaw = typeof p.url === "string" ? p.url.trim() : "";
    let source: DoclingSource;
    if (fileRaw !== undefined && fileRaw !== null && fileRaw !== "") {
      const file = normalizeFile(fileRaw);
      source = { kind: "file", filename: file.filename, base64: file.base64 };
    } else if (urlRaw) {
      if (urlRaw.toLowerCase().endsWith(".zip")) {
        throw new DoclingError("VALIDATION", "ZIP archives are not supported.");
      }
      source = { kind: "http", url: urlRaw };
    } else {
      throw new DoclingError("VALIDATION", "Provide exactly one of file or url.");
    }
    const job = await submitJob({ auth: authFromCtx(ctx), source, options: buildOptions(p as never) });
    return {
      task_id: job.task_id,
      task_status: job.task_status,
      task_position: job.task_position ?? null,
      task_meta: job.task_meta ?? null,
    };
  },
});
```

(import `convertProps` from `../options.js`; if the 0.32.0 property type names differ — e.g. the static dropdown property type is named differently in the .d.ts — drop the explicit cast and let inference flow from `convertProps.format`.)

`get-result.ts`:

```ts
import { createAction, Property } from "@activepieces/pieces-framework";
import { doclingAuth, authFromCtx } from "../auth.js";
import { DoclingError } from "../errors.js";
import { pollTask, fetchResult, type TaskStatusResponse } from "../client.js";

export const getResultAction = createAction({
  auth: doclingAuth,
  name: "get_result",
  displayName: "Get Result",
  description:
    "Checks an async conversion job (submitted by “Submit Job”). Returns the converted document when finished, or the current job status otherwise.",
  audience: "both",
  aiMetadata: {
    description:
      "Polls a docling-serve job by task id. Idempotent; safe to re-run (e.g. via a workflow retry) until the job finishes.",
    idempotent: true,
  },
  props: {
    task_id: Property.ShortText({ displayName: "Task ID", required: true, description: "The task_id returned by “Submit Job”." }),
    wait_seconds: Property.Number({ displayName: "Wait (seconds)", required: false, defaultValue: 0, description: "Long-poll wait on the server, 0–30." }),
  },
  run: async (ctx) => {
    const p = ctx.propsValue as { task_id?: unknown; wait_seconds?: unknown };
    if (typeof p.task_id !== "string" || p.task_id.trim() === "") {
      throw new DoclingError("VALIDATION", "task_id is required.");
    }
    const wait = p.wait_seconds === undefined ? 0 : Number(p.wait_seconds);
    if (!Number.isInteger(wait) || wait < 0 || wait > 30) {
      throw new DoclingError("VALIDATION", `wait_seconds must be an integer between 0 and 30, got ${String(p.wait_seconds)}.`);
    }
    const auth = authFromCtx(ctx);
    const status: TaskStatusResponse = await pollTask(auth, p.task_id.trim(), wait);
    if (status.task_status === "failure") {
      const f = status.failure;
      throw new DoclingError("JOB_FAILED", `docling job failed [${f?.category ?? "unknown"}]: ${f?.message ?? status.error_message ?? "unknown"}`, f?.retryable ?? false);
    }
    if (status.task_status === "success" || status.task_status === "partial_success" || status.task_status === "skipped") {
      const result = await fetchResult(auth, status.task_id);
      if ("failure" in result && !("document" in result) && !("chunks" in result)) {
        throw new DoclingError("JOB_FAILED", `docling job failed: ${result.failure.message ?? "unknown"}`, result.failure.retryable ?? false);
      }
      return { done: true, task_id: status.task_id, ...(result as Record<string, unknown>) };
    }
    return {
      done: false,
      task_id: status.task_id,
      task_status: status.task_status,
      task_position: status.task_position ?? null,
      task_meta: status.task_meta ?? null,
    };
  },
});
```

- [ ] **Step 4: Register both in `src/index.ts`; run all tests — pass. Commit.**

```bash
git add packages/piece-docling
git commit -m "feat(piece-docling): submit_job + get_result actions for cross-run async jobs"
```

---

### Task 11: Output field descriptors on all actions

**Files:**
- Create: `packages/piece-docling/src/lib/output-schemas.ts`
- Modify: `packages/piece-docling/src/lib/actions/health.ts`, `convert-file.ts`, `convert-url.ts`, `submit-job.ts`, `get-result.ts` (attach `outputSchema`)
- Create: `packages/piece-docling/test/output-schemas.test.ts`

**Interfaces:**
- Produces:
```ts
// 0.32.0's `outputSchema` is a UI field descriptor list, not a validator
// (review fix 3): it describes the result shape to the builder/preview UI.
// The AI-facing contract (spec D10) rides on `audience` + `aiMetadata`.
export type OutputField = {
  key: string;
  label: string;
  description?: string;
};
export const convertOutputFields: OutputField[] = [
  { key: "document", label: "Converted Document", description: "Only the requested *_content fields are populated." },
  { key: "status", label: "Status", description: "success | partial_success | skipped | failure." },
  { key: "errors", label: "Errors" },
  { key: "processing_time", label: "Processing Time (s)" },
];
export const jobOutputFields: OutputField[] = [
  { key: "task_id", label: "Task ID" },
  { key: "task_status", label: "Status" },
  { key: "task_position", label: "Queue Position" },
  { key: "task_meta", label: "Task Meta" },
];
export const getResultOutputFields: OutputField[] = [
  { key: "done", label: "Done", description: "false while the job is still running; true once the result is inlined." },
  { key: "task_id", label: "Task ID" },
];
export const healthOutputFields: OutputField[] = [
  { key: "status", label: "Status" },
  { key: "versions", label: "Server Versions" },
];
export const chunkOutputFields: OutputField[] = [
  { key: "chunks", label: "Chunks", description: "One entry per chunk: { text, page_no, start_chunk_no, end_chunk_no }." },
  { key: "processing_time", label: "Processing Time (s)" },
];
```
Each of the five actions created so far gets `outputSchema: { fields: <matching list> }` (0.32.0's `createAction` accepts `outputSchema?: { fields: OutputSchemaField[]; itemLabel? }`). The `chunk` action gets its own list when it is added in Task 12.

- [ ] **Step 1: Write the failing test `test/output-schemas.test.ts`**

```ts
import {
  chunkOutputFields,
  convertOutputFields,
  getResultOutputFields,
  healthOutputFields,
  jobOutputFields,
} from "../src/lib/output-schemas.js";

it("convert fields cover the response shape", () => {
  expect(convertOutputFields.map((f) => f.key)).toEqual([
    "document",
    "status",
    "errors",
    "processing_time",
  ]);
  expect(convertOutputFields.every((f) => f.label.length > 0)).toBe(true);
});

it("job/getResult fields cover the task lifecycle shape", () => {
  expect(jobOutputFields.map((f) => f.key)).toEqual([
    "task_id",
    "task_status",
    "task_position",
    "task_meta",
  ]);
  expect(getResultOutputFields.map((f) => f.key)).toEqual(["done", "task_id"]);
});

it("health and chunk fields are non-empty and labelled", () => {
  expect(healthOutputFields.map((f) => f.key)).toEqual(["status", "versions"]);
  expect(chunkOutputFields.map((f) => f.key)).toEqual(["chunks", "processing_time"]);
  expect(
    [...healthOutputFields, ...chunkOutputFields].every((f) => f.label.length > 0),
  ).toBe(true);
});
```

- [ ] **Step 2: Run — verify it fails** (module missing).

Run: `pnpm --filter @powerhousedao/piece-docling test -- test/output-schemas.test.ts`

- [ ] **Step 3: Implement `src/lib/output-schemas.ts` exactly as above; attach `outputSchema: { fields: … }` to the five actions (health, convert_file, convert_url, submit_job, get_result); re-run — passes.**

- [ ] **Step 4: Run all package tests + lint + tsc — clean. Commit.**

```bash
git add packages/piece-docling
git commit -m "feat(piece-docling): output field descriptors on all actions"
```

---

## Phase P2 — Chunking, i18n, packaging

### Task 12: `chunk` action + i18n + npm-pack verification

**Files:**
- Create: `packages/piece-docling/src/lib/actions/chunk.ts`
- Create: `packages/piece-docling/test/chunk.test.ts`
- Modify: `packages/piece-docling/src/index.ts`
- Modify: `packages/piece-docling/src/i18n/translation.json` (complete key set)
- Modify: `scripts/bundle.mjs` if needed to pass a `--name` through for the pack check (it already does)

**Interfaces:**
- Produces: `chunkAction` — `name: "chunk"`, `audience: "both"`, `aiMetadata: { idempotent: true }`. Props: `file` (optional File), `url` (optional ShortText), `chunker` (StaticDropdown `hybrid` default / `hierarchical`), + `format`-less options (`ocr`, `table_mode`, `page_range`, `image_mode`, `execution`, `timeout_seconds` from `convertProps` minus `format`). Run: exactly one of file/url; async default; calls `runChunk({ path: "chunk", chunker })`; returns `{ chunks, processing_time }`.

- [ ] **Step 1: Write the failing test `test/chunk.test.ts`**

```ts
import { chunkAction } from "../src/lib/actions/chunk.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling, MOCK_CHUNKS } from "./mock-docling-serve.js";

describe("chunk", () => {
  it("chunks a url via /v1/chunk/hybrid/source (async)", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const out = await chunkAction.run(
        makeActionContext(
          { url: "https://example.com/c.pdf", chunker: "hybrid", ocr: true, table_mode: "accurate", image_mode: "placeholder", execution: "async" },
          { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
        ) as never,
      ) as { chunks: unknown[] };
      expect(out.chunks).toEqual(MOCK_CHUNKS);
      const submit = mock.requests.find((r) => r.path === "/v1/chunk/hybrid/source/async");
      expect(submit).toBeTruthy();
    } finally { await mock.close(); }
  });

  it("uses the hierarchical endpoint when selected", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await chunkAction.run(
        makeActionContext(
          { file: "data:application/pdf;base64,QQ==", chunker: "hierarchical", execution: "async" },
          { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
        ) as never,
      );
      expect(mock.requests.some((r) => r.path === "/v1/chunk/hierarchical/source/async")).toBe(true);
    } finally { await mock.close(); }
  });

  it("requires one of file/url", async () => {
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      await expect(
        chunkAction.run(makeActionContext({ chunker: "hybrid", execution: "async" }, { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } }) as never),
      ).rejects.toMatchObject({ kind: "VALIDATION" });
    } finally { await mock.close(); }
  });
});
```

- [ ] **Step 2: Run — fails. Implement `src/lib/actions/chunk.ts`** (mirror `convert-url.ts`; source selection like `submit-job.ts`; `runChunk({ …, path: "chunk", chunker: (p.chunker as "hybrid" | "hierarchical") ?? "hybrid" })`). Register in `src/index.ts`.

- [ ] **Step 3: Run — pass.**

- [ ] **Step 4: Complete `src/i18n/translation.json`** — identity-mapped `en` entries for every user-facing string in the piece (piece displayName/description; each action's displayName/description/aiMetadata.description; each prop's displayName/description; each static dropdown option label; the auth displayName/description). Generate the key list by enumerating the strings in the source (they are all English literals).

- [ ] **Step 5: Verify the npm pack shape**

```bash
cd packages/piece-docling
node scripts/bundle.mjs --out /tmp/docling-pack && cd /tmp/docling-pack
cat package.json | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['main']=='./src/index.js', d; assert d['dependencies']=={}, d; print('tarball metadata OK')"
node -e "const m = require('/tmp/docling-pack/src/index.js'); const p = m.default; console.log('loads:', p.displayName, '| actions:', p.actions ? Object.keys(p.actions()).length : 'n/a')"
```

Expected: `tarball metadata OK` and `loads: Docling | actions: 6`. (The `require` must succeed in a bare Node process — this is exactly the reactor's load path. If it fails on a missing module, the bundle has an external — fix `scripts/bundle.mjs` externals.)

- [ ] **Step 6: Full-action conformance** — extend `test/conformance.test.ts`:

```ts
it("describes all six actions with their props", async () => {
  const loaded = await loadPieceFromDir(builtBundleDir());
  const descriptor = buildDescriptor(loaded.piece, {
    packageName: "@powerhousedao/piece-docling",
    version: "1.0.0",
  });
  const names = descriptor.actions.map((a) => a.name).sort();
  expect(names).toEqual(["chunk", "convert_file", "convert_url", "get_result", "health", "submit_job"]);
  const byName = Object.fromEntries(descriptor.actions.map((a) => [a.name, a]));
  expect(byName["convert_file"].props.map((p) => p.name)).toContain("file");
  expect(byName["submit_job"].props.map((p) => p.name)).toEqual(
    expect.arrayContaining(["file", "url", "format"]),
  );
});
```

(Import `buildDescriptor` at the top of the test file if the Task 4 import isn't still there.)

- [ ] **Step 7: Run the full package suite + lint + tsc. Commit.**

```bash
git add packages/piece-docling
git commit -m "feat(piece-docling): chunk action, i18n, full-action conformance, npm-shape bundle verified standalone"
```

---

## Phase P3 — Reactor integration

**Note (G3 file values — no host-side change needed):** an earlier draft of
this plan added a host-side data-URI hydration step to the block executor. It
was removed in review: the worker already does this. `handleRun`
(`src/activepieces/worker/entry.ts`) calls
`normalizePropsValue(action.props, request.propsValue)` before every run, and
`toApFile` (`src/activepieces/context/normalize.ts`) converts URL/data-URI
strings on **FILE-typed props** into ApFile values
(`{filename, data: Buffer, base64}`) — exactly the layer the S6a spike notes
name for this purpose ("the editor stores canonical values, the worker
normalises before run()"). The piece's own `normalizeFile` (Task 5) accepts
that shape, so data-URI file configs work end-to-end with no host change. A
host-side rewrite would have duplicated this layer and, worse, rewritten
data-URI strings in non-FILE props of every piece.

### Task 13: First-party catalog merge

**Files:**
- Modify: `packages/workflow/subgraphs/workflow-runtime/piece-catalog.ts`
- Create: `packages/workflow/subgraphs/workflow-runtime/piece-catalog.test.ts`

**Interfaces:**
- Consumes: `fetchPieceCatalog()` (60-minute module cache `catalogCache`), `PieceSummary` (`{name, displayName, description, logoUrl, version, actionCount, triggerCount, categories, auth}`), the `CatalogEntry` wire shape (`{name, version, actions: number|Record, triggers: number|Record, …}`), the `SERVER_ONLY_PIECES` filter.
- Produces: `fetchPieceCatalog()` returns the cloud entries (as today) **plus** `FIRST_PARTY_PIECES` entries whose short name (package name after the last `/`) is not present in the cloud set (cloud wins on duplicates — once the upstream PR publishes `@activepieces/piece-docling`, it supersedes ours automatically), sorted by `displayName`. Also exports `__resetCatalogCacheForTests()`.

- [ ] **Step 1: Write the failing test `piece-catalog.test.ts`**

The workflow package's vitest config has `globals: true`, but this file follows
the package's existing convention (`check-connection.test.ts`) of importing
vitest symbols explicitly. The catalog module caches for 60 minutes, so the
test resets that cache per case.

```ts
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  fetchPieceCatalog,
  __resetCatalogCacheForTests,
} from "./piece-catalog.js";

// The catalog fetcher uses global fetch; stub it per test. The first-party
// merge must not depend on the cloud at all when the cloud is empty.
function stubCatalog(entries: unknown[]) {
  vi.stubGlobal(
    "fetch",
    (async (input: unknown) => {
      expect(String(input)).toContain("cloud.activepieces.com/api/v1/pieces");
      return new Response(JSON.stringify(entries), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never,
  );
}

beforeEach(__resetCatalogCacheForTests);
afterEach(() => vi.unstubAllGlobals());

it("lists the first-party docling piece when the cloud catalog lacks it", async () => {
  stubCatalog([]);
  const catalog = await fetchPieceCatalog();
  const docling = catalog.find((p) => p.name === "@powerhousedao/piece-docling");
  expect(docling?.displayName).toBe("Docling");
  expect(docling?.actionCount).toBe(6);
  expect(docling?.triggerCount).toBe(0);
  expect(docling?.auth).toMatchObject({ type: "CUSTOM_AUTH" });
});

it("prefers the cloud entry when the same short name exists upstream", async () => {
  stubCatalog([
    {
      name: "@activepieces/piece-docling",
      version: "0.1.0",
      actions: 6,
      triggers: 0,
      auth: { type: "CUSTOM_AUTH" },
    },
  ]);
  const catalog = await fetchPieceCatalog();
  const matches = catalog.filter((p) => p.name.includes("piece-docling"));
  expect(matches).toHaveLength(1);
  expect(matches[0]?.name).toBe("@activepieces/piece-docling");
});

it("keeps server-only pieces filtered", async () => {
  stubCatalog([{ name: "@activepieces/piece-ai", version: "1.0.0", actions: 1 }]);
  const catalog = await fetchPieceCatalog();
  expect(catalog.find((p) => p.name === "@activepieces/piece-ai")).toBeUndefined();
});
```

Stub entries use the **wire** (`CatalogEntry`) field names — `actions`/`triggers` as
numbers, which the mapper converts to `actionCount`/`triggerCount`. The cloud
filter requires `actions > 0 || triggers > 0`, so the stub docling entry carries
`actions: 6`.

- [ ] **Step 2: Run — verify it fails.**

Run: `cd packages/workflow && pnpm vitest run subgraphs/workflow-runtime/piece-catalog.test.ts`
Expected: FAIL (`__resetCatalogCacheForTests` missing; first-party entry absent).

- [ ] **Step 3: Implement in `piece-catalog.ts`**

Add above `fetchPieceCatalog`:

```ts
// First-party pieces not (yet) listed by the cloud catalog. After upstream
// publication the cloud entry wins (short-name dedupe below), so remove the
// entry from here at that point.
const FIRST_PARTY_PIECES: PieceSummary[] = [
  {
    name: "@powerhousedao/piece-docling",
    displayName: "Docling",
    description:
      "Convert documents (PDF, DOCX, PPTX, images, HTML, …) to Markdown, docling-document JSON, HTML, DocTags and plain text via a docling-serve v1 API (self-hosted or Docling for IBM watsonx).",
    logoUrl:
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#1e3a8a"/><path d="M14 10h14l8 8v20a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2z" fill="#fff"/><path d="M28 10v8h8" fill="none" stroke="#1e3a8a" stroke-width="2"/><path d="M18 24h12M18 29h12M18 34h8" stroke="#1e3a8a" stroke-width="2"/></svg>',
      ),
    version: "1.0.0",
    actionCount: 6,
    triggerCount: 0,
    categories: ["CONTENT_AND_FILES"],
    // Mirrors the piece's PieceAuth descriptor (the shape the connection
    // editor's planFromAuth consumes).
    auth: {
      type: "CUSTOM_AUTH",
      displayName: "Docling Serve",
      required: true,
      props: {
        base_url: { type: "SHORT_TEXT", displayName: "Service URL", required: true },
        api_key: { type: "SECRET_TEXT", displayName: "API Key", required: false },
      },
    },
  },
];

// Test-only: the module caches the catalog for CACHE_TTL_MS.
export function __resetCatalogCacheForTests(): void {
  catalogCache = undefined;
}
```

And inside `fetchPieceCatalog()`, split the existing `raw.filter(...).map(...).sort(...)` chain so the first-party merge happens before the sort:

```ts
  const cloud = raw
    .filter(
      (entry) =>
        typeof entry.name === "string" &&
        typeof entry.version === "string" &&
        !SERVER_ONLY_PIECES.has(entry.name) &&
        ((typeof entry.actions === "number" && entry.actions > 0) ||
          (typeof entry.triggers === "number" && entry.triggers > 0)),
    )
    .map((entry) => ({
      name: entry.name!,
      displayName: entry.displayName ?? entry.name!,
      description: entry.description ?? "",
      logoUrl: entry.logoUrl ?? "",
      version: entry.version!,
      actionCount: typeof entry.actions === "number" ? entry.actions : 0,
      triggerCount: typeof entry.triggers === "number" ? entry.triggers : 0,
      categories: entry.categories ?? [],
      auth: entry.auth ?? null,
    }));
  // First-party pieces the cloud catalog doesn't carry yet; the cloud wins on
  // short-name collisions (once upstream publishes the same piece).
  const shortName = (n: string) => n.slice(n.lastIndexOf("/") + 1);
  const cloudShorts = new Set(cloud.map((e) => shortName(e.name)));
  const value = [
    ...cloud,
    ...FIRST_PARTY_PIECES.filter((p) => !cloudShorts.has(shortName(p.name))),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName));
  catalogCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
```

- [ ] **Step 4: Run the workflow package tests — all pass**

Run: `cd packages/workflow && pnpm test`
Expected: PASS (new file + all pre-existing, including check-connection).

- [ ] **Step 5: Commit**

```bash
git add packages/workflow
git commit -m "feat(workflow): first-party piece catalog entries with cloud-precedence dedupe"
```

### Task 14: End-to-end — built bundle through the real executor to the mock server

**Files:**
- Create: `packages/reactor-connectors/test/activepieces/piece-docling.test.ts`
- Create: `packages/reactor-connectors/test/activepieces/mock-docling-serve.ts` — a **copy** of `packages/piece-docling/test/mock-docling-serve.ts` (deliberate cross-package duplication so the two packages stay independently testable)

**Interfaces:**
- Consumes: `ActivepiecesBlockExecutor` with `ActivepiecesBlockExecutorOptions = { cacheDir: string; packages?: Record<string,string>; connections?: EngineConnectionResolver; worker?: PieceWorker; defaultTimeoutMs?: number }` — there is **no** `secrets` member (review fix 5); `StaticConnectionResolver(connections: Record<string, ConnectionSource>, secrets: SecretProvider)`; `SecretProvider` from `src/engine/secrets.js`; the piece bundle built by `packages/piece-docling/scripts/bundle.mjs`; the `fetchPieceBundle` cache-dir layout `<cacheDir>/<name with first '/' → '-'>-<version>` → `@powerhousedao-piece-docling-1.0.0` (`fetch.ts`).
- Produces: the crown-jewel integration proof: a workflow step with a data-URI file config executes the *built* docling bundle through the forked worker against the mock docling-serve and returns the canned markdown — plus the unauthenticated (no-key) connection variant (spec §7.3).

**Prerequisite:** `packages/reactor-connectors/dist/worker-entry.js` must exist (the default `PieceWorker` entry) — the package's own `test` script runs `pnpm run build && vitest run`, so invoking `pnpm test` in that package is sufficient.

- [ ] **Step 1: Copy the mock**

```bash
cp packages/piece-docling/test/mock-docling-serve.ts \
   packages/reactor-connectors/test/activepieces/mock-docling-serve.ts
```

- [ ] **Step 2: Write the test**

```ts
// E2E: the published-shape bundle, the real executor, the real worker, a
// mock docling-serve. This is the definition of "runs unmodified in the
// reactor" (doc 08).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ActivepiecesBlockExecutor,
  StaticConnectionResolver,
  type SecretProvider,
} from "../../src/index.js";
import { startMockDocling, MOCK_MD, type MockDocling } from "./mock-docling-serve.js";

const PIECE_PKG = path.resolve("../piece-docling");
const CACHE = path.join(tmpdir(), `docling-e2e-${process.pid}`);

function ensureBundleInCache(): void {
  if (!existsSync(path.join(PIECE_PKG, "dist/src/index.js"))) {
    execFileSync("node", ["scripts/bundle.mjs"], { cwd: PIECE_PKG });
  }
  const dir = path.join(CACHE, "@powerhousedao-piece-docling-1.0.0"); // fetch.ts cache layout
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(PIECE_PKG, "dist"), dir, { recursive: true });
}

describe("docling piece through the executor (E2E)", () => {
  let mock: MockDocling;
  let executor: ActivepiecesBlockExecutor;
  const secrets: SecretProvider = {
    get: async (ref: string) => (ref === "secret://v1:docling" ? "k-e2e" : null),
  } as never;

  beforeAll(async () => {
    mock = await startMockDocling({ apiKey: "k-e2e" });
    ensureBundleInCache();
    executor = new ActivepiecesBlockExecutor({
      cacheDir: CACHE,
      connections: new StaticConnectionResolver(
        {
          "phd:connection-1": {
            authType: "CUSTOM_AUTH",
            config: { base_url: mock.baseUrl },
            secretRefs: [{ name: "api_key", ref: "secret://v1:docling" }],
          },
        },
        secrets,
      ),
    });
  });
  afterAll(async () => {
    executor.dispose();
    await mock.close();
  });

  it("converts a data-URI file step and returns the markdown", async () => {
    const result = await executor.execute({
      blockType: "@powerhousedao/piece-docling@1.0.0#convert_file",
      connectionId: "phd:connection-1",
      config: {
        file: "data:application/pdf;base64," + Buffer.from("fake-pdf").toString("base64"),
        format: "markdown",
        ocr: true,
        table_mode: "accurate",
        image_mode: "placeholder",
        execution: "async",
        timeout_seconds: 30,
      },
      step: {
        id: "s1",
        key: "convert",
        name: "Convert",
        blockType: "@powerhousedao/piece-docling@1.0.0#convert_file",
        connectionId: "phd:connection-1",
        config: {},
      },
    });
    expect(result.output).toMatchObject({
      status: "success",
      document: { md_content: MOCK_MD },
    });
  });

  it("surfaces a connection auth failure as a typed error", async () => {
    const bad = new ActivepiecesBlockExecutor({
      cacheDir: CACHE,
      connections: new StaticConnectionResolver(
        {
          "phd:bad": {
            authType: "CUSTOM_AUTH",
            config: { base_url: mock.baseUrl },
            secretRefs: [], // no key → 401 from the key-gated mock
          },
        },
        secrets,
      ),
    });
    try {
      await bad.execute({
        blockType: "@powerhousedao/piece-docling@1.0.0#health",
        connectionId: "phd:bad",
        config: {},
        step: {
          id: "s2",
          key: "health",
          blockType: "@powerhousedao/piece-docling@1.0.0#health",
          connectionId: "phd:bad",
          config: {},
        },
      });
      throw new Error("expected the action to fail");
    } catch (err) {
      // PieceWorkerError wraps the serialized piece error; the message
      // carries the DoclingError text.
      expect(String(err)).toMatch(/AUTH|401|API key/);
    } finally {
      bad.dispose();
    }
  });

  it("runs unauthenticated when the connection has no api_key secretRef", async () => {
    // spec §7.3: shapeAuthValue with no secretRefs must omit the key so the
    // piece talks to an unauthenticated server.
    const open = await startMockDocling(); // no key configured
    try {
      const resolver = new StaticConnectionResolver(
        { "phd:open": { authType: "CUSTOM_AUTH", config: { base_url: open.baseUrl } } },
        secrets,
      );
      const shaped = (await resolver.resolve("phd:open")) as {
        type: string;
        props: Record<string, unknown>;
      };
      expect(shaped).toMatchObject({
        type: "CUSTOM_AUTH",
        props: { base_url: open.baseUrl },
      });
      const unauth = new ActivepiecesBlockExecutor({
        cacheDir: CACHE,
        connections: resolver,
      });
      const result = await unauth.execute({
        blockType: "@powerhousedao/piece-docling@1.0.0#health",
        connectionId: "phd:open",
        config: {},
        step: {
          id: "s3",
          key: "health",
          blockType: "@powerhousedao/piece-docling@1.0.0#health",
          connectionId: "phd:open",
          config: {},
        },
      });
      expect(result.output).toMatchObject({ status: "ok" });
      unauth.dispose();
    } finally {
      await open.close();
    }
  });
});
```

- [ ] **Step 3: Run**

Run: `cd packages/reactor-connectors && pnpm test -- piece-docling`
Expected: PASS (3 tests). The first test exercises: bundle cache hit → worker fork → loader (`constructor-name`) → auth shaping (secret resolved) → worker-side `normalizePropsValue`/`toApFile` (data URI → ApFile) → piece client → mock server → JSON-IPC back.

- [ ] **Step 4: Commit**

```bash
git add packages/reactor-connectors
git commit -m "test(reactor-connectors): docling bundle E2E through executor + worker against mock docling-serve"
```

### Task 15: checkConnection subgraph integration test (docling)

**Files:**
- Create: `packages/workflow/subgraphs/workflow-runtime/check-connection-docling.test.ts`

**Interfaces:**
- Consumes: the existing offline fixture harness pattern from `check-connection.test.ts` (same directory): `vi.mock("@powerhousedao/reactor-connectors")` with `ensurePieceBundle` as a `vi.fn()` (everything else real — the real `PieceWorker` forks the real `dist/worker-entry.js`), `vi.mock("./piece-catalog.js")`, `workflowRuntime.configure(subgraph)` with a stub `reactorClient` (`get`/`execute`/`find`) + a real PGlite `relationalDb` (`createRelationalDb(getDbClient().db)`), `workflowRuntime.secrets().create(...)` for secret refs, and `PH_SECRETS_MASTER_KEY` set in-process.
- Produces: the docling variant of that suite: the **built** piece bundle (not inline fixture code) in the production cache layout, a live mock docling-serve, and `workflowRuntime.checkConnection(connectionId)` exercised through the real `PieceWorker` → worker `handleCheckConnection` → our `checkConnection` shim. This closes spec §7.4 and D6 end-to-end. `checkConnection` is on `main` (merged from `feat/ai-connection-tools`; `service.ts:821`), so the test runs unconditionally — no feature detection.

**Prerequisite:** the docling bundle built (the test builds it on demand; the piece package's esbuild comes from the workspace `pnpm install`).

- [ ] **Step 1: Write the test**

```ts
// The docling piece's checkConnection shim through the real subgraph
// check-connection path: real PGlite secret store, real PieceWorker fork,
// built piece bundle, live mock docling-serve. The harness mirrors
// check-connection.test.ts (same mocks, same subgraph shape).
import { getDbClient, type BaseSubgraph } from "@powerhousedao/reactor-api";
import { ensurePieceBundle } from "@powerhousedao/reactor-connectors";
import { createRelationalDb } from "@powerhousedao/shared/processors";
import type * as ReactorConnectors from "@powerhousedao/reactor-connectors";
import type { Action, PHDocument } from "document-model";
import {
  actions,
  reducer,
  utils,
  type ConnectionAuthType,
  type ConnectionDocument,
  type RecordCheckResultInput,
} from "document-models/connection/v1";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@powerhousedao/reactor-connectors", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactorConnectors>();
  return { ...actual, ensurePieceBundle: vi.fn() };
});

vi.mock("./piece-catalog.js", () => ({
  fetchPieceCatalog: vi.fn(),
  fetchPieceDetail: vi.fn(),
  fetchPieceActions: vi.fn(),
  fetchPieceTriggers: vi.fn(),
}));

import { fetchPieceCatalog } from "./piece-catalog.js";
import { workflowRuntime } from "./service.js";

const PIECE = { name: "@powerhousedao/piece-docling", version: "1.0.0" };
const FIXED_NOW = "2026-09-08T00:00:00.000Z";

// Minimal docling-serve: only /health and /version — all checkConnection
// touches. Key-gated like the real server.
async function startMiniDocling(opts: { apiKey?: string }): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (opts.apiKey && req.headers["x-api-key"] !== opts.apiKey) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "Invalid API Key." }));
    }
    if (u.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    if (u.pathname === "/version") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ "docling-serve": "1.32.0", docling: "2.126.0" }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "no route" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

function seedBuiltBundle(cacheDir: string): void {
  const piecePkg = fileURLToPath(new URL("../../../piece-docling", import.meta.url));
  if (!existsSync(join(piecePkg, "dist/src/index.js"))) {
    execFileSync("node", ["scripts/bundle.mjs"], { cwd: piecePkg });
  }
  const dir = join(cacheDir, `${PIECE.name.replace("/", "-")}-${PIECE.version}`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(piecePkg, "dist"), dir, { recursive: true });
}

let cacheDir = "";
let keyRef = "";
let wrongRef = "";
let get: Mock;
let execute: Mock;
let docling: Awaited<ReturnType<typeof startMiniDocling>>;

function makeDoclingDocument(options: {
  base_url: string;
  keyRef?: string;
}): ConnectionDocument {
  let document = utils.createDocument();
  document = reducer(
    document,
    actions.setConnector({
      connectorId: `${PIECE.name}#docling-serve`,
      authType: "CUSTOM_AUTH" as ConnectionAuthType,
    }),
  );
  document = reducer(
    document,
    actions.setConfig({ config: { base_url: options.base_url } }),
  );
  if (options.keyRef) {
    document = reducer(
      document,
      actions.setSecretRef({ id: "sr-1", name: "api_key", ref: options.keyRef }),
    );
  }
  document = reducer(
    document,
    actions.recordCheckResult({ status: "OK", checkedAt: FIXED_NOW }),
  );
  return document;
}

function lastRecordInput(): RecordCheckResultInput {
  const call = execute.mock.calls.at(-1);
  expect(call, "execute should have been called").toBeDefined();
  const actionList = call?.[2] as Action[];
  expect(actionList).toHaveLength(1);
  const action = actionList[0];
  expect(action.type).toBe("RECORD_CHECK_RESULT");
  return action.input as RecordCheckResultInput;
}

describe("WorkflowRuntimeService.checkConnection (docling piece)", () => {
  beforeAll(async () => {
    // Keep the key in-process so the encrypted store never writes a key file.
    process.env.PH_SECRETS_MASTER_KEY =
      "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    cacheDir = await mkdtemp(join(tmpdir(), "ap-check-docling-"));
    seedBuiltBundle(cacheDir);

    vi.mocked(ensurePieceBundle).mockImplementation(
      ({ name, version, cacheDir: requestedCacheDir }) => {
        void requestedCacheDir;
        const dir = join(cacheDir, `${name.replace("/", "-")}-${version}`);
        if (!existsSync(join(dir, "package.json"))) {
          return Promise.reject(
            new Error(`Offline check test: no fixture bundle for ${name}@${version}`),
          );
        }
        return Promise.resolve({
          dir,
          source: "cache",
          dependencies: {},
          installed: false,
        });
      },
    );
    vi.mocked(fetchPieceCatalog).mockResolvedValue([
      {
        name: PIECE.name,
        displayName: "Docling",
        description: "",
        logoUrl: "",
        version: PIECE.version,
        actionCount: 6,
        triggerCount: 0,
        categories: [],
        auth: null,
      },
    ]);

    docling = await startMiniDocling({ apiKey: "k-docling" });

    const { db } = getDbClient();
    get = vi.fn();
    execute = vi.fn(() => ({}) as PHDocument);
    const subgraph = {
      reactorClient: {
        get,
        execute,
        find: vi.fn(() => ({ results: [] })),
      },
      relationalDb: createRelationalDb(db),
    } as unknown as BaseSubgraph;
    workflowRuntime.configure(subgraph);

    keyRef = (
      await (await workflowRuntime.secrets()).create({
        value: "k-docling",
        label: "docling api key",
      })
    ).ref;
    wrongRef = (
      await (await workflowRuntime.secrets()).create({
        value: "wrong-key",
        label: "docling api key (wrong)",
      })
    ).ref;
  });

  afterAll(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await docling.close();
  });

  it("records OK with the version-labelled account name for a healthy server", async () => {
    const document = makeDoclingDocument({ base_url: docling.baseUrl, keyRef });
    get.mockResolvedValueOnce(document);
    execute.mockClear();

    const result = await workflowRuntime.checkConnection(document.header.id);

    expect(result).toEqual({
      ok: true,
      detail: null,
      accountLabel: "docling-serve 1.32.0",
    });
    expect(lastRecordInput().status).toBe("OK");
  });

  it("records ERROR with the 401 detail for a rejected key", async () => {
    const document = makeDoclingDocument({ base_url: docling.baseUrl, keyRef: wrongRef });
    get.mockResolvedValueOnce(document);
    execute.mockClear();

    const result = await workflowRuntime.checkConnection(document.header.id);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/401/);
    expect(lastRecordInput().status).toBe("ERROR");
  });

  it("records ERROR when the server is unreachable", async () => {
    const document = makeDoclingDocument({ base_url: "http://127.0.0.1:1", keyRef });
    get.mockResolvedValueOnce(document);
    execute.mockClear();

    const result = await workflowRuntime.checkConnection(document.header.id);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Could not reach/i);
    expect(lastRecordInput().status).toBe("ERROR");
  });
});
```

- [ ] **Step 2: Run the workflow package suite — green**

Run: `cd packages/workflow && pnpm test`
Expected: PASS including the new file (3 cases). The worker fork, the built bundle, and the mock server all run in-process/offline.

- [ ] **Step 3: Commit**

```bash
git add packages/workflow
git commit -m "test(workflow): docling checkConnection through the real subgraph path"
```

---

## Phase P4 — Release

### Task 16: npm publish (`@powerhousedao/piece-docling`)

**Files:**
- Modify: `packages/piece-docling/CHANGELOG.md` (create; initial entry)
- No source changes.

**Interfaces / preconditions:**
- The `@powerhousedao` npm scope must exist and the operator must be an owner (it is already used by `@powerhousedao/reactor-connectors` et al.). `npm whoami` must show the scope owner before publishing.
- The bundle must be built from the final source (`node scripts/bundle.mjs`).

- [ ] **Step 1: Create `packages/piece-docling/CHANGELOG.md`**

```markdown
# Changelog

## 1.0.0 — 2026-09-08
- Initial release: docling-serve v1 integration (convert file/url, submit job,
  get result, chunk, health) with CustomAuth (base URL + optional API key)
  and connection health checking.
```

- [ ] **Step 2: Dry-run the pack**

```bash
cd packages/piece-docling
node scripts/bundle.mjs --out /tmp/publish-check
npm pack /tmp/publish-check
# inspect: the .tgz must contain only package.json + src/index.js + src/i18n/translation.json
tar -tzf piece-*.tgz
```

Expected: exactly three paths under `package/`. If anything else is included, tighten `scripts/bundle.mjs` (it writes only those three files — a stray file means a stale `dist/`).

- [ ] **Step 3: Publish (operator action — requires npm credentials for the scope)**

```bash
cd /tmp/publish-check
npm publish --access public
```

> **Operator gate:** the actual `npm publish` is a human action (credentials + scope ownership). The plan's job ends at the verified tarball. After publish, verify: `npm view @powerhousedao/piece-docling version` → `1.0.0`.

- [ ] **Step 4: Post-publish verification against the real npm registry** (network allowed for this one check):

```bash
cd /tmp && npm pack @powerhousedao/piece-docling@1.0.0 --silent && tar -tzf powerhousedao-*.tgz
node -e "const m=require('/tmp/package/src/index.js'); console.log('registry bundle loads:', m.default.displayName, m.default.actions().length, 'actions')"
```

- [ ] **Step 5: Commit**

```bash
git add packages/piece-docling/CHANGELOG.md
git commit -m "chore(piece-docling): 1.0.0 changelog and publish procedure"
```

---

### Task 17: Upstream PR to activepieces/activepieces

**Files:**
- New fork branch (outside this repo): `activepieces/activepieces` @ `packages/pieces/community/docling/`
- Modify (this repo): none (the upstream copy is a renamed duplicate; this repo stays the source of truth for the Powerhouse-side package)

**Interfaces / preconditions:**
- A fork of `activepieces/activepieces` with push access (GitHub).
- The AP repo's `tsconfig.base.json` path-alias registration (their `packages/pieces/CLAUDE.md` instructs: add `"@activepieces/piece-docling": ["packages/pieces/community/docling/src/index.ts"]`).
- The AP build pipeline reads i18n from the piece's `src/i18n/` (the `community/airtable` reference piece carries `src/i18n/translation.json` in-tree) — so `i18n/` is **kept** in the copy (decision rule fixed in review; no "read first" hedge).

- [ ] **Step 1: Prepare the upstream tree in a scratch dir**

```bash
mkdir -p /tmp/ap-upstream && cd /tmp/ap-upstream
git clone https://github.com/<your-fork>/activepieces.git ap && cd ap
git checkout -b feat/docling-piece
# Copy the piece source verbatim (src/ including i18n/ — no tests, no
# scripts, no package.json yet):
mkdir -p packages/pieces/community/docling
cp -r <repo>/packages/piece-docling/src packages/pieces/community/docling/src
```

(`<repo>` = whichever checkout holds the final piece source — the docling
worktree or the primary repo.)

- [ ] **Step 2: Create the upstream `package.json`** (AP convention, per `community/airtable/package.json`):

```json
{
  "name": "@activepieces/piece-docling",
  "version": "0.1.0",
  "main": "./dist/src/index.js",
  "types": "./dist/src/index.d.ts",
  "dependencies": {
    "@activepieces/pieces-common": "workspace:*",
    "@activepieces/pieces-framework": "workspace:*",
    "@activepieces/shared": "workspace:*"
  },
  "devDependencies": { "tslib": "2.6.2" },
  "scripts": {
    "build": "tsc -p tsconfig.lib.json && cp package.json dist/",
    "bundle": "node ../../../../dist/packages/cli/src/index.js pieces bundle",
    "lint": "eslint 'src/**/*.ts'"
  }
}
```

plus `tsconfig.json` + `tsconfig.lib.json` copied from `community/airtable/` and adapted to the docling file list (read airtable's first — it references `src/**/*`).

> **No zod dependency:** the piece source no longer imports zod (output schemas are plain field descriptors after review fix 3), so the upstream `package.json` omits it. If a future action revives a zod import, add `zod` here and in the Powerhouse-side package simultaneously.

- [ ] **Step 3: Register the path alias** in `tsconfig.base.json`:

```json
"@activepieces/piece-docling": ["packages/pieces/community/docling/src/index.ts"]
```

- [ ] **Step 4: Local verification in the fork**

```bash
cd /tmp/ap-upstream/ap
pnpm install
pnpm --filter @activepieces/piece-docling lint
pnpm --filter @activepieces/piece-docling build
```

Expected: lint clean, tsc build succeeds. (Their workspace pins its own framework version — the piece was written against the 0.32.0 API surface, which is a subset of current; if their current framework rejects something 0.32.0-specific, adapt the call site minimally — the observable piece contract is unchanged.)

- [ ] **Step 5: Push and open the PR (operator action)**

```bash
git add -A && git commit -m "feat(pieces): add Docling piece (docling-serve v1)"
git push origin feat/docling-piece
# GitHub: open PR against activepieces/activepieces main, title:
# "Add Docling piece (docling-serve v1 document conversion)"
# Body: one paragraph — what it is, the six actions, auth model, that it is
# MIT-licensed, tested against docling-serve 1.32.0. Reference this repo's
# spec (link) if public.
```

> **Operator gate:** opening the PR is a human action (fork ownership, review relationship). Everything up to the push is scripted above.
>
> **After merge:** their CI publishes `@activepieces/piece-docling` to npm and the cloud catalog lists it (contribute.mdx: "available within a few minutes"). Then remove the first-party entry from `packages/workflow/subgraphs/workflow-runtime/piece-catalog.ts` `FIRST_PARTY_PIECES` (the dedupe handles it automatically, but the explicit removal keeps the list truthful) — small follow-up commit, not part of this plan's scope.

- [ ] **Step 6: Commit the record in this repo**

```bash
git commit --allow-empty -m "chore(piece-docling): upstream PR opened at activepieces/activepieces feat/docling-piece"
```

---

## Self-Review (run before execution; fix inline)

**Round 1 (completed — independent code-reviewer subagent, 2026-09-08; verdict APPROVE-WITH-FIXES):** all six blockers and three majors are fixed in this revision:
1. `SecretTextProperty` is a zod schema *value* in 0.32.0, not a factory — calling it would throw at module load and poison the whole package → `PieceAuth.SecretText(...)` (Task 3).
2. `CustomAuth.validate` receives the **flat** property value, not a shaped `{props}` object — the old implementation/test contradiction is gone (Task 3).
3. `outputSchema` is a UI field-list, not a validator — zod objects removed from the piece entirely; field descriptors in `output-schemas.ts`, zod dependency dropped (Task 11).
4. Old Task 13 (host-side file hydration) **deleted** — the worker's `normalizePropsValue`/`toApFile` already converts data-URIs on FILE-typed props; the host-side rewrite would have duplicated the layer and corrupted non-FILE props of every piece (see the P3 note).
5. Old Task 15 (E2E) wiring fixed against the real signatures: `StaticConnectionResolver(connections, secrets)`; the executor options have no `secrets` member; bundle path corrected to `../piece-docling`; plus the spec §7.3 no-key case (new Task 14).
6. Old Task 16's false premise fixed: `checkConnection` is on `main` (`service.ts:821`, merged from `feat/ai-connection-tools`), and a full offline fixture suite already exists — the test is now a real docling variant of that suite, no feature detection (new Task 15).
7. The `/version` contract fixed to the real 1.32.0 hyphenated keys (`"docling-serve"`, …, including the upstream `"plaform"` typo); the shim keeps the underscore spelling only as a fallback; mocks and tests updated to match (Tasks 2, 3, 4, 15).
8. Task 1 builds `reactor-connectors` before the piece (its `exports` map resolves to `dist/` under vitest; the `source` condition is tsconfig-only).

**Spec coverage:** spec §3 D1–D10 → D1 Task 16/17; D2 Task 7; D3 Tasks 5/8; D4 Task 6; D5 Tasks 3/8/9/10/12; D6 Tasks 3/4/15; D7 `triggers: []`; D8 Tasks 1/12; D9 Task 6; D10 Tasks 8–12 (`audience` + `aiMetadata`; `outputSchema` is a UI field list in 0.32.0). §6 integration → Tasks 13–15 (G3 file values need no host change — worker-side `toApFile`, see the P3 note). §7 test plan → Tasks 2, 4, 7, 8–12, 14 (E2E incl. the §7.3 no-key `shapeAuthValue` case), 15 (§7.4 checkConnection). §8 publish → Tasks 16/17.

**Placeholder scan:** no remaining vague "adapt as needed" steps; every task's code is complete. The only intentional conditionals are the Task 17 checkout-path note (two possible source locations) and the Task 17 framework-version note (the upstream workspace may pin a newer framework than 0.32.0).

**Type consistency:** `ConvertDocumentsOptionsPayload` (Task 6) is the single options type used by Tasks 7–12; `DoclingSource` (Task 7) is used by 8/9/10/12; `DoclingError` kinds are the fixed enum from Task 3; `MockDocling` options are extended incrementally (`neverFinish` Task 7, `requestBodies` Task 8) — both extensions are called out at the point of use.

## Execution notes

- **Branch/worktree:** work on `feat/docling-piece` (rebased onto current `origin/main`, which carries the checkConnection subgraph) in the docling worktree (`/home/froid/reactor-workflow-docling`) — the primary checkout is shared with the sibling paperless-ngx session. If that session has finished, the primary checkout is equally valid.
- **Order matters within phases** (tasks reference earlier artifacts); across phases, P1's Tasks 8–10 can be reordered freely relative to each other once Task 7 lands.
- **Per-task gate:** the task's named test command passes, `lint` + `tsc` for the touched packages are clean, one commit. Do not run the full root CI mid-phase; run it once after P3 (Task 15) and once after P4 (Task 17).
- **If a 0.32.0 factory signature rejects a field used above** (the .d.ts surface was re-verified in review round 1 — `PieceAuth.SecretText`, `Property.StaticDropdown`, `Property.Object` all confirmed): the authoritative check is compiling Task 3/6 — read the exact `.d.ts` under `node_modules/@activepieces/pieces-framework/src/lib/property/` and adapt the call site; the *observable* property shape (what the descriptor and mock context see) must stay as specified.
