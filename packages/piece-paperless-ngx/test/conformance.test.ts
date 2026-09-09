// Tier-1 conformance: the acceptance gate for the bundle. The published
// artifact has to load through the reactor's own duck-typed loader, describe
// into a connector descriptor, and execute an action inside the forked worker
// — that, not our esbuild config, is the definition of a valid bundle.
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as ReactorConnectors from "@powerhousedao/reactor-connectors";
import type { MockPaperless } from "./mock-paperless";
import { startMockPaperless } from "./mock-paperless";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// `dist/` is the tarball root, so the gate loads exactly what npm would ship —
// the emitted package.json included, rather than one written here to suit.
const distDir = join(packageRoot, "dist");
const bundleFile = join(distDir, "src", "index.js");

// The reactor's loader and worker live in the connectors package; a workspace
// that has not built it yet skips rather than fails.
type Connectors = typeof ReactorConnectors;
let connectors: Connectors | undefined;
try {
  connectors = await import("@powerhousedao/reactor-connectors");
} catch {
  connectors = undefined;
}

const ready = connectors !== undefined && existsSync(bundleFile);

let cacheDir = "";
let bundleDir = "";
let published: {
  name: string;
  version: string;
  main: string;
  dependencies: Record<string, string>;
  license?: string;
};
let mock: MockPaperless;

describe.skipIf(!ready)("bundle conformance", () => {
  beforeAll(async () => {
    published = JSON.parse(
      await readFile(join(distDir, "package.json"), "utf8"),
    ) as typeof published;
    cacheDir = await mkdtemp(join(tmpdir(), "paperless-conformance-"));
    // The layout ensurePieceBundle resolves: <cacheDir>/<name>-<version>.
    bundleDir = join(
      cacheDir,
      `${published.name.replace("/", "-")}-${published.version}`,
    );
    await cp(distDir, bundleDir, { recursive: true });
    mock = await startMockPaperless();
  }, 60_000);

  afterAll(async () => {
    await mock.close();
  });

  it("loads through the reactor's duck-typed loader", async () => {
    const loaded = await connectors!.loadPieceFromDir(bundleDir);

    expect(loaded.check).toBe("constructor-name");
    expect(loaded.piece.displayName).toBe("Paperless-ngx");
    // keepNames must survive bundling, or the constructor-name check fails.
    expect(loaded.piece.constructor.name).toBe("Piece");
  });

  it("describes into a connector descriptor with real props and pickers", async () => {
    const { piece } = await connectors!.loadPieceFromDir(bundleDir);
    const descriptor = connectors!.buildDescriptor(piece, {
      packageName: published.name,
      version: published.version,
    });

    expect(descriptor.actions.map((action) => action.name).sort()).toEqual([
      "bulk_edit_documents",
      "custom_api_call",
      "find_or_create_object",
      "get_document",
      "get_document_file",
      "get_task",
      "search_documents",
      "update_document",
      "upload_document",
    ]);
    expect(
      descriptor.triggers.map((trigger) => [trigger.name, trigger.strategy]),
    ).toEqual([
      ["new_document", "WEBHOOK"],
      ["document_updated", "WEBHOOK"],
    ]);

    expect(descriptor.auth).toMatchObject({ type: "CUSTOM_AUTH" });

    const upload = descriptor.actions.find(
      (action) => action.name === "upload_document",
    );
    const tags = upload?.props.find((prop) => prop.name === "tags");
    expect(tags?.type).toBe("MULTI_SELECT_DROPDOWN");
    // The editor only offers a live picker when the resolver is recorded.
    expect(tags?.hasDynamicResolver).toBe(true);

    const bulk = descriptor.actions.find(
      (action) => action.name === "bulk_edit_documents",
    );
    expect(
      bulk?.props.find((prop) => prop.name === "parameters")?.type,
    ).toBe("DYNAMIC");
  });

  it("ships a publishable tarball: no deps, and the i18n data file", async () => {
    // `npm publish ./dist` reads the emitted manifest, not the workspace one.
    expect(published.name).toBe("@powerhousedao/piece-paperless-ngx");
    expect(published.main).toBe("./src/index.js");
    // Nothing may be left to install: the loader unpacks the tarball alone.
    expect(published.dependencies).toEqual({});
    expect(published.license).toBe("AGPL-3.0-only");

    // The UI reads translations out of the bundle; esbuild cannot see the file
    // from the entry point, so only the copy step puts it in the tarball.
    const i18n = JSON.parse(
      await readFile(join(bundleDir, "src", "i18n", "translation.json"), "utf8"),
    ) as Record<string, string>;
    expect(i18n["Paperless-ngx"]).toBe("Paperless-ngx");
  });

  it("produces metadata in the shape the catalog serves", async () => {
    const { piece } = await connectors!.loadPieceFromDir(bundleDir);
    const metadata = (
      piece as unknown as { metadata(): Record<string, unknown> }
    ).metadata();

    expect(metadata).toMatchObject({
      displayName: "Paperless-ngx",
      categories: ["CONTENT_AND_FILES"],
    });
    expect(String(metadata.logoUrl)).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Object.keys(metadata.actions as object)).toHaveLength(9);
    expect(Object.keys(metadata.triggers as object)).toHaveLength(2);
  });

  it("runs an action inside the forked worker against a live server", async () => {
    const worker = new connectors!.PieceWorker();
    try {
      const document = mock.seedDocument({ title: "Worker Round Trip" });
      const result = await worker.runAction({
        bundleDir,
        actionName: "get_document",
        propsValue: { id: document.id },
        auth: {
          type: "CUSTOM_AUTH",
          props: { base_url: mock.baseUrl, token: "test-token" },
        },
      });

      expect(result.output).toMatchObject({
        id: document.id,
        title: "Worker Round Trip",
      });
      // The OCR text never crosses the boundary unless asked for.
      expect(result.output).not.toHaveProperty("content");
      expect(result.tlsPoisoned).toBe(false);
    } finally {
      worker.dispose();
    }
  }, 60_000);

  it("answers check-connection with an account label", async () => {
    const worker = new connectors!.PieceWorker();
    try {
      const result = await worker.checkConnection({
        bundleDir,
        auth: {
          type: "CUSTOM_AUTH",
          props: { base_url: mock.baseUrl, token: "test-token" },
        },
      });

      const outcome = result.output as {
        declared: boolean;
        result?: { name?: string };
      };
      expect(outcome.declared).toBe(true);
      expect(outcome.result?.name).toMatch(/^archivist@/);
    } finally {
      worker.dispose();
    }
  }, 60_000);

  it("reports a rejected token as a piece error, not a crash", async () => {
    const worker = new connectors!.PieceWorker();
    try {
      await expect(
        worker.runAction({
          bundleDir,
          actionName: "get_document",
          propsValue: { id: 1 },
          auth: {
            type: "CUSTOM_AUTH",
            props: { base_url: mock.baseUrl, token: "wrong" },
          },
        }),
      ).rejects.toMatchObject({
        serialized: {
          name: "PaperlessApiError",
          properties: { status: 401, category: "credential" },
        },
      });
    } finally {
      worker.dispose();
    }
  }, 60_000);
});
