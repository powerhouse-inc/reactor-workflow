import { createAction, Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientForContext } from "../common/context";
import type { HttpVerb } from "../common/client";

// The floor API is larger than the actions above: buffers, recipes, per-machine
// tags, simulation controls. Rather than wrap endpoints nobody has asked for,
// this hands the rest of the API over with the connection's base URL and the
// piece's error mapping already applied.
export const customApiCall = createAction({
  auth: umhAuth,
  name: "custom_api_call",
  displayName: "Custom API call",
  description:
    "Calls any UMH floor API endpoint with this connection, for the parts the other actions do not cover.",
  audience: "both",
  props: {
    path: Property.ShortText({
      displayName: "Path",
      description:
        'Relative to /api/, e.g. "lines/automotive-welding-1/buffers" or "machines/robot-welder-1/tags"',
      required: true,
    }),
    method: Property.StaticDropdown({
      displayName: "Method",
      required: false,
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
    body: Property.Json({
      displayName: "Body",
      description: "JSON request body, for the verbs that take one",
      required: false,
    }),
  },
  async run(context) {
    const { path, method, body } = context.propsValue;
    const response = await clientForContext(context).request<unknown>({
      // Fallback first, then the cast: casting first would strip the
      // undefined the fallback exists for.
      method: (method ?? "GET") as HttpVerb,
      path,
      ...(body === undefined ? {} : { json: body }),
    });
    return { status: response.status, body: response.data };
  },
});
