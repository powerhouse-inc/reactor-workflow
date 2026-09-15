// The arithmetic the evidence trail is built on. Every case here is about the
// difference between a number that was measured and one that was invented.
import { describe, expect, it } from "vitest";
import { lineOee, orderActuals, qualityPctOf } from "../src/lib/common/oee";
import { machine, order } from "./mock-umh";

describe("quality", () => {
  it("is null until something is counted", () => {
    expect(qualityPctOf({ good_qty: 0, scrap_qty: 0 })).toBeNull();
  });

  it("is the good share of what was counted", () => {
    expect(qualityPctOf({ good_qty: 97, scrap_qty: 3 })).toBe(97);
    expect(qualityPctOf({ good_qty: 1, scrap_qty: 2 })).toBe(33.3);
  });
});

describe("line OEE", () => {
  it("reports the bottleneck machine, not an average of the line", () => {
    const machines = [
      machine({ id: "fast", run_time_sec: 1000, down_time_sec: 0, cycle_count: 100 }),
      // Half the availability of the other two: the line cannot run better.
      machine({ id: "slow", run_time_sec: 500, down_time_sec: 500, cycle_count: 50 }),
      machine({ id: "middling", run_time_sec: 900, down_time_sec: 100, cycle_count: 90 }),
    ];

    const result = lineOee(machines, "automotive-welding-1", 100);

    expect(result?.bottleneckMachine).toBe("slow");
    expect(result?.availabilityPct).toBe(50);
  });

  it("picks the same bottleneck whether or not quality is known yet", () => {
    // Quality is the order's, identical across the line, so it cannot change
    // which machine is the constraint — only whether OEE can be stated.
    const machines = [
      machine({ id: "fast", run_time_sec: 1000, down_time_sec: 0, cycle_count: 100 }),
      machine({ id: "slow", run_time_sec: 500, down_time_sec: 500, cycle_count: 50 }),
    ];

    const known = lineOee(machines, "automotive-welding-1", 90);
    const unknown = lineOee(machines, "automotive-welding-1", null);

    expect(unknown?.bottleneckMachine).toBe(known?.bottleneckMachine);
    expect(unknown?.availabilityPct).toBe(known?.availabilityPct);
    expect(unknown?.oeePct).toBeNull();
    expect(known?.oeePct).not.toBeNull();
  });

  it("skips machines whose cycle time is not configured rather than scoring them zero", () => {
    const machines = [
      machine({ id: "measurable", run_time_sec: 900, down_time_sec: 100, cycle_count: 90 }),
      // Would be the bottleneck at 0% if it counted — and it produces parts.
      machine({ id: "unmeasurable", tags: {}, good_count: 5000 }),
    ];

    const result = lineOee(machines, "automotive-welding-1", 100);

    expect(result?.bottleneckMachine).toBe("measurable");
  });

  it("is null when no machine on the line can be measured", () => {
    const machines = [machine({ id: "idle", run_time_sec: 0, down_time_sec: 0 })];

    expect(lineOee(machines, "automotive-welding-1", 100)).toBeNull();
  });

  it("ignores machines on other lines", () => {
    const machines = [
      machine({ id: "ours", run_time_sec: 900, down_time_sec: 100, cycle_count: 90 }),
      machine({
        id: "theirs",
        line_instance_id: "window-frame-1",
        run_time_sec: 100,
        down_time_sec: 900,
        cycle_count: 10,
      }),
    ];

    const result = lineOee(machines, "automotive-welding-1", 100);

    expect(result?.bottleneckMachine).toBe("ours");
  });

  it("caps performance at 100 when a machine beats its own ideal cycle", () => {
    // 200 cycles x 9s of ideal work inside 900s of runtime is 200% — which
    // means the configured ideal is stale, not that it made extra parts.
    const machines = [
      machine({ run_time_sec: 900, down_time_sec: 0, cycle_count: 200 }),
    ];

    expect(lineOee(machines, "automotive-welding-1", 100)?.performancePct).toBe(100);
  });
});

describe("order actuals", () => {
  const capturedAt = "2026-09-15T09:00:00.000Z";

  it("reports the factors as not measured when no machines were read", () => {
    const actuals = orderActuals(
      order({ good_qty: 10, scrap_qty: 1 }),
      undefined,
      capturedAt,
    );

    expect(actuals.qualityPct).toBe(90.9);
    expect(actuals.oeePct).toBeNull();
    expect(actuals.availabilityPct).toBeNull();
    expect(actuals.bottleneckMachine).toBeNull();
  });

  it("leaves OEE unmeasured while nothing has been counted, but still reports the factors it measured", () => {
    // Quality is one of the three factors; without it the product is not an
    // OEE of zero, it is an OEE nobody can state yet. Availability and
    // performance are measured all the same, and withholding them because a
    // third factor is missing would throw away real evidence.
    const actuals = orderActuals(order(), [machine()], capturedAt);

    expect(actuals.qualityPct).toBeNull();
    expect(actuals.oeePct).toBeNull();
    expect(actuals.availabilityPct).toBe(90);
    expect(actuals.performancePct).toBe(100);
    expect(actuals.bottleneckMachine).toBe("robot-welder-1");
  });

  it("multiplies the three factors once all of them are measured", () => {
    const actuals = orderActuals(
      order({ good_qty: 90, scrap_qty: 10 }),
      [machine({ run_time_sec: 900, down_time_sec: 100, cycle_count: 90 })],
      capturedAt,
    );

    expect(actuals.qualityPct).toBe(90);
    expect(actuals.availabilityPct).toBe(90);
    expect(actuals.performancePct).toBe(90);
    // 90 x 90 x 90 / 10000.
    expect(actuals.oeePct).toBe(72.9);
  });
});
