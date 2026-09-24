// Tier-1 conformance (spec D8): what the node build emits loads and describes
// through the reactor's real loader and descriptor, and the registry finds it

// where a reactor looks — the built pieces manifest. `pnpm test` builds first,
// so the gate reads this run's output rather than a stale one.
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildDescriptor,
  loadPieceFromDir,
  PieceRegistry,
} from "@powerhousedao/reactor-workflow/testing";
import type {
  LocalPiece,
  PackagePiece,
} from "@powerhousedao/reactor-workflow/testing";
import { startMockDocling } from "./mock-docling-serve.js";

const packageRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const PIECE = "@powerhousedao/piece-docling";
const VERSION = "1.0.0";
const entryPath = path.join(
  packageRoot,
  "dist/node/pieces/docling/index.mjs",
);

// The built list a host imports to learn what this package ships.
const listPath = path.join(packageRoot, "dist/node/pieces/index.mjs");

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
    ...(piece.entry ? { entryPath: path.join(packageRoot, piece.entry) } : {}),
    ...(piece.bundle
      ? { bundleDir: path.join(packageRoot, piece.bundle) }
      : {}),
  }));
}

const ready = existsSync(entryPath);

// `loadPieceFromDir` resolves an entry out of a package root and the build
// emits a bare module, so the gate gives it the root it asks for.
async function stagePiece(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "docling-conform-"));
  await copyFile(entryPath, path.join(dir, "index.mjs"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: PIECE, version: VERSION, main: "./index.mjs" }),
  );
  return dir;
}

describe.skipIf(!ready)("piece conformance (Tier-1)", () => {
  let bundleDir = "";

  beforeAll(async () => {
    bundleDir = await stagePiece();
  });

  it("loads via the reactor duck-typed loader", async () => {
    const loaded = await loadPieceFromDir(bundleDir);
    expect(loaded.check).toBe("constructor-name");
    expect(loaded.piece.displayName).toBe("Docling");
  });

  it("declares itself where a reactor reads it, with nothing left to install", async () => {
    const registry = new PieceRegistry();
    registry.setPieces(await declaredPieces());
    expect(registry.lookup(PIECE)).toMatchObject({
      name: PIECE,
      version: VERSION,
      entryPath,
    });

    const manifest = JSON.parse(
      await readFile(
        path.join(packageRoot, "dist/powerhouse.manifest.json"),
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

  it("descriptor exposes the CUSTOM_AUTH auth and the health action", async () => {
    const loaded = await loadPieceFromDir(bundleDir);
    const descriptor = buildDescriptor(loaded.piece, {
      packageName: PIECE,
      version: VERSION,
    });
    expect(descriptor.auth?.type).toBe("CUSTOM_AUTH");
    expect(descriptor.actions.map((a) => a.name)).toContain("health");
  });

  it("checks and labels a connection through the built auth's own hooks", async () => {
    const loaded = await loadPieceFromDir(bundleDir);
    const auth = (
      loaded.piece as unknown as {
        auth?: {
          validate?: (ctx: unknown) => Promise<unknown>;
          getConnectionIdentifier?: (ctx: unknown) => Promise<unknown>;
        };
      }
    ).auth;
    expect(loaded.piece).not.toHaveProperty("checkConnection");
    const mock = await startMockDocling({ apiKey: "k-test" });
    try {
      const server = { apiUrl: "", publicUrl: "" };
      const good = { base_url: mock.baseUrl, api_key: "k-test" };
      await expect(auth?.validate?.({ auth: good, server })).resolves.toEqual({
        valid: true,
      });
      await expect(
        auth?.getConnectionIdentifier?.({ auth: good, server }),
      ).resolves.toBe("docling-serve 1.32.0");
      await expect(
        auth?.validate?.({
          auth: { base_url: mock.baseUrl, api_key: "bad" },
          server,
        }),
      ).resolves.toMatchObject({ valid: false });
    } finally {
      await mock.close();
    }
  });

  it("describes all six actions with their props", async () => {
    const loaded = await loadPieceFromDir(bundleDir);
    const descriptor = buildDescriptor(loaded.piece, {
      packageName: PIECE,
      version: VERSION,
    });
    const names = descriptor.actions.map((a) => a.name).sort();
    expect(names).toEqual([
      "chunk",
      "convert_file",
      "convert_url",
      "get_result",
      "health",
      "submit_job",
    ]);
    type ActionDescriptor = { name: string; props: { name: string }[] };
    const byName = Object.fromEntries(
      descriptor.actions.map(
        (action: { name: string }): [string, ActionDescriptor] => [
          action.name,
          action as ActionDescriptor,
        ],
      ),
    ) as Record<string, ActionDescriptor>;
    expect(byName["convert_file"].props.map((p) => p.name)).toContain("file");
    expect(byName["submit_job"].props.map((p) => p.name)).toEqual(
      expect.arrayContaining(["file", "url", "format"]),
    );
  });
});
