// 0.32.0's `outputSchema` is a UI field descriptor list, not a validator: the
// reactor feeds it to `fromOutputSchema` (output-tree.ts) to build the
// expression picker's tree, and the Activepieces builder shows the same names.
// Paths follow each field's `value` — the real path into what `run()` returns —
// so a nested field is spelled with dots rather than nested by hand.
//
// Structurally the framework's `OutputSchemaField`, restated here because
// 0.32.0 does not re-export it from its entry point and a deep import into the
// tarball's internals is not a contract. `format` is a *display* hint, not a
// type: object and array are inferred from `children`/`listItems` instead.
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

// DocumentSerializer's field list. `content` is present only when the action
// was asked for it (D11: it holds the whole OCR text), and `archived_file_name`
// — not the model's internal `has_archive_version` — is how a client learns an
// archive copy exists (C7).
export const documentFields: OutputField[] = [
  { key: "id", label: "ID", format: "number" },
  { key: "title", label: "Title" },
  {
    key: "content",
    label: "Content",
    description:
      "The full extracted text. Omitted unless the step asked to include it.",
  },
  { key: "correspondent", label: "Correspondent ID", format: "number" },
  { key: "document_type", label: "Document Type ID", format: "number" },
  { key: "storage_path", label: "Storage Path ID", format: "number" },
  { key: "tags", label: "Tag IDs" },
  { key: "created", label: "Created", format: "datetime" },
  {
    key: "added",
    label: "Added",
    format: "datetime",
    description: "When paperless ingested it.",
  },
  { key: "modified", label: "Modified", format: "datetime" },
  { key: "archive_serial_number", label: "Archive Serial Number" },
  { key: "original_file_name", label: "Original File Name" },
  {
    key: "archived_file_name",
    label: "Archived File Name",
    description: "null when the document has no archive (OCR'd) copy.",
  },
  { key: "mime_type", label: "MIME Type" },
  { key: "owner", label: "Owner ID", format: "number" },
  { key: "custom_fields", label: "Custom Fields" },
];

// A field list for an action whose whole output *is* the document.
const asWholeOutput = (fields: OutputField[]): OutputField[] =>
  fields.map((field) => ({ ...field, value: field.key }));

export const documentOutputFields = asWholeOutput(documentFields);

// One document nested under `prefix`, for the actions that wrap it.
const documentUnder = (prefix: string): OutputField[] =>
  documentFields.map((field) => ({
    ...field,
    value: `${prefix}.${field.key}`,
  }));

export const uploadOutputFields: OutputField[] = [
  {
    key: "task_id",
    label: "Task ID",
    value: "task_id",
    description: "The consumption task; a later Get task step can read it.",
  },
  {
    key: "status",
    label: "Status",
    value: "status",
    description:
      "Lowercased: success | failure | pending | started | revoked (2.18 reports these uppercase).",
  },
  {
    key: "document_id",
    label: "Document ID",
    value: "document_id",
    format: "number",
  },
  {
    key: "adopted",
    label: "Adopted",
    value: "adopted",
    format: "boolean",
    description:
      "true when this attempt resumed a task an earlier attempt had already started, rather than uploading again (C4).",
  },
  {
    key: "timed_out",
    label: "Timed Out",
    value: "timed_out",
    format: "boolean",
    description:
      "Present and true when the wait budget elapsed before consumption finished. Not a failure — the task id is still the handle.",
  },
  ...documentUnder("document"),
];

export const getDocumentOutputFields = documentOutputFields;
export const updateDocumentOutputFields = documentOutputFields;

export const searchOutputFields: OutputField[] = [
  { key: "count", label: "Total Count", value: "count", format: "number" },
  {
    key: "next",
    label: "Next Page URL",
    value: "next",
    format: "url",
    description: "null on the last page.",
  },
  {
    key: "previous",
    label: "Previous Page URL",
    value: "previous",
    format: "url",
  },
  {
    key: "results",
    label: "Results",
    value: "results",
    listItems: documentFields,
  },
];

export const getDocumentFileOutputFields: OutputField[] = [
  {
    key: "ref",
    label: "File",
    value: "ref",
    description:
      "The attachment reference to pass to a later step's file input.",
  },
  { key: "filename", label: "File Name", value: "filename" },
  { key: "mime_type", label: "MIME Type", value: "mime_type" },
  { key: "size", label: "Size", value: "size", format: "filesize" },
  {
    key: "variant_requested",
    label: "Variant Requested",
    value: "variant_requested",
    description:
      "archive | original | thumbnail. Archive falls back to the original when the document has none.",
  },
];

export const bulkEditOutputFields: OutputField[] = [
  { key: "result", label: "Result", value: "result" },
  {
    key: "documents",
    label: "Document IDs",
    value: "documents",
    description: "The ids the edit was applied to.",
  },
  { key: "method", label: "Method", value: "method" },
];

export const findOrCreateOutputFields: OutputField[] = [
  { key: "id", label: "ID", value: "id", format: "number" },
  { key: "name", label: "Name", value: "name" },
  {
    key: "created",
    label: "Created",
    value: "created",
    format: "boolean",
    description: "false when an existing object matched the name.",
  },
  {
    key: "object_type",
    label: "Object Type",
    value: "object_type",
    description:
      "tags | correspondents | document_types | storage_paths | custom_fields.",
  },
];

export const getTaskOutputFields: OutputField[] = [
  { key: "task_id", label: "Task ID", value: "task_id" },
  {
    key: "status",
    label: "Status",
    value: "status",
    description:
      'Lowercased across versions; "unknown" when the server has no such task.',
  },
  { key: "task_type", label: "Task Type", value: "task_type" },
  {
    key: "document_ids",
    label: "Document IDs",
    value: "document_ids",
    description:
      "v10's related_document_ids and v9's related_document, merged.",
  },
  {
    key: "document_id",
    label: "First Document ID",
    value: "document_id",
    format: "number",
  },
  { key: "filename", label: "File Name", value: "filename" },
  { key: "result", label: "Result Message", value: "result" },
  { key: "date_created", label: "Created", format: "datetime" },
  { key: "date_done", label: "Finished", format: "datetime" },
  {
    key: "raw",
    label: "Raw Task Row",
    value: "raw",
    description: "The server's own row, for fields this piece does not map.",
  },
];

export const customApiCallOutputFields: OutputField[] = [
  { key: "status", label: "HTTP Status", value: "status", format: "number" },
  {
    key: "body",
    label: "Response Body",
    value: "body",
    description: "null when the response carried no body.",
  },
];

// A trigger emits the document itself, plus the event and the dedupe key the
// supervisor claims. `content` obeys the trigger's own include-content prop.
export const documentTriggerOutputFields: OutputField[] = [
  ...documentOutputFields,
  {
    key: "event",
    label: "Event",
    value: "event",
    description: "DOCUMENT_ADDED or DOCUMENT_UPDATED.",
  },
  {
    key: "_dedupe_key",
    label: "Dedupe Key",
    value: "_dedupe_key",
    description:
      "<id>:<event>:<modified> — how a paperless webhook retry is collapsed while a genuine second edit still fires.",
  },
];
