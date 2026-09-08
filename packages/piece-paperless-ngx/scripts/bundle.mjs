// Builds the self-contained CJS bundle the reactor's `loadPiece` expects:
// framework and deps inlined, `keepNames` so the constructor-name duck type
// still identifies the piece, node20 target. Mirrors what the Activepieces
// CLI's own `bundle` step produces, under our control (design R9).
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "index.js");

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
await writeFile(
  path.join(root, "dist", "bundle-meta.json"),
  JSON.stringify({ bytes, target: "node20", format: "cjs" }, null, 2),
);
console.log(`bundled ${outfile} (${bytes} bytes)`);
