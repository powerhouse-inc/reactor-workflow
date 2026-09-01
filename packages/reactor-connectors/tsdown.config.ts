import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "worker-entry": "src/activepieces/worker/entry.ts",
  },
  outDir: "dist",
  platform: "node",
  outExtensions: () => ({ js: ".js" }),
  clean: true,
  dts: true,
  sourcemap: true,
});
