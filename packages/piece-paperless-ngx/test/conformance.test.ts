// Tier-1 conformance: the acceptance gate for the built piece. What the node
// build emits has to load through the reactor's own duck-typed loader,

// describe into a piece descriptor, and execute an action inside the forked
// worker — that, not our build config, is the definition of a valid piece.
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDescriptor,
  loadPieceFromDir,
  PieceRegistry,
  PieceWorker,
} from "@powerhousedao/reactor-workflow/testing";
import type {
  LocalPiece,
  PackagePiece,
} from "@powerhousedao/reactor-workflow/testing";
import type { MockPaperless } from "./mock-paperless";
import { startMockPaperless } from "./mock-paperless";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PIECE = "@powerhousedao/piece-paperless-ngx";
const VERSION = "0.1.0";
const entryPath = join(
  packageRoot,
  "dist",
  "node",
  "pieces",
  "paperless-ngx",
  "index.mjs",
);

// The built list a host imports to learn what this package ships.
const listPath = join(packageRoot, "dist", "node", "pieces", "index.mjs");

// What a host does with this package installed: import the built list and
// hand it to the registry. Resolving a package to that list is reactor-api's
// job since powerhouse#3056, so the registry holds what it is given.
async function declaredPieces(): Promise<LocalPiece[]> {
  const { pieces } = (await import(pathToFileURL(listPath).href)) as {
    pieces: PackagePiece[];
  };
  return pieces.map((piece) => ({
    name: piece.name,
    version: piece.version,
    ...(piece.entry ? { entryPath: join(packageRoot, piece.entry) } : {}),
    ...(piece.bundle ? { bundleDir: join(packageRoot, piece.bundle) } : {}),
  }));
}

// A workspace that has not built yet skips rather than fails; `pnpm test`
// builds first, and so does CI.
const ready = existsSync(entryPath);

let declared: LocalPiece | undefined;
let bundleDir = "";
let mock: MockPaperless;

// `loadPieceFromDir` resolves an entry out of a package root and the build
// emits a bare module, so the gate gives it the root it asks for.
async function stagePiece(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paperless-conformance-"));
  await copyFile(entryPath, join(dir, "index.mjs"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: PIECE, version: VERSION, main: "./index.mjs" }),
  );
  return dir;
}

describe.skipIf(!ready)("piece conformance", () => {
  beforeAll(async () => {
    const registry = new PieceRegistry();
    registry.setPieces(await declaredPieces());
    declared = registry.lookup(PIECE);
    bundleDir = await stagePiece();
    mock = await startMockPaperless();
  }, 60_000);

  afterAll(async () => {
    await mock.close();
  });

  it("loads through the reactor's duck-typed loader", async () => {
    const loaded = await loadPieceFromDir(bundleDir);

    expect(loaded.check).toBe("constructor-name");
    expect(loaded.piece.displayName).toBe("Paperless-ngx");
    // The loader identifies a piece by its constructor's name, so the build
    // must not mangle it.
    expect(loaded.piece.constructor.name).toBe("Piece");
  });

  it("describes into a piece descriptor with real props and pickers", async () => {
    const { piece } = await loadPieceFromDir(bundleDir);
    const descriptor = buildDescriptor(piece, {
      packageName: PIECE,
      version: VERSION,
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
    expect(bulk?.props.find((prop) => prop.name === "parameters")?.type).toBe(
      "DYNAMIC",
    );
  });

  it("declares itself where a reactor reads it, with nothing left to install", async () => {
    // The registry found the piece through the built manifest, which is the
    // only path a reactor takes to it.
    expect(declared).toMatchObject({ name: PIECE, version: VERSION });
    expect(declared?.entryPath).toBe(entryPath);

    const manifest = JSON.parse(
      await readFile(
        join(packageRoot, "dist", "powerhouse.manifest.json"),
        "utf8",
      ),
    ) as { name: string; pieces: { id: string }[] };
    expect(manifest.name).toBe(PIECE);
    expect(manifest.pieces.map((piece) => piece.id)).toEqual([PIECE]);

    // The worker loads this module with nothing installed beside it, so the
    // framework has to be inlined rather than imported.
    const built = await readFile(entryPath, "utf8");
    expect(built).not.toMatch(/from\s+"@powerhousedao\//);
  });

  it("produces metadata in the shape the catalog serves", async () => {
    const { piece } = await loadPieceFromDir(bundleDir);
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
    const worker = new PieceWorker();
    try {
      const document = mock.seedDocument({ title: "Worker Round Trip" });
      const result = await worker.runAction({
        entryPath,
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
    const worker = new PieceWorker();
    try {
      const result = await worker.checkConnection({
        entryPath,
        auth: {
          type: "CUSTOM_AUTH",
          props: { base_url: mock.baseUrl, token: "test-token" },
        },
      });

      const outcome = result.output as {
        declared: boolean;
        valid: boolean;
        accountLabel?: string;
      };
      expect(outcome).toMatchObject({ declared: true, valid: true });
      expect(outcome.accountLabel).toMatch(/^archivist@/);
    } finally {
      worker.dispose();
    }
  }, 60_000);

  it("reports a rejected token as a piece error, not a crash", async () => {
    const worker = new PieceWorker();
    try {
      await expect(
        worker.runAction({
          entryPath,
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
