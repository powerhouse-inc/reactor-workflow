import { UmhApiError } from "./errors";

export interface UmhCredentials {
  baseUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Strips a trailing slash and refuses a base URL that already points at the
// API. `http://localhost:8081/api` is the single most likely thing a user
// pastes, and every request built on it would 404 with no hint why.
export function normalizeBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new UmhApiError("Base URL is required", { category: "config" });
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new UmhApiError(
      `"${trimmed}" is not a valid URL — expected something like http://localhost:8081`,
      { category: "config" },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // `localhost:8081` parses, with "localhost:" as its protocol — the most
    // common paste there is, and reporting it as an odd protocol would send
    // someone looking for the wrong problem.
    throw new UmhApiError(
      trimmed.includes("//")
        ? `Base URL must be http or https, got "${parsed.protocol}"`
        : `Base URL is missing its scheme — use http://${trimmed}`,
      { category: "config" },
    );
  }
  if (/\/api(\/v\d+)?$/i.test(parsed.pathname)) {
    throw new UmhApiError(
      "Base URL must not include the /api suffix — use http://localhost:8081",
      { category: "config" },
    );
  }
  return trimmed;
}

// `ctx.auth` arrives shaped as { type: "CUSTOM_AUTH", props } from the reactor
// (engine/connections.ts `shapeAuthValue`) and flat from Activepieces 0.32.0,
// which hands `validate` the raw property value. Accept both.
export function readAuth(auth: unknown): UmhCredentials {
  const source = isRecord(auth) && isRecord(auth.props) ? auth.props : auth;
  if (!isRecord(source)) {
    throw new UmhApiError("No UMH floor connection was provided", {
      category: "credential",
    });
  }
  return { baseUrl: normalizeBaseUrl(source.base_url) };
}
