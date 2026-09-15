// Builds the self-contained CJS bundle the reactor's `loadPiece` expects:
// framework and deps inlined, `keepNames` so the constructor-name duck type
// still identifies the piece, node20 target.
//
// The emitted tree *is* the tarball root — `package.json` + `src/` — so what a
// reactor loads from the bundle directory is byte-for-byte what `npm publish`
// would ship:
//   node scripts/bundle.mjs [--out DIR] [--name NAME]
// `--out` is what the reactor-workflow demo uses to build this piece straight
// into a package-piece manifest's bundle directory.
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
// A flag's value, or undefined when the flag is absent. indexOf returns -1 for
// a missing flag, and args[-1 + 1] would silently hand back args[0] — the next
// flag's own name — corrupting the package name.
const flagArg = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const outDir = flagArg("--out") ?? path.join(root, "dist");
const nameArg = flagArg("--name");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const outfile = path.join(outDir, "src", "index.js");

// A leftover from an earlier build must not ride along in the tarball.
await rm(outDir, { recursive: true, force: true });
await mkdir(path.dirname(outfile), { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "src", "index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  keepNames: true,
  sourcemap: false,
  // No externals: the bundle must load with nothing installed beside it.
  external: [],
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
// `dependencies: {}` is the point of the bundle: everything is inlined, so the
// tarball installs with nothing behind it. `main` stays relative for the
// reactor's `resolveEntry`, which reads it straight out of this file.
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
      publishConfig: pkg.publishConfig,
    },
    null,
    2,
  ) + "\n",
);

console.log(`bundled ${outfile} (${bytes} bytes)`);
