// The output schemas are a UI contract, not a validator: nothing at runtime
// checks them, so the only thing standing between a renamed output key and a
// dead expression in the picker is this drift gate. Every action is run for
// real against the mock and its actual output keys are matched against the
// field list that claims to describe them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bulkEditDocuments } from "../src/lib/actions/bulk-edit-documents";
import { customApiCall } from "../src/lib/actions/custom-api-call";
import { findOrCreateObject } from "../src/lib/actions/find-or-create-object";
import { getDocument } from "../src/lib/actions/get-document";
import { getDocumentFile } from "../src/lib/actions/get-document-file";
import { getTask } from "../src/lib/actions/get-task";
import { searchDocuments } from "../src/lib/actions/search-documents";
import { updateDocument } from "../src/lib/actions/update-document";
import { uploadDocument } from "../src/lib/actions/upload-document";
import { documentUpdated, newDocument } from "../src/lib/triggers/document-trigger";
import type { OutputField } from "../src/lib/common/output-schemas";
import type { MockPaperless } from "./mock-paperless";
import { startMockPaperless } from "./mock-paperless";
import { authFor, runAction } from "./helpers";

let mock: MockPaperless;

beforeEach(async () => {
  mock = await startMockPaperless();
});

afterEach(async () => {
  await mock.close();
});

interface Described {
  name: string;
  outputSchema?: { fields: OutputField[] };
}

const described = [
  uploadDocument,
  getDocument,
  getDocumentFile,
  searchDocuments,
  updateDocument,
  bulkEditDocuments,
  findOrCreateObject,
  getTask,
  customApiCall,
  newDocument,
  documentUpdated,
] as unknown as Described[];

// The first segment of each field's path — the top-level output key it
// describes. `fromOutputSchema` falls back to `key` when `value` is absent,
// so this mirrors how the host reads the list.
function describedKeys(fields: OutputField[]): Set<string> {
  return new Set(fields.map((field) => (field.value ?? field.key).split(".")[0]));
}

function fieldsOf(action: Described): OutputField[] {
  const fields = action.outputSchema?.fields;
  if (fields === undefined) throw new Error(`${action.name} has no outputSchema`);
  return fields;
}

describe("output schemas", () => {
  it("every action and trigger declares one", () => {
    for (const action of described) {
      expect(fieldsOf(action).length, action.name).toBeGreaterThan(0);
    }
  });

  it("every field carries a label, and no path is empty", () => {
    const walk = (fields: OutputField[], where: string): void => {
      for (const field of fields) {
        expect(field.key, `${where}: key`).toBeTruthy();
        expect(field.label, `${where}.${field.key}: label`).toBeTruthy();
        expect((field.value ?? field.key).split(".").filter(Boolean).length)
          .toBeGreaterThan(0);
        if (field.children) walk(field.children, `${where}.${field.key}`);
        if (field.listItems) walk(field.listItems, `${where}.${field.key}[]`);
      }
    };
    for (const action of described) walk(fieldsOf(action), action.name);
  });

  // `format` is a display hint in 0.32.0 (email | url | date | datetime |
  // number | boolean | image | html | currency | filesize | duration), not a
  // type discriminator — "object"/"array" there would be silently ignored by
  // the builder, and the host infers both from children/listItems anyway.
  it("uses only display formats, never a type name", () => {
    const allowed = new Set([
      "email",
      "url",
      "date",
      "datetime",
      "number",
      "boolean",
      "image",
      "html",
      "currency",
      "filesize",
      "duration",
    ]);
    const walk = (fields: OutputField[], where: string): void => {
      for (const field of fields) {
        if (field.format !== undefined) {
          expect(allowed, `${where}.${field.key}: ${field.format}`).toContain(
            field.format,
          );
        }
        if (field.children) walk(field.children, `${where}.${field.key}`);
        if (field.listItems) walk(field.listItems, `${where}.${field.key}[]`);
      }
    };
    for (const action of described) walk(fieldsOf(action), action.name);
  });

  // Two actions return the document as their whole output, so their field list
  // is the serializer's — the one shape most likely to drift.
  it("describes every key a document-shaped output actually has", async () => {
    const seeded = mock.seedDocument({ content: "ocr text" });
    const output = (await runAction(getDocument, {
      auth: authFor(mock),
      props: { id: seeded.id, include_content: true },
    })) as Record<string, unknown>;

    const keys = describedKeys(fieldsOf(described[1]));
    for (const key of Object.keys(output)) {
      expect(keys, `get_document output key ${key}`).toContain(key);
    }
    // And the reverse: a field describing a key the server never sends is just
    // as misleading in the picker.
    expect(keys).toContain("content");
    expect(keys).toContain("archived_file_name");
    expect(keys).not.toContain("has_archive_version");
  });

  it("describes every key the wrapping actions return", async () => {
    const document = mock.seedDocument();
    const cases: [Described, unknown][] = [
      [
        described[3],
        await runAction(searchDocuments, {
          auth: authFor(mock),
          props: { mode: "title", term: "Document" },
        }),
      ],
      [
        described[5],
        await runAction(bulkEditDocuments, {
          auth: authFor(mock),
          props: {
            document_ids: [document.id],
            method: "add_tag",
            parameters: { tag: mock.seedObject("tags", { name: "x" }).id },
          },
        }),
      ],
      [
        described[6],
        await runAction(findOrCreateObject, {
          auth: authFor(mock),
          props: { object_type: "tags", name: "Fresh Tag" },
        }),
      ],
      [
        described[8],
        await runAction(customApiCall, {
          auth: authFor(mock),
          props: { method: "GET", path: "documents/" },
        }),
      ],
    ];

    for (const [action, output] of cases) {
      const keys = describedKeys(fieldsOf(action));
      for (const key of Object.keys(output as Record<string, unknown>)) {
        expect(keys, `${action.name} output key ${key}`).toContain(key);
      }
    }
  });

  it("describes the task shape a get_task returns", async () => {
    const task = mock.seedTask({ status: "success" });
    const output = (await runAction(getTask, {
      auth: authFor(mock),
      props: { task_id: task.task_id },
    })) as Record<string, unknown>;

    const keys = describedKeys(fieldsOf(described[7]));
    for (const key of Object.keys(output)) {
      expect(keys, `get_task output key ${key}`).toContain(key);
    }
  });

  it("describes the document keys a trigger emits, plus its own two", () => {
    const keys = describedKeys(fieldsOf(described[9]));
    expect(keys).toContain("event");
    expect(keys).toContain("_dedupe_key");
    expect(keys).toContain("id");
    expect(keys).toContain("modified");
    // Both triggers share the list, so a drift in one cannot pass in the other.
    expect(describedKeys(fieldsOf(described[10]))).toEqual(keys);
  });

  it("describes upload's own keys and the nested document", async () => {
    const keys = describedKeys(fieldsOf(described[0]));
    for (const key of ["task_id", "status", "document_id", "adopted", "timed_out", "document"]) {
      expect(keys, `upload_document ${key}`).toContain(key);
    }
    // The nested document is spelled with a dotted path, which is what makes
    // the picker offer document.title rather than an opaque object.
    const nested = fieldsOf(described[0]).filter((field) =>
      (field.value ?? field.key).startsWith("document."),
    );
    expect(nested.length).toBeGreaterThan(10);
  });
});
