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
