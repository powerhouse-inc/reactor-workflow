import { createAction, Property } from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import type { QueryValue } from "../common/client";
import { clientForContext } from "../common/context";
import { trimContentAll } from "../common/documents";
import { PaperlessApiError } from "../common/errors";
import { objectMultiPicker, objectPicker } from "../common/pickers";
import { searchOutputFields } from "../common/output-schemas";

// The four search shapes paperless exposes on /api/documents/, each a
// different query parameter rather than a mode flag.
const MODE_PARAM: Record<string, string> = {
  full_text: "query",
  substring: "text",
  title_only: "title_search",
  more_like: "more_like_id",
};

export const searchDocuments = createAction({
  auth: paperlessAuth,
  name: "search_documents",
  displayName: "Search documents",
  description:
    "Searches the archive by full text, substring, title or similarity, with the usual metadata filters.",
  audience: "both",
  aiMetadata: { idempotent: true },
  outputSchema: { fields: searchOutputFields },
  props: {
    mode: Property.StaticDropdown({
      displayName: "Mode",
      required: true,
      defaultValue: "full_text",
      options: {
        options: [
          { label: "Full text (query syntax)", value: "full_text" },
          { label: "Substring in title and content", value: "substring" },
          { label: "Title only", value: "title_only" },
          { label: "More like this document", value: "more_like" },
        ],
      },
    }),
    term: Property.ShortText({
      displayName: "Search term",
      description: "Required for every mode except “More like this”.",
      required: false,
    }),
    document_id: Property.Number({
      displayName: "Similar to document ID",
      description: "Required for “More like this”.",
      required: false,
    }),
    tags: objectMultiPicker("tags", {
      description: "Documents carrying all of these tags.",
    }),
    correspondent: objectPicker("correspondents"),
    document_type: objectPicker("document_types"),
    storage_path: objectPicker("storage_paths"),
    created_after: Property.ShortText({
      displayName: "Created after",
      description: "ISO date, e.g. 2026-01-31.",
      required: false,
    }),
    created_before: Property.ShortText({
      displayName: "Created before",
      required: false,
    }),
    added_after: Property.ShortText({
      displayName: "Added after",
      required: false,
    }),
    ordering: Property.ShortText({
      displayName: "Ordering",
      description: 'A field name, "-" prefixed to reverse it, e.g. -created.',
      required: false,
    }),
    page: Property.Number({ displayName: "Page", required: false }),
    page_size: Property.Number({
      displayName: "Page size",
      required: false,
      defaultValue: 25,
    }),
    include_content: Property.Checkbox({
      displayName: "Include OCR text",
      required: false,
      defaultValue: false,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    // Unvalidated JSON in the reactor path: default here, not in the schema.
    const props = context.propsValue as {
      mode?: string;
      term?: string;
      document_id?: number;
      tags?: number[];
      correspondent?: number;
      document_type?: number;
      storage_path?: number;
      created_after?: string;
      created_before?: string;
      added_after?: string;
      ordering?: string;
      page?: number;
      page_size?: number;
      include_content?: boolean;
    };
    const mode = props.mode ?? "full_text";
    // propsValue is unvalidated: an unknown mode would index MODE_PARAM to
    // undefined, write the literal key "undefined", and paperless — ignoring
    // the unknown param — would answer with the unfiltered archive.
    if (!(mode in MODE_PARAM)) {
      throw new PaperlessApiError(
        `Unknown search mode "${mode}"; expected one of ${Object.keys(MODE_PARAM).join(", ")}`,
        { category: "validation" },
      );
    }
    const query: Record<string, QueryValue> = {};

    if (mode === "more_like") {
      if (!props.document_id) {
        throw new PaperlessApiError(
          "“More like this” needs a document id to compare against",
          { category: "validation" },
        );
      }
      query[MODE_PARAM[mode]] = props.document_id;
    } else {
      if (!props.term) {
        throw new PaperlessApiError("A search term is required", {
          category: "validation",
        });
      }
      query[MODE_PARAM[mode]] = props.term;
    }

    if (props.tags && props.tags.length > 0) {
      // `tags__id__all` is the conjunctive filter; `__in` would be disjunctive.
      query.tags__id__all = props.tags.join(",");
    }
    if (props.correspondent) query.correspondent__id = props.correspondent;
    if (props.document_type) query.document_type__id = props.document_type;
    if (props.storage_path) query.storage_path__id = props.storage_path;
    if (props.created_after) query.created__date__gt = props.created_after;
    if (props.created_before) query.created__date__lt = props.created_before;
    if (props.added_after) query.added__gt = props.added_after;
    if (props.ordering) query.ordering = props.ordering;
    if (props.page) query.page = props.page;
    if (props.page_size) query.page_size = props.page_size;

    const response = await client.request<Record<string, unknown> | undefined>({
      path: "documents/",
      query,
    });
    const body = response.data ?? {};
    const results = Array.isArray(body.results) ? body.results : [];
    return {
      count: typeof body.count === "number" ? body.count : results.length,
      next: body.next ?? null,
      previous: body.previous ?? null,
      results: trimContentAll(results, props.include_content === true),
    };
  },
});
