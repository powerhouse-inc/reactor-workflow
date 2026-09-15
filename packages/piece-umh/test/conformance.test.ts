// Tier-1 conformance: the acceptance gate for the bundle. The published
// artifact has to load through the reactor's own duck-typed loader, describe
// into a connector descriptor, and execute inside the forked worker — that, not
// our esbuild config, is the definition of a valid bundle.
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as ReactorConnectors from "@powerhousedao/reactor-connectors";
import { machine, order, startMockUmh, type MockUmh } from "./mock-umh";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// `dist/` is the tarball root, so the gate loads exactly what npm would ship —
// the emitted package.json included, rather than one written here to suit.
const distDir = join(packageRoot, "dist");
const bundleFile = join(distDir, "src", "index.js");

// The reactor's loader and worker live in the connectors package; a workspace
// that has not built it yet skips rather than fails.
type Connectors = typeof ReactorConnectors;
let connectors: Connectors | undefined;
try {
  connectors = await import("@powerhousedao/reactor-connectors");
} catch {
  connectors = undefined;
}

const ready = connectors !== undefined && existsSync(bundleFile);

let cacheDir = "";
let bundleDir = "";
let published: {
  name: string;
  version: string;
  main: string;
  dependencies: Record<string, string>;
  license?: string;
};
let mock: MockUmh;

function authFor(baseUrl: string) {
  return { type: "CUSTOM_AUTH", props: { base_url: baseUrl } };
}

describe.skipIf(!ready)("bundle conformance", () => {
  beforeAll(async () => {
    published = JSON.parse(
      await readFile(join(distDir, "package.json"), "utf8"),
    ) as typeof published;
    cacheDir = await mkdtemp(join(tmpdir(), "umh-conformance-"));
    // The layout ensurePieceBundle resolves: <cacheDir>/<name>-<version>.
    bundleDir = join(
      cacheDir,
      `${published.name.replace("/", "-")}-${published.version}`,
    );
    await cp(distDir, bundleDir, { recursive: true });
    mock = await startMockUmh({
      orders: [order({ id: "order-1", good_qty: 90, scrap_qty: 10 })],
      machines: [
        machine({ run_time_sec: 900, down_time_sec: 100, cycle_count: 90 }),
      ],
    });
  }, 60_000);

  afterAll(async () => {
    await mock.close();
  });

  it("loads through the reactor's duck-typed loader", async () => {
    const loaded = await connectors!.loadPieceFromDir(bundleDir);

    expect(loaded.check).toBe("constructor-name");
    expect(loaded.piece.displayName).toBe("UMH Factory Floor");
    // keepNames must survive bundling, or the constructor-name check fails.
    expect(loaded.piece.constructor.name).toBe("Piece");
  });

  it("describes into a connector descriptor with polling triggers and live pickers", async () => {
    const { piece } = await connectors!.loadPieceFromDir(bundleDir);
    const descriptor = connectors!.buildDescriptor(piece, {
      packageName: published.name,
      version: published.version,
    });

    expect(descriptor.actions.map((action) => action.name).sort()).toEqual([
      "cancel_order",
      "create_order",
      "custom_api_call",
      "get_order",
      "get_order_actuals",
      "list_lines",
      "list_machines",
      "list_orders",
      "set_order_status",
    ]);
    // The strategy is what decides which driver the runtime arms; a webhook
    // spelling here would wait forever for a delivery the floor cannot send.
    expect(
      descriptor.triggers.map((trigger) => [trigger.name, trigger.strategy]),
    ).toEqual([
      ["order_progressed", "POLLING"],
      ["order_closed", "POLLING"],
      ["new_order", "POLLING"],
    ]);
    expect(descriptor.auth).toMatchObject({ type: "CUSTOM_AUTH" });

    const create = descriptor.actions.find(
      (action) => action.name === "create_order",
    );
    const part = create?.props.find((prop) => prop.name === "product_id");
    expect(part?.type).toBe("DROPDOWN");
    // The editor only offers a live picker when the resolver is recorded.
    expect(part?.hasDynamicResolver).toBe(true);
  });

  it("ships a publishable tarball with nothing left to install", () => {
    expect(published.name).toBe("@powerhousedao/piece-umh");
    expect(published.main).toBe("./src/index.js");
    // Nothing may be left to install: the loader unpacks the tarball alone.
    expect(published.dependencies).toEqual({});
    expect(published.license).toBe("AGPL-3.0-only");
  });

  it("runs an action inside the forked worker against a live floor", async () => {
    const worker = new connectors!.PieceWorker();
    try {
      const result = await worker.runAction({
        bundleDir,
        actionName: "get_order_actuals",
        propsValue: { order_id: "order-1", include_oee: true },
        auth: authFor(mock.baseUrl),
      });

      expect(result.output).toMatchObject({
        orderId: "order-1",
        quantityCompleted: 90,
        qualityPct: 90,
        oeePct: 72.9,
        bottleneckMachine: "robot-welder-1",
      });
      expect(result.tlsPoisoned).toBe(false);
    } finally {
      worker.dispose();
    }
  }, 60_000);

  it("answers check-connection with the size of the floor", async () => {
    const worker = new connectors!.PieceWorker();
    try {
      const result = await worker.checkConnection({
        bundleDir,
        auth: authFor(mock.baseUrl),
      });

      const outcome = result.output as {
        declared: boolean;
        result?: { name?: string };
      };
      expect(outcome.declared).toBe(true);
      expect(outcome.result?.name).toMatch(/^1 lines, 1 machines @ 127\.0\.0\.1:/);
    } finally {
      worker.dispose();
    }
  }, 60_000);
});
