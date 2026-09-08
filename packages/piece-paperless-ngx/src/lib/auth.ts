import { PieceAuth, Property } from "@activepieces/pieces-framework";
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
  // Activepieces 0.32.0 hands `validate` the flat property value; the reactor
  // never calls it (it uses the piece's checkConnection instead), so this is
  // pure AP semantics.
  validate: async ({ auth }) => {
    try {
      const settings = await clientFor(auth).uiSettings();
      return {
        valid: true as const,
        // Not shown by every AP build, but harmless where it is ignored.
        message: `Connected as ${settings.username}`,
      };
    } catch (error) {
      return { valid: false as const, error: describeAuthFailure(error) };
    }
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

export interface ConnectionIdentity {
  name: string;
  username: string;
  serverVersion?: string;
  apiVersion?: number;
  permissions: string[];
}

// The reactor's `checkConnection` mutation calls this and takes the label from
// the first string-valued `name`/`username`/`email`/`sub` field. Declaring it
// is what populates the connection document's status and accountLabel; the
// host tolerates its absence (CheckConnectionOutcome.declared), and real
// Activepieces never calls it.
export async function checkPaperlessConnection(context: {
  auth?: unknown;
}): Promise<ConnectionIdentity> {
  const client = clientFor(context.auth);
  const settings = await client.uiSettings();
  const version = await client.apiVersion();
  const host = new URL(client.credentials.baseUrl).host;
  return {
    name: `${settings.username}@${host} (v${settings.serverVersion ?? "?"}, API ${version})`,
    username: settings.username,
    serverVersion: settings.serverVersion,
    apiVersion: version,
    permissions: settings.permissions,
  };
}
