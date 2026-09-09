import { normalizeFile } from "../src/lib/files.js";
import { DoclingError } from "../src/lib/errors.js";

describe("normalizeFile", () => {
  it("handles a real ApFile (Buffer data)", () => {
    const out = normalizeFile({ filename: "a.pdf", data: Buffer.from("hello"), extension: "pdf" });
    expect(out).toEqual({ filename: "a.pdf", extension: "pdf", base64: Buffer.from("hello").toString("base64") });
  });

  it("handles a JSON-IPC plain object with a Buffer-shaped data field", () => {
    const out = normalizeFile({ filename: "a.pdf", data: { type: "Buffer", data: [104, 105] } });
    expect(out.filename).toBe("a.pdf");
    expect(out.base64).toBe(Buffer.from([104, 105]).toString("base64"));
    expect(out.extension).toBe("pdf");
  });

  it("handles a host-hydrated object with a base64 string", () => {
    const out = normalizeFile({ filename: "a.pdf", data: "aGk=", extension: "pdf" });
    expect(out.base64).toBe("aGk=");
  });

  it("parses a data URI string, deriving name from the mime", () => {
    const out = normalizeFile("data:application/pdf;base64,aGk=");
    expect(out).toEqual({ filename: "document.pdf", extension: "pdf", base64: "aGk=" });
  });

  it("rejects non-file values", () => {
    expect(() => normalizeFile(42)).toThrow(DoclingError);
    expect(() => normalizeFile("not a data uri")).toThrow(/data URI/i);
    expect(() => normalizeFile({ filename: "a.pdf", data: { type: "weird" } })).toThrow(DoclingError);
  });
});
