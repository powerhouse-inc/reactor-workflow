// The floor's arithmetic: quality from an order's own counts, and OEE from the
// machine counters of the line running it.

// Every figure here is either measured or null. Nothing is defaulted to zero:
// a zero OEE claims the line stood still, and a line whose cycle time is not
// configured has an OEE nobody measured. Those are different facts, and the
// evidence trail this feeds is append-only — a fabricated zero cannot be taken
// back later.
import type { FloorMachine, FloorOrder } from "./types";

export interface LineOee {
  availabilityPct: number;
  performancePct: number;
  qualityPct: number | null;
  /** Null while quality is unknown: OEE is the product of all three factors. */
  oeePct: number | null;
  /** The machine the figures were taken from — the line's constraint. */
  bottleneckMachine: string;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// The share of counted pieces that were good. Null until something is counted:
// an order that has produced nothing has no quality, and reporting 100% (or 0%)
// would be an opinion about a run that has not started.
export function qualityPctOf(order: {
  good_qty: number;
  scrap_qty: number;
}): number | null {
  const counted = order.good_qty + order.scrap_qty;
  if (counted <= 0) return null;
  return round1((order.good_qty / counted) * 100);
}

// The machine's configured ideal cycle time, in seconds. The simulator carries
// it on the machine's tag map in milliseconds; a machine without it cannot have
// its performance measured.
function idealCycleSec(machine: FloorMachine): number | null {
  const ms = machine.tags?.cycle_time_ms;
  return typeof ms === "number" && ms > 0 ? ms / 1000 : null;
}

// Availability x performance x quality for one line, reported from its
// BOTTLENECK machine (the lowest OEE on the line).
//
// A serial line cannot run better than its constraint, and taking one real
// machine keeps the three factors internally consistent: averaging them across
// machines blends different denominators into a number no machine reported.
//
// Availability comes from the machine's own run/down clocks rather than from a
// shift window. The TimescaleDB view divides runtime by a 24-hour shift, which
// reads ~0.4% for a three-minute order and would manufacture a breach out of a
// perfectly good run.
//
// Machines that have not run, or expose no cycle time, are skipped rather than
// scored zero — their performance is unmeasurable, not zero. With nothing
// measurable on the line the result is null, and the caller records "not
// measured".
export function lineOee(
  machines: FloorMachine[],
  lineInstanceId: string,
  qualityPct: number | null,
): LineOee | null {
  let worst: LineOee | null = null;
  let worstScore = Number.POSITIVE_INFINITY;

  for (const machine of machines) {
    if (machine.line_instance_id !== lineInstanceId) continue;
    const uptime = machine.run_time_sec + machine.down_time_sec;
    const cycleSec = idealCycleSec(machine);
    if (uptime <= 0 || machine.run_time_sec <= 0 || cycleSec === null) continue;

    const availabilityPct = round1((machine.run_time_sec / uptime) * 100);
    // Capped at 100: a machine beating its own ideal cycle time means the
    // ideal is stale, not that it produced more than it could.
    const performancePct = round1(
      Math.min(
        100,
        ((machine.cycle_count * cycleSec) / machine.run_time_sec) * 100,
      ),
    );
    // Ranked on availability x performance rather than on OEE, so the
    // constraint is identified the same way whether or not quality is known
    // yet: quality is the order's, identical for every machine on the line, so
    // it cannot change which machine is worst.
    const score = availabilityPct * performancePct;
    if (score < worstScore) {
      worstScore = score;
      worst = {
        availabilityPct,
        performancePct,
        qualityPct,
        // The product of the three, or null while one of them is unmeasured.
        // Availability and performance are still reported: withholding two
        // measured factors because a third is missing loses real evidence.
        oeePct:
          qualityPct === null
            ? null
            : round1((availabilityPct * performancePct * qualityPct) / 10_000),
        bottleneckMachine: machine.id,
      };
    }
  }

  return worst;
}

/** What one poll of an order says about how the run is going. */
export interface OrderActuals {
  orderId: string;
  partNumber: string;
  line: string;
  lineTemplate: string | null;
  plannedQuantity: number;
  quantityCompleted: number;
  quantityScrap: number;
  qualityPct: number | null;
  availabilityPct: number | null;
  performancePct: number | null;
  oeePct: number | null;
  bottleneckMachine: string | null;
  statusRaw: string;
  startedAt: string | null;
  closedAt: string | null;
  capturedAt: string;
}

// One order plus the OEE of the line running it, in the shape an evidence
// record wants. `machines` is optional because a caller that does not need the
// OEE factors should not pay for a second request — the factors then read null,
// which is the same "not measured" the line-with-no-cycle-time case produces.
export function orderActuals(
  order: FloorOrder,
  machines: FloorMachine[] | undefined,
  capturedAt: string,
): OrderActuals {
  const qualityPct = qualityPctOf(order);
  // Asked for whatever quality is known, including none: a run that has not
  // produced yet still has machines whose availability and performance are
  // being measured, and those belong in the record.
  const oee = machines
    ? lineOee(machines, order.line_instance_id, qualityPct)
    : null;
  return {
    orderId: order.id,
    partNumber: order.product_id,
    line: order.line_instance_id,
    lineTemplate: order.line_template ?? null,
    plannedQuantity: order.planned_qty,
    quantityCompleted: order.good_qty,
    quantityScrap: order.scrap_qty,
    qualityPct,
    availabilityPct: oee?.availabilityPct ?? null,
    performancePct: oee?.performancePct ?? null,
    oeePct: oee?.oeePct ?? null,
    bottleneckMachine: oee?.bottleneckMachine ?? null,
    statusRaw: order.status,
    startedAt: order.started_at ?? null,
    closedAt: order.closed_at ?? null,
    capturedAt,
  };
}
