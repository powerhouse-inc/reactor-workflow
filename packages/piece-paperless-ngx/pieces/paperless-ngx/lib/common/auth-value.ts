import { PaperlessApiError } from "./errors";

export interface PaperlessCredentials {
  baseUrl: string;
  token: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Strips a trailing slash and refuses a base URL that already points at the
// API. `https://paperless.example.com/api` is the single most likely thing a
// user pastes, and every request built on it would 404 with no hint why.
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new PaperlessApiError("Base URL is required", {
      category: "config",
    });
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PaperlessApiError(
      `"${trimmed}" is not a valid URL — expected something like https://paperless.example.com`,
      { category: "config" },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PaperlessApiError(
      `Base URL must be http or https, got "${parsed.protocol}"`,
      { category: "config" },
    );
  }
  if (/\/api$/i.test(parsed.pathname)) {
    throw new PaperlessApiError(
      "Base URL must not include the /api suffix — use https://paperless.example.com",
      { category: "config" },
    );
  }
  return trimmed;
}

// An action's `ctx.auth` arrives shaped as { type: "CUSTOM_AUTH", props }, while
// `validate` and `getConnectionIdentifier` are handed the flat props. Accept both.
export function readAuth(auth: unknown): PaperlessCredentials {
  const source = isRecord(auth) && isRecord(auth.props) ? auth.props : auth;
  if (!isRecord(source)) {
    throw new PaperlessApiError("No paperless-ngx connection was provided", {
      category: "credential",
    });
  }
  const token = source.token;
  if (typeof token !== "string" || token.trim() === "") {
    throw new PaperlessApiError("The connection is missing its API token", {
      category: "credential",
    });
  }
  return {
    baseUrl: normalizeBaseUrl(source.base_url),
    token: token.trim(),
  };
}
