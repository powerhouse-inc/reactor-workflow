import { createAction, Property } from "@activepieces/pieces-framework";
import type { InputPropertyMap } from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import { clientForContext } from "../common/context";
import { PaperlessApiError } from "../common/errors";
import { objectMultiPicker, objectPicker } from "../common/pickers";
import { bulkEditOutputFields } from "../common/output-schemas";

// Only the metadata methods. The document-editing ones (delete, reprocess,
// rotate, merge, edit_pdf, split, remove_password) moved to their own
// endpoints and survive on bulk_edit only for API v9 compatibility, so
// modelling them here would model a deprecated path.
const METHODS = [
  "set_correspondent",
  "set_document_type",
  "set_storage_path",
  "add_tag",
  "remove_tag",
  "modify_tags",
  "modify_custom_fields",
] as const;

type Method = (typeof METHODS)[number];

export const bulkEditDocuments = createAction({
  auth: paperlessAuth,
  name: "bulk_edit_documents",
  displayName: "Bulk edit documents",
  description:
    "Applies one metadata change to many documents in a single server-side operation.",
  audience: "both",
  aiMetadata: { idempotent: false },
  outputSchema: { fields: bulkEditOutputFields },
  props: {
    document_ids: Property.Array({
      displayName: "Document IDs",
      required: true,
    }),
    method: Property.StaticDropdown({
      displayName: "Method",
      required: true,
      defaultValue: "add_tag",
      options: {
        options: [
          { label: "Set correspondent", value: "set_correspondent" },
          { label: "Set document type", value: "set_document_type" },
          { label: "Set storage path", value: "set_storage_path" },
          { label: "Add one tag", value: "add_tag" },
          { label: "Remove one tag", value: "remove_tag" },
          { label: "Add and remove tags", value: "modify_tags" },
          { label: "Add and remove custom fields", value: "modify_custom_fields" },
        ],
      },
    }),
    // Per-method inputs, so picking a method presents pickers rather than a
    // raw JSON parameters blob.
    parameters: Property.DynamicProperties({
      auth: paperlessAuth,
      displayName: "Parameters",
      required: true,
      refreshers: ["method"],
      props: async ({ method }): Promise<InputPropertyMap> => {
        switch (String(method) as Method) {
          case "set_correspondent":
            return { correspondent: objectPicker("correspondents") };
          case "set_document_type":
            return { document_type: objectPicker("document_types") };
          case "set_storage_path":
            return { storage_path: objectPicker("storage_paths") };
          case "add_tag":
          case "remove_tag":
            return { tag: objectPicker("tags") };
          case "modify_tags":
            return {
              add_tags: objectMultiPicker("tags", { displayName: "Tags to add" }),
              remove_tags: objectMultiPicker("tags", {
                displayName: "Tags to remove",
              }),
            };
          case "modify_custom_fields":
            return {
              add_custom_fields: Property.Json({
                displayName: "Custom fields to add",
                description:
                  'A map of field id to value ({"3": "ACME"}) or a list of ids to attach empty.',
                required: false,
              }),
              remove_custom_fields: objectMultiPicker("custom_fields", {
                displayName: "Custom fields to remove",
              }),
            };
          default:
            return {};
        }
      },
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    const props = context.propsValue as {
      document_ids?: unknown[];
      method?: Method;
      parameters?: Record<string, unknown>;
    };
    const ids = (props.document_ids ?? [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value));
    if (ids.length === 0) {
      throw new PaperlessApiError("At least one document id is required", {
        category: "validation",
      });
    }
    const method = props.method ?? "add_tag";
    if (!METHODS.includes(method)) {
      throw new PaperlessApiError(`Unsupported bulk edit method "${method}"`, {
        category: "validation",
      });
    }

    const given = props.parameters ?? {};
    const parameters: Record<string, unknown> = {};
    switch (method) {
      case "modify_tags":
        parameters.add_tags = given.add_tags ?? [];
        parameters.remove_tags = given.remove_tags ?? [];
        break;
      case "modify_custom_fields":
        parameters.add_custom_fields = given.add_custom_fields ?? [];
        parameters.remove_custom_fields = given.remove_custom_fields ?? [];
        break;
      default:
        // set_* and add_tag/remove_tag each take exactly one id.
        for (const [key, value] of Object.entries(given)) {
          if (value !== undefined && value !== null) parameters[key] = value;
        }
    }

    const response = await client.request<{ result?: string }>({
      method: "POST",
      path: "documents/bulk_edit/",
      json: { documents: ids, method, parameters },
    });
    return {
      result: response.data?.result ?? "OK",
      documents: ids,
      method,
    };
  },
});
