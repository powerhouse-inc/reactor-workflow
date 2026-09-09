import { Property } from "@activepieces/pieces-framework";
import { paperlessAuth } from "../auth";
import { clientFor } from "./context";
import { PaperlessApiError } from "./errors";

export type ObjectKind =
  | "tags"
  | "correspondents"
  | "document_types"
  | "storage_paths"
  | "custom_fields";

export const OBJECT_LABELS: Record<ObjectKind, string> = {
  tags: "Tag",
  correspondents: "Correspondent",
  document_types: "Document type",
  storage_paths: "Storage path",
  custom_fields: "Custom field",
};

interface NamedRow {
  id: number;
  name: string;
}

// Raw numeric ids would make every write action unusable by hand, so each
// object reference is a live dropdown. A resolver must never throw: the editor
// renders a disabled state with the reason instead.
async function loadOptions(
  kind: ObjectKind,
  auth: unknown,
): Promise<{ disabled: boolean; placeholder?: string; options: { label: string; value: number }[] }> {
  if (!auth) {
    return {
      disabled: true,
      placeholder: "Connect a paperless-ngx account first",
      options: [],
    };
  }
  try {
    const rows = await clientFor(auth).listAll<NamedRow>(
      `${kind}/`,
      { ordering: "name" },
      500,
    );
    return {
      disabled: false,
      options: rows.map((row) => ({
        label: row.name,
        value: row.id,
      })),
    };
  } catch (error) {
    return {
      disabled: true,
      placeholder:
        error instanceof PaperlessApiError
          ? error.message
          : `Could not load ${kind}`,
      options: [],
    };
  }
}

export function objectPicker(
  kind: ObjectKind,
  options: { displayName?: string; description?: string; required?: boolean } = {},
) {
  return Property.Dropdown({
    auth: paperlessAuth,
    displayName: options.displayName ?? OBJECT_LABELS[kind],
    description: options.description,
    required: options.required ?? false,
    refreshers: ["auth"],
    options: ({ auth }) => loadOptions(kind, auth),
  });
}

export function objectMultiPicker(
  kind: ObjectKind,
  options: { displayName?: string; description?: string } = {},
) {
  return Property.MultiSelectDropdown({
    auth: paperlessAuth,
    displayName: options.displayName ?? `${OBJECT_LABELS[kind]}s`,
    description: options.description,
    required: false,
    refreshers: ["auth"],
    options: ({ auth }) => loadOptions(kind, auth),
  });
}
