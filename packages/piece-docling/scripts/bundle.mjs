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
