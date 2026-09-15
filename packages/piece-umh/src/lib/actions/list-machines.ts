import { createAction } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";
import { lineProp } from "../common/pickers";

export const listMachines = createAction({
  auth: umhAuth,
  name: "list_machines",
  displayName: "List machines",
  description:
    "Lists machines with their state and counters — cycles, good, scrap, run and down seconds.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: {
    fields: [
      { key: "count", label: "Count", format: "number" as const },
      {
        key: "machines",
        label: "Machines",
        listItems: [
          { key: "id", label: "Machine" },
          { key: "line_instance_id", label: "Line" },
          { key: "type", label: "Type" },
          { key: "state", label: "State", description: "IDLE | RUNNING | MAINTENANCE | SETUP" },
          { key: "order_id", label: "Current order" },
          { key: "cycle_count", label: "Cycles", format: "number" as const },
          { key: "good_count", label: "Good", format: "number" as const },
          { key: "scrap_count", label: "Scrap", format: "number" as const },
          { key: "run_time_sec", label: "Run seconds", format: "number" as const },
          { key: "down_time_sec", label: "Down seconds", format: "number" as const },
        ],
      },
    ],
  },
  props: {
    line_instance_id: lineProp("Only machines on this line", false),
  },
  async run(context) {
    const { line_instance_id } = context.propsValue;
    const machines = await clientForContext(context).listMachines();
    const matched = line_instance_id
      ? machines.filter(
          (machine) => machine.line_instance_id === line_instance_id,
        )
      : machines;
    return { count: matched.length, machines: matched };
  },
});
