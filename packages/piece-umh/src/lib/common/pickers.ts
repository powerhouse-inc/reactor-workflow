import { Property } from "@activepieces/pieces-framework";
import { umhAuth } from "../auth";
import { clientFor } from "./context";
import { UmhApiError } from "./errors";

// The floor's ids are `automotive-welding-1` and `FRAME-WELD-A` — readable, but
// nobody remembers which ones this deployment actually has, and a typo produces
// an order nothing builds. Every line and part reference is a live dropdown.
//
// A resolver must never throw: the editor renders a disabled dropdown carrying
// the reason instead, which is the difference between "the floor is down" and
// "this field is broken".
interface Options {
  disabled: boolean;
  placeholder?: string;
  options: { label: string; value: string }[];
}

function failed(error: unknown): Options {
  const message =
    error instanceof UmhApiError || error instanceof Error
      ? error.message
      : String(error);
  return { disabled: true, placeholder: message, options: [] };
}

const NOT_CONNECTED: Options = {
  disabled: true,
  placeholder: "Connect a UMH factory floor first",
  options: [],
};

// Generic over `required` so a required dropdown types its value as `string`
// rather than `string | undefined` in the action that reads it.
export function lineProp<R extends boolean>(description: string, required: R) {
  return Property.Dropdown<string, R, typeof umhAuth>({
    auth: umhAuth,
    displayName: "Line",
    description,
    required,
    refreshers: ["auth"],
    options: async ({ auth }): Promise<Options> => {
      if (!auth) return NOT_CONNECTED;
      try {
        const lines = await clientFor(auth).listLines();
        return {
          disabled: false,
          options: lines.map((line) => ({
            // The template is what the operator recognises; the instance is
            // what an order is dispatched to, so both belong on the label.
            label: line.template_name
              ? `${line.instance_id} (${line.template_name})`
              : line.instance_id,
            value: line.instance_id,
          })),
        };
      } catch (error) {
        return failed(error);
      }
    },
  });
}

// The parts a given line can build. Depends on the line, because the floor's
// recipes are per line template: offering every part on every line is how an
// order gets created that the line cannot run.
export function partProp<R extends boolean>(description: string, required: R) {
  return Property.Dropdown<string, R, typeof umhAuth>({
    auth: umhAuth,
    displayName: "Part",
    description,
    required,
    refreshers: ["auth", "line_instance_id"],
    options: async ({ auth, line_instance_id }): Promise<Options> => {
      if (!auth) return NOT_CONNECTED;
      if (typeof line_instance_id !== "string" || line_instance_id === "") {
        return { disabled: true, placeholder: "Pick a line first", options: [] };
      }
      try {
        const lines = await clientFor(auth).listLines();
        const line = lines.find(
          (entry) => entry.instance_id === line_instance_id,
        );
        if (!line) {
          return {
            disabled: true,
            placeholder: `The floor has no line "${line_instance_id}"`,
            options: [],
          };
        }
        return {
          disabled: false,
          options: (line.recipes ?? []).map((recipe) => ({
            label: recipe.description
              ? `${recipe.product_id} — ${recipe.description}`
              : recipe.product_id,
            value: recipe.product_id,
          })),
        };
      } catch (error) {
        return failed(error);
      }
    },
  });
}

// CREATED | RELEASED | IN_PROGRESS | CLOSED | CANCELLED, as observed on
// machine-simulator-2 v1.1.0. Static rather than discovered: the floor exposes
// no status vocabulary endpoint.
export const ORDER_STATUSES = [
  "CREATED",
  "RELEASED",
  "IN_PROGRESS",
  "CLOSED",
  "CANCELLED",
] as const;

export function statusProp<R extends boolean>(
  displayName: string,
  required: R,
) {
  return Property.StaticDropdown<string, R>({
    displayName,
    required,
    options: {
      options: ORDER_STATUSES.map((status) => ({
        label: status,
        value: status,
      })),
    },
  });
}
