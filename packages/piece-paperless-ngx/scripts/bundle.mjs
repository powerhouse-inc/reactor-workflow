// Builds the self-contained CJS bundle the reactor's `loadPiece` expects:
// framework and deps inlined, `keepNames` so the constructor-name duck type
// still identifies the piece, node20 target. Mirrors what the Activepieces
// CLI's own `bundle` step produces, under our control (design R9).
//
// The emitted tree *is* the tarball root — `package.json` + `src/` — so what
// the conformance gate loads is byte-for-byte what `npm publish` ships:
//   node scripts/bundle.mjs [--out DIR] [--name NAME]
// `--name` renames the published package without touching the workspace
// identity, which is all a `community/paperless-ngx` port needs.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      // `npm publish ./dist` reads *this* file, so the scoped package needs
      // its own access flag here — the workspace one never gets consulted.
      publishConfig: pkg.publishConfig,
    },
    null,
    2,
  ) + "\n",
);

// i18n is a data file the Activepieces UI reads out of the bundle; nothing
// imports it, so esbuild never sees it from the entry point.
await mkdir(path.join(outDir, "src", "i18n"), { recursive: true });
await copyFile(
  path.join(root, "src", "i18n", "translation.json"),
  path.join(outDir, "src", "i18n", "translation.json"),
);

console.log(`bundled ${outfile} (${bytes} bytes)`);
