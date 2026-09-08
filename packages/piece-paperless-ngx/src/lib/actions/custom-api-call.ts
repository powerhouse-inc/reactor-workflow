import { createAction, Property } from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import type { HttpVerb, QueryValue } from "../common/client";
import { clientForContext } from "../common/context";

// The convention escape hatch: paperless exposes 18 resource endpoints, and a
// 1:1 action mapping would be 40+ near-duplicates. This covers the tail —
// saved views, mail rules, users, config, trash — at a fraction of the
// review cost, and keeps the negotiated API version and auth handling.
export const customApiCall = createAction({
  auth: paperlessAuth,
  name: "custom_api_call",
  displayName: "Custom API call",
  description:
    "Calls any paperless-ngx API endpoint with the connection's credentials and negotiated API version.",
  audience: "both",
  aiMetadata: { idempotent: false },
  props: {
    method: Property.StaticDropdown({
      displayName: "Method",
      required: true,
      defaultValue: "GET",
      options: {
        options: [
          { label: "GET", value: "GET" },
          { label: "POST", value: "POST" },
          { label: "PUT", value: "PUT" },
          { label: "PATCH", value: "PATCH" },
          { label: "DELETE", value: "DELETE" },
        ],
      },
    }),
    path: Property.ShortText({
      displayName: "Path",
      required: true,
      description:
        'Relative to /api/, with the trailing slash paperless expects — e.g. "saved_views/" or "documents/12/notes/".',
    }),
    query: Property.Object({
      displayName: "Query parameters",
      required: false,
    }),
    body: Property.Json({
      displayName: "JSON body",
      required: false,
    }),
    headers: Property.Object({
      displayName: "Extra headers",
      required: false,
    }),
  },
  async run(context) {
    const client = clientForContext(context);
    // In the reactor, propsValue is unvalidated JSON from the step config, so
    // defaults are applied here rather than trusted from the prop schema.
    const { method, path, query, body, headers } = context.propsValue as {
      method?: string;
      path: string;
      query?: Record<string, QueryValue>;
      body?: unknown;
      headers?: Record<string, string>;
    };

    const response = await client.request<unknown>({
      method: (method ?? "GET") as HttpVerb,
      path,
      query,
      json: body ?? undefined,
      headers,
    });

    return {
      status: response.status,
      body: response.data ?? null,
    };
  },
});
