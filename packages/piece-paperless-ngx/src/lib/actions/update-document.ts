import { createAction, Property } from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import { clientForContext } from "../common/context";
import { trimContent } from "../common/documents";
import { objectMultiPicker, objectPicker } from "../common/pickers";
import { updateDocumentOutputFields } from "../common/output-schemas";

export const updateDocument = createAction({
  auth: paperlessAuth,
  name: "update_document",
  displayName: "Update document",
  description: "Changes a document's metadata, adding or removing tags without clobbering the rest.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: { fields: updateDocumentOutputFields },
  props: {
    id: Property.Number({ displayName: "Document ID", required: true }),
    title: Property.ShortText({ displayName: "Title", required: false }),
    created: Property.ShortText({
      displayName: "Created date",
      required: false,
    }),
    correspondent: objectPicker("correspondents"),
    document_type: objectPicker("document_types"),
    storage_path: objectPicker("storage_paths"),
    tags: objectMultiPicker("tags"),
    tag_mode: Property.StaticDropdown({
      displayName: "Tag mode",
      description:
        "A plain PATCH replaces the whole tag list. Add and Remove go through the server-side bulk edit instead, so a concurrent paperless workflow cannot lose a tag.",
      required: false,
      defaultValue: "add",
      options: {
        options: [
          { label: "Add the selected tags", value: "add" },
          { label: "Remove the selected tags", value: "remove" },
          { label: "Replace all tags with the selection", value: "replace" },
        ],
      },
    }),
    archive_serial_number: Property.Number({
      displayName: "Archive serial number",
      required: false,
    }),
    owner: Property.Number({ displayName: "Owner user ID", required: false }),
    custom_fields: Property.Json({
      displayName: "Custom fields",
      description:
        'A list of { "field": <id>, "value": <value> } entries, as the document serializer expects.',
      required: false,
    }),
    include_content: Property.Checkbox({
      displayName: "Include OCR text in the result",
      required: false,
      defaultValue: false,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    const props = context.propsValue as {
      id: number;
      title?: string;
      created?: string;
      correspondent?: number;
      document_type?: number;
      storage_path?: number;
      tags?: number[];
      tag_mode?: "add" | "remove" | "replace";
      archive_serial_number?: number;
      owner?: number;
      custom_fields?: unknown;
      include_content?: boolean;
    };
    const tagMode = props.tag_mode ?? "add";
    const tags = props.tags ?? [];

    // Tag add/remove is a server-side bulk edit rather than a read-modify-write
    // PATCH: paperless's own workflows may be touching the same document.
    if (tags.length > 0 && tagMode !== "replace") {
      await client.request({
        method: "POST",
        path: "documents/bulk_edit/",
        json: {
          documents: [props.id],
          method: "modify_tags",
          parameters:
            tagMode === "add"
              ? { add_tags: tags, remove_tags: [] }
              : { add_tags: [], remove_tags: tags },
        },
      });
    }

    const patch: Record<string, unknown> = {};
    if (props.title !== undefined) patch.title = props.title;
    if (props.created !== undefined) patch.created = props.created;
    if (props.correspondent !== undefined)
      patch.correspondent = props.correspondent;
    if (props.document_type !== undefined)
      patch.document_type = props.document_type;
    if (props.storage_path !== undefined)
      patch.storage_path = props.storage_path;
    if (props.archive_serial_number !== undefined)
      patch.archive_serial_number = props.archive_serial_number;
    if (props.owner !== undefined) patch.owner = props.owner;
    if (props.custom_fields !== undefined && props.custom_fields !== null)
      patch.custom_fields = props.custom_fields;
    if (tagMode === "replace") patch.tags = tags;

    if (Object.keys(patch).length === 0) {
      // Nothing but tags changed; return the document as it now stands.
      const current = await client.request<Record<string, unknown>>({
        path: `documents/${props.id}/`,
      });
      return trimContent(current.data, props.include_content === true);
    }

    const response = await client.request<Record<string, unknown>>({
      method: "PATCH",
      path: `documents/${props.id}/`,
      json: patch,
    });
    return trimContent(response.data, props.include_content === true);
  },
});
