// 0.32.0's `outputSchema` is a UI field descriptor list, not a validator: the
// reactor feeds it to `fromOutputSchema` (output-tree.ts) to build the
// expression picker's tree, and the Activepieces builder shows the same names.
// Paths follow each field's `value` — the real path into what `run()` returns —
// so a nested field is spelled with dots rather than nested by hand.
//
// Structurally the framework's `OutputSchemaField`, restated here because
// 0.32.0 does not re-export it from its entry point and a deep import into the
// tarball's internals is not a contract.
export type FieldFormat =
  | "email"
  | "url"
  | "date"
  | "datetime"
  | "number"
  | "boolean"
  | "image"
  | "html"
  | "currency"
  | "filesize"
  | "duration";

export interface OutputField {
  key: string;
  label?: string;
  description?: string;
  value?: string;
  format?: FieldFormat;
  children?: OutputField[];
  listItems?: OutputField[];
}

/** One order as the floor reports it. */
export const orderFields: OutputField[] = [
  { key: "id", label: "Order ID", description: "The floor's UUID for the run." },
  { key: "product_id", label: "Part number" },
  { key: "line_instance_id", label: "Line" },
  { key: "line_template", label: "Line template" },
  {
    key: "status",
    label: "Status",
    description: "CREATED | RELEASED | IN_PROGRESS | CLOSED | CANCELLED",
  },
  { key: "planned_qty", label: "Planned quantity", format: "number" },
  { key: "good_qty", label: "Good quantity", format: "number" },
  { key: "scrap_qty", label: "Scrap quantity", format: "number" },
  { key: "priority", label: "Priority", format: "number" },
  { key: "created_at", label: "Created at", format: "datetime" },
  { key: "started_at", label: "Started at", format: "datetime" },
  { key: "closed_at", label: "Closed at", format: "datetime" },
];

/** The lifecycle the piece derives from `status`. */
export const lifecycleField: OutputField = {
  key: "lifecycle",
  label: "Lifecycle",
  description:
    "PENDING | RUNNING | COMPLETED | CANCELLED | UNKNOWN — the floor's status vocabulary, normalised.",
};

/** What one capture of a run measured. Nulls mean not measured. */
export const actualsFields: OutputField[] = [
  { key: "orderId", label: "Order ID" },
  { key: "partNumber", label: "Part number" },
  { key: "line", label: "Line" },
  { key: "lineTemplate", label: "Line template" },
  { key: "plannedQuantity", label: "Planned quantity", format: "number" },
  { key: "quantityCompleted", label: "Good quantity", format: "number" },
  { key: "quantityScrap", label: "Scrap quantity", format: "number" },
  {
    key: "qualityPct",
    label: "Quality %",
    format: "number",
    description: "Good / counted. Null until something is counted.",
  },
  {
    key: "availabilityPct",
    label: "Availability %",
    format: "number",
    description: "From the bottleneck machine's own run/down clocks.",
  },
  { key: "performancePct", label: "Performance %", format: "number" },
  {
    key: "oeePct",
    label: "OEE %",
    format: "number",
    description:
      "Availability x performance x quality at the line's constraint. Null when no machine on the line is measurable — never 0.",
  },
  {
    key: "bottleneckMachine",
    label: "Bottleneck machine",
    description: "The machine the OEE factors were taken from.",
  },
  { key: "statusRaw", label: "Floor status" },
  { key: "startedAt", label: "Started at", format: "datetime" },
  { key: "closedAt", label: "Closed at", format: "datetime" },
  {
    key: "capturedAt",
    label: "Captured at",
    format: "datetime",
    description: "When the piece read these numbers.",
  },
];

/** A trigger item: the actuals, the raw order, and what changed. */
export const orderEventFields: OutputField[] = [
  ...actualsFields,
  lifecycleField,
  {
    key: "counted",
    label: "Anything counted",
    format: "boolean",
    description:
      "False while the floor has produced neither a good piece nor a scrap one — the same condition that makes Quality % null.",
  },
  {
    key: "changed",
    label: "What changed",
    description: "Which fields moved since the previous poll.",
    children: [
      { key: "good", label: "Good quantity moved", format: "boolean" },
      { key: "scrap", label: "Scrap quantity moved", format: "boolean" },
      { key: "status", label: "Status changed", format: "boolean" },
    ],
  },
  {
    key: "previous",
    label: "Previous reading",
    description: "Absent on the first sighting of an order.",
    children: [
      { key: "good_qty", label: "Good quantity", format: "number" },
      { key: "scrap_qty", label: "Scrap quantity", format: "number" },
      { key: "status", label: "Status" },
    ],
  },
  { key: "order", label: "Order (raw)", children: orderFields },
];
