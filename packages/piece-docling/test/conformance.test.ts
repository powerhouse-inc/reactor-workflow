// Tier-1 conformance (spec D8): our bundle loads and describes through the
// reactor's real loader/descriptor. The bundle is built on demand — the
// bundle script is the single source of the tarball format.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDescriptor, loadPieceFromDir } from "@powerhousedao/reactor-connectors";
import { startMockDocling } from "./mock-docling-serve.js";

const FIX = path.join(tmpdir(), `docling-conform-${process.pid}`);

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function builtBundleDir(): string {
  const dist = path.resolve("dist");
  const bundle = path.join(dist, "src/index.js");
  // Rebuild not only when the bundle is absent but when it is STALE: the
  // newest mtime under src/ or scripts/ postdating the build means a later
  // edit would otherwise pass falsely against the stale bundle.
  const stale =
    !existsSync(bundle) ||
    Math.max(newestMtime(path.resolve("src")), newestMtime(path.resolve("scripts"))) >
      statSync(bundle).mtimeMs;
  if (stale) {
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
      // vitest 4.1.1 types the asymmetric matcher factories as `any`; `as
      // unknown` is the minimal silencer (opaque matcher consumed by expect).
      expect(out).toMatchObject({ name: expect.stringContaining("docling-serve 1.32.0") as unknown });
      await expect(
        check!({
          auth: { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "bad" } },
        }),
      ).rejects.toThrow();
    } finally {
      await mock.close();
    }
  });

  it("describes all six actions with their props", async () => {
    const loaded = await loadPieceFromDir(builtBundleDir());
    const descriptor = buildDescriptor(loaded.piece, {
      packageName: "@powerhousedao/piece-docling",
      version: "1.0.0",
    });
    const names = descriptor.actions.map((a) => a.name).sort();
    expect(names).toEqual(["chunk", "convert_file", "convert_url", "get_result", "health", "submit_job"]);
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
