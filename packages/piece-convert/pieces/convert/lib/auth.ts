import { PieceAuth, Property } from "@powerhousedao/pieces-framework";
import { health, normalizeBaseUrl } from "./client.js";
import { ConvertError } from "./errors.js";

/** The add-on's in-container port; the chart publishes it on this too. */
export const CONVERT_DEFAULT_BASE_URL = "http://localhost:5011";

export function authFromCtx(ctx: { auth?: unknown }): { baseUrl: string } {
  const auth = (ctx.auth ?? {}) as {
    props?: Record<string, unknown>;
    base_url?: unknown;
  };
  // The runtime hands a shaped { type, props }; validate() gets the flat form.
  const props = (auth.props ?? auth) as Record<string, unknown>;
  const raw = typeof props.base_url === "string" ? props.base_url : "";
  return { baseUrl: raw.trim() ? normalizeBaseUrl(raw) : CONVERT_DEFAULT_BASE_URL };
}

export const convertAuth = PieceAuth.CustomAuth({
  displayName: "Document Conversion",
  description:
    "The Document Conversion add-on. Enable it on your environment, then point this at it — the reactor is given its address as CONVERT_SERVICE_URL. The service carries no ingress and takes no credentials: it is reachable only from inside the environment.",
  required: true,
  props: {
    base_url: Property.ShortText({
      displayName: "Service URL",
      required: true,
      defaultValue: CONVERT_DEFAULT_BASE_URL,
      description:
        "Base URL of the conversion service. On a Powerhouse environment with the add-on enabled this is the value of CONVERT_SERVICE_URL, typically http://<release>-docling.<namespace>.svc.cluster.local:5011. A private address also has to be listed in the Workflows add-on's allowed private addresses, or the step cannot reach it.",
    }),
  },
  // The service is unauthenticated by design, so validating the connection is
  // asking whether it is reachable and whether its models are loaded. A
  // service that answers but is not ready is reported as a failure here, with
  // what it is missing, rather than accepted and failing on first use.
  validate: async ({ auth }) => {
    const raw = typeof auth.base_url === "string" ? auth.base_url : "";
    try {
      const report = await health({
        baseUrl: raw.trim() ? raw : CONVERT_DEFAULT_BASE_URL,
      });
      if (!report.ready) {
        return {
          valid: false,
          error: `The service answered but is not ready; missing: ${
            report.missing.join(", ") || "unknown"
          }.`,
        };
      }
      return { valid: true };
    } catch (err) {
      const message =
        err instanceof ConvertError ? err.message : String((err as Error)?.message ?? err);
      return { valid: false, error: message };
    }
  },
});
