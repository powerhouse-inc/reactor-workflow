import { createAction, Property } from "@powerhousedao/pieces-framework";
import type { InputPropertyMap } from "@powerhousedao/pieces-framework";
import { paperlessAuth } from "../auth";
import { clientForContext } from "../common/context";
import { PaperlessApiError } from "../common/errors";
import type { ObjectKind } from "../common/pickers";
import { findOrCreateOutputFields } from "../common/output-schemas";

// `name__iexact` is exposed by all five filtersets (CHAR_KWARGS is applied to
// `name` on Correspondent, Tag, DocumentType, StoragePath and CustomField),
// so the lookup is one exact-match request with no paged-scan fallback.
const KINDS: ObjectKind[] = [
  "tags",
  "correspondents",
  "document_types",
  "storage_paths",
  "custom_fields",
];

export const findOrCreateObject = createAction({
  auth: paperlessAuth,
  name: "find_or_create_object",
  displayName: "Find or create object",
  description:
    "Resolves a tag, correspondent, document type, storage path or custom field by name, creating it when it does not exist.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: { fields: findOrCreateOutputFields },
  props: {
    object_type: Property.StaticDropdown({
      displayName: "Object type",
      required: true,
      defaultValue: "tags",
      options: {
        options: [
          { label: "Tag", value: "tags" },
          { label: "Correspondent", value: "correspondents" },
          { label: "Document type", value: "document_types" },
          { label: "Storage path", value: "storage_paths" },
          { label: "Custom field", value: "custom_fields" },
        ],
      },
    }),
    name: Property.ShortText({ displayName: "Name", required: true }),
    extras: Property.DynamicProperties({
      auth: paperlessAuth,
      displayName: "Details",
      required: false,
      refreshers: ["object_type"],
      // DynamicPropsValue requires a Promise return, so this stays
      // async even though the branches are all synchronous.
      // oxlint-disable-next-line require-await
      props: async ({ object_type }): Promise<InputPropertyMap> => {
        switch (String(object_type) as ObjectKind) {
          case "tags":
            return {
              color: Property.ShortText({
                displayName: "Colour",
                description: "Hex, e.g. #a6cee3.",
                required: false,
              }),
              is_inbox_tag: Property.Checkbox({
                displayName: "Inbox tag",
                required: false,
              }),
            };
          case "storage_paths":
            return {
              path: Property.ShortText({
                displayName: "Path template",
                description: "e.g. {{ created_year }}/{{ correspondent }}",
                required: true,
              }),
            };
          case "custom_fields":
            return {
              data_type: Property.StaticDropdown({
                displayName: "Data type",
                required: true,
                defaultValue: "string",
                options: {
                  options: [
                    { label: "Text", value: "string" },
                    { label: "Date", value: "date" },
                    { label: "Boolean", value: "boolean" },
                    { label: "Integer", value: "integer" },
                    { label: "Float", value: "float" },
                    { label: "Monetary", value: "monetary" },
                    { label: "Document link", value: "documentlink" },
                    { label: "Select", value: "select" },
                    { label: "URL", value: "url" },
                  ],
                },
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
      object_type?: ObjectKind;
      name: string;
      extras?: Record<string, unknown>;
    };
    const kind = props.object_type ?? "tags";
    if (!KINDS.includes(kind)) {
      throw new PaperlessApiError(`Unsupported object type "${kind}"`, {
        category: "validation",
      });
    }
    const name = props.name.trim();
    if (name === "") {
      throw new PaperlessApiError("A name is required", {
        category: "validation",
      });
    }

    const existing = await client.list<{ id: number; name: string }>(
      `${kind}/`,
      { name__iexact: name },
    );
    const match = existing.results.find(
      (row) => row.name.toLowerCase() === name.toLowerCase(),
    );
    if (match) {
      return { id: match.id, name: match.name, created: false, object_type: kind };
    }

    const payload: Record<string, unknown> = { name };
    for (const [key, value] of Object.entries(props.extras ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        payload[key] = value;
      }
    }

    const created = await client.request<{ id: number; name: string }>({
      method: "POST",
      path: `${kind}/`,
      json: payload,
    });
    return {
      id: created.data.id,
      name: created.data.name,
      created: true,
      object_type: kind,
    };
  },
});
