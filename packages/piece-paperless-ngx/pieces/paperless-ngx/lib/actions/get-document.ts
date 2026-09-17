import { createAction, Property } from "@powerhousedao/pieces-framework";
import { paperlessAuth } from "../auth";
import { clientForContext } from "../common/context";
import { trimContent } from "../common/documents";
import { getDocumentOutputFields } from "../common/output-schemas";

export const getDocument = createAction({
  auth: paperlessAuth,
  name: "get_document",
  displayName: "Get document",
  description: "Fetches one document's metadata by id.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: { fields: getDocumentOutputFields },
  props: {
    id: Property.Number({
      displayName: "Document ID",
      required: true,
    }),
    include_content: Property.Checkbox({
      displayName: "Include OCR text",
      description:
        "The full extracted text, often megabytes. Left off, the field is omitted from the output.",
      required: false,
      defaultValue: false,
    }),
    version: Property.Number({
      displayName: "Version ID",
      description: "Reads a specific stored version instead of the current one.",
      required: false,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    const { id, include_content, version } = context.propsValue;
    const response = await client.request<Record<string, unknown>>({
      path: `documents/${id}/`,
      query: version ? { version } : undefined,
    });
    return trimContent(response.data, include_content === true);
  },
});
