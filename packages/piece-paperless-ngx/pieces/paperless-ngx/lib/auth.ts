import { PieceAuth, Property } from "@powerhousedao/pieces-framework";
import { clientFor } from "./common/context";
import { PaperlessApiError } from "./common/errors";

const AUTH_DESCRIPTION = `Connect to a self-hosted paperless-ngx archive.

Mint a token in the paperless web UI under **My Profile -> API Token**, or with
\`POST /api/token/\`. paperless-ngx 2.18 or newer is required (the piece needs
API version 9 or 10).`;

export const paperlessAuth = PieceAuth.CustomAuth({
  displayName: "paperless-ngx",
  description: AUTH_DESCRIPTION,
  required: true,
  props: {
    base_url: Property.ShortText({
      displayName: "Base URL",
      required: true,
      description:
        "e.g. https://paperless.example.com — no trailing slash, no /api suffix",
    }),
    token: PieceAuth.SecretText({
      displayName: "API Token",
      required: true,
      description: "paperless web UI -> My Profile -> API Token",
    }),
  },
  // Both hooks are handed the flat property value, not the { type, props }
  // envelope an action's ctx.auth carries.
  validate: async ({ auth }) => {
    try {
      await clientFor(auth).uiSettings();
      return { valid: true as const };
    } catch (error) {
      return { valid: false as const, error: describeAuthFailure(error) };
    }
  },
  // Runs once validate passes; labels the connection with user, host and versions.
  getConnectionIdentifier: async ({ auth }) => {
    const client = clientFor(auth);
    const settings = await client.uiSettings();
    const version = await client.apiVersion();
    const host = new URL(client.credentials.baseUrl).host;
    return `${settings.username}@${host} (v${settings.serverVersion ?? "?"}, API ${version})`;
  },
});

function describeAuthFailure(error: unknown): string {
  if (error instanceof PaperlessApiError) {
    switch (error.category) {
      case "credential":
        return "The API token was rejected — mint a new one under My Profile.";
      case "not_found":
        return "That URL answered, but not with a paperless-ngx API — check the base URL.";
      case "api_version":
        return error.message;
      case "network":
      case "timeout":
        return `paperless-ngx is unreachable: ${error.message}`;
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
