import { PieceAuth, Property } from "@activepieces/pieces-framework";
import { clientFor } from "./common/context";
import { UmhApiError } from "./common/errors";

const AUTH_DESCRIPTION = `Connect to a United Manufacturing Hub factory floor API.

This is the order/machine API the UMH factory demo exposes on port 8081 — the
same address the reference integration polls. **It has no authentication**: the
connection is an address, not a credential, so the floor must not be reachable
from anywhere you would not accept unauthenticated writes from.

OEE, machine stop records and cost rates are not on this API; they live in the
historian database. Figures the floor cannot measure are reported as null, never
as zero.`;

export const umhAuth = PieceAuth.CustomAuth({
  displayName: "UMH Factory Floor",
  description: AUTH_DESCRIPTION,
  required: true,
  props: {
    base_url: Property.ShortText({
      displayName: "Base URL",
      required: true,
      description:
        "e.g. http://localhost:8081 — no trailing slash, no /api suffix. Inside a compose network this is the service name, e.g. http://machine-simulator:8081",
    }),
  },
  // Activepieces 0.32.0 hands `validate` the flat property value; the reactor
  // never calls it (it uses the piece's checkConnection instead), so this is
  // pure AP semantics.
  validate: async ({ auth }) => {
    try {
      await clientFor(auth).health();
      return { valid: true as const };
    } catch (error) {
      return { valid: false as const, error: describeAuthFailure(error) };
    }
  },
});

function describeAuthFailure(error: unknown): string {
  if (error instanceof UmhApiError) {
    switch (error.category) {
      case "not_found":
        return "That URL answered, but not with a UMH floor API — check the base URL and port.";
      case "network":
      case "timeout":
        return `The UMH floor is unreachable: ${error.message}`;
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export interface ConnectionIdentity {
  name: string;
  lineCount: number | null;
  machineCount: number | null;
  timeScale: number | null;
}

// The reactor's `checkConnection` mutation calls this and takes the label from
// the first string-valued `name`/`username`/`email`/`sub` field. Declaring it
// is what populates the connection document's status and accountLabel; the host
// tolerates its absence (CheckConnectionOutcome.declared), and real
// Activepieces never calls it.
//
// `/health` alone would prove only that something answers. Reading the
// simulation summary as well puts the size of the floor on the connection, so a
// connection pointed at the wrong stack is visible as soon as it is saved.
export async function checkUmhConnection(context: {
  auth?: unknown;
}): Promise<ConnectionIdentity> {
  const client = clientFor(context.auth);
  const health = await client.health();
  if (health.status !== undefined && health.status !== "ok") {
    throw new UmhApiError(
      `The UMH floor reports status "${String(health.status)}"`,
      { category: "server", retryable: true },
    );
  }
  const simulation = await client.simulation();
  const host = new URL(client.credentials.baseUrl).host;
  const lines = simulation.line_count ?? null;
  const machines = simulation.machine_count ?? null;
  return {
    name:
      lines === null && machines === null
        ? host
        : `${lines ?? "?"} lines, ${machines ?? "?"} machines @ ${host}`,
    lineCount: lines,
    machineCount: machines,
    timeScale: simulation.time_scale ?? null,
  };
}
