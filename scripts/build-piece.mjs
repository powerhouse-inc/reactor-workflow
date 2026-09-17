// Builds one piece package into the shape a reactor loads: `ph build`'s node
// half, which is the only half a package of pieces has.

// The browser build has no entry here and the Tailwind step no stylesheet;
// `ph build` fails on the first rather than skipping it.

// Entry list, externals and layout come from the config `ph build` hands
// tsdown, so a piece lands where the monorepo's does, framework inlined.
import { buildNodeBuildConfig } from "@powerhousedao/shared/build-config";
import { execFileSync } from "node:child_process";
import { copyFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

// `sharedDeps: false`: the shared externals assume a host that provides them,
// and a piece runs in a bare forked worker that provides nothing.
await build({
  ...buildNodeBuildConfig({ sharedDeps: false }),
  outDir: path.join(root, "dist", "node"),
});

// The manifest ships inside dist/ because that is all the tarball carries, and
// `./manifest` in the export map points there.
await copyFile(
  path.join(root, "powerhouse.manifest.json"),
  path.join(root, "dist", "powerhouse.manifest.json"),
);

// The node build runs with `dts: false` — a bundler cannot type a piece whose
// framework it inlines — so `tsc` writes what the export map's `types` name.
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});

// The `pieces/` entry list lives in the shared build config, so a package can
// declare a piece, build cleanly, and ship without it — silently.
const emitted = path.join(root, "dist", "node", "pieces", "index.mjs");
if (!existsSync(emitted)) {
  console.error(
    `pieces: ${path.relative(root, emitted)} was not built.\n` +
      "The build config that carries pieces/ ships in @powerhousedao/shared; " +
      "a version without it builds every other module kind and skips this one.",
  );
  process.exit(1);
}

const { pieces } = await import(pathToFileURL(emitted).href);
for (const piece of pieces ?? []) {
  const where = piece.entry ?? piece.bundle;
  const target = path.join(root, where ?? "");
  const built = piece.entry
    ? existsSync(target)
    : existsSync(path.join(target, "package.json"));
  if (!built) {
    console.error(`pieces: "${piece.name}" declares ${where}, which is missing`);
    process.exit(1);
  }
  // A piece whose version drifts from its package's resolves to the wrong
  // tarball the day these are published.
  if (piece.name === pkg.name && piece.version !== pkg.version) {
    console.error(
      `pieces: "${piece.name}" declares version ${piece.version}, package.json says ${pkg.version}`,
    );
    process.exit(1);
  }
  console.log(`piece: ${piece.name}@${piece.version} -> ${where}`);
}
