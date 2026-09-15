import { createAction } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";

export const listLines = createAction({
  auth: umhAuth,
  name: "list_lines",
  displayName: "List lines",
  description:
    "Lists the floor's production lines with the machines and the parts each one can build.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: {
    fields: [
      { key: "count", label: "Count", format: "number" as const },
      {
        key: "lines",
        label: "Lines",
        listItems: [
          { key: "instance_id", label: "Line" },
          { key: "template_name", label: "Template" },
          { key: "domain", label: "Domain" },
          { key: "machine_ids", label: "Machine IDs" },
          {
            key: "recipes",
            label: "Recipes",
            listItems: [
              { key: "product_id", label: "Part number" },
              { key: "description", label: "Description" },
            ],
          },
        ],
      },
    ],
  },
  props: {},
  async run(context) {
    const lines = await clientForContext(context).listLines();
    return { count: lines.length, lines };
  },
});
