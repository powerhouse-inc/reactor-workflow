// Builds one piece package into the shape a reactor loads: `ph build`'s node
// half, which is the only half a package of pieces has.

// The browser build has no entry here and the Tailwind step no stylesheet;
// `ph build` fails on the first rather than skipping it.

// Entry list, externals, layout and the piece build itself come from the same
// modules `ph build` uses, so a piece lands where the monorepo's does.
import { buildNodeBuildConfig } from "@powerhousedao/shared/build-config";
import {
  assertPiecesOutDir,
  buildPieces,
  pieceListPath,
  planPieces,
  syncDistManifest,
} from "@powerhousedao/shared/build-pieces";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { build } from "tsdown";

const root = process.cwd();
const read = async (file) =>
  JSON.parse(await readFile(path.join(root, file), "utf8"));

const pkg = await read("package.json");
const manifest = await read("powerhouse.manifest.json");

// Connect and the registry resolve an installed package by its manifest name,
// so a mismatch breaks resolution silently. `ph build` asserts this too.
if (manifest.name !== pkg.name) {
  console.error(
    `powerhouse.manifest.json names "${manifest.name}", package.json names "${pkg.name}"`,
  );
  process.exit(1);
}

// `dist` is a contract, not a preference: a host reads a piece from
// dist/node/pieces/<name>, and a list entry names that path literally.
const outDir = "dist";
const target = { projectRoot: root, outDir, pieces: planPieces(root, outDir) };
assertPiecesOutDir(target);

// `sharedDeps: false`: the shared externals assume a host that provides them,
// and a piece runs in a bare forked worker that provides nothing.
await build({
  ...buildNodeBuildConfig({ sharedDeps: false }),
  outDir: path.join(root, outDir, "node"),
});

// The `pieces/` entry list lives in the shared build config, so a package can
// declare a piece, build cleanly, and ship without it — silently.
const listPath = pieceListPath(target);
if (!existsSync(listPath)) {
  console.error(
    `pieces: ${path.relative(root, listPath)} was not built.\n` +
      "The build config that carries pieces/ ships in @powerhousedao/shared; " +
      "a version without it builds every other module kind and skips this one.",
  );
  process.exit(1);
}

// Bundling each piece, describing it and writing its package.json moved out of
// the node build and into this step in 6.2.3-dev.14; the node build alone now
// emits only the list.
const built = await buildPieces(
  target,
  { name: pkg.name, version: pkg.version, license: pkg.license },
  { bundle: build },
);

// Writes dist/powerhouse.manifest.json with each piece's version, bundle and
// descriptor filled in — what the registry indexes and a host resolves through.
syncDistManifest(target, built);

// The node build runs with `dts: false` — a bundler cannot type a piece whose
// framework it inlines — so `tsc` writes what the export map's `types` name.
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
