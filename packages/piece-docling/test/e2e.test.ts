// Live end-to-end suite against a real docling-serve v1.32.0. Skipped unless
// DOCLING_E2E_URL is set, because it needs a server and each conversion runs
// the layout model:
//
//   docker compose -f test/e2e-compose.yml up -d
//   DOCLING_E2E_URL=http://localhost:5001 \
//   DOCLING_E2E_API_KEY=docling-e2e-key \
//   pnpm vitest run test/e2e.test.ts
//
// It covers what a mock cannot settle: what the stock CPU image actually
// converts (its bundled model set), the real /v1 response shapes, whether
// the async submit -> long-poll -> result dance completes against the local
// task) map onto the piece's typed errors, and two documented behaviors:
// /health and /version are NOT key-gated on v1 (only /v1/* is), and
// URL sources accept only globally routable hosts (the SSRF gate).
import { deflateSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { chunkAction } from "../pieces/docling/lib/actions/chunk.js";
import { convertFileAction } from "../pieces/docling/lib/actions/convert-file.js";
import { convertUrlAction } from "../pieces/docling/lib/actions/convert-url.js";
import { getResultAction } from "../pieces/docling/lib/actions/get-result.js";
import { healthAction } from "../pieces/docling/lib/actions/health.js";
import { submitJobAction } from "../pieces/docling/lib/actions/submit-job.js";
import { doclingAuth } from "../pieces/docling/lib/auth.js";
import { makeActionContext } from "./mock-context.js";

const baseUrl = process.env.DOCLING_E2E_URL;
const apiKey = process.env.DOCLING_E2E_API_KEY ?? "docling-e2e-key";

const auth = {
  type: "CUSTOM_AUTH",
  props: { base_url: baseUrl, api_key: apiKey },
};

// Unique per run so a re-run against the same server cannot confuse jobs.
const stamp = Date.now();

// A real PDF with N pages and one text line per page, assembled with
// valid xref offsets. The layout model is shipped in the stock image; the
// text layer is read without OCR. (A single line on a small page is
// classified as a heading — the markdown keeps the text verbatim behind a
// `##`, which the assertions account for.)
function minimalPdf(pages: string[]): Buffer {
  const n = pages.length;
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pages
      .map((_, i) => `${3 + i * 2} 0 R`)
      .join(" ")}] /Count ${n} >>`,
  ];
  pages.forEach((text) => {
    const stream = `BT /F1 14 Tf 20 150 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] ` +
        `/Resources << /Font << /F1 4 0 R >> >> /Contents ${4 + (objects.length - 2)} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// Multi-line body text on one page (11 pt, leading 16): the layout model
// classifies this as a paragraph, not a heading, and the hierarchical
// chunker has real structure to chunk.
function bodyPdf(lines: string[]): Buffer {
  const stream = lines
    .map(
      (line, i) =>
        `BT /F1 11 Tf 20 ${170 - i * 16} Td (${line.replace(/[()\\]/g, "")}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

// 5x7 bitmap font — renders text into a raster PNG (no text layer), which
// is the only input that actually runs the OCR engine.
const FONT: Record<string, string[]> = {
  H: ["10001", "00100", "00100", "11111", "00100", "00100", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

function textPng(word: string): Buffer {
  const scale = 4;
  const charW = 6 * scale;
  const pad = 40;
  const W = word.length * charW + pad * 2;
  const H = 7 * scale + pad * 2;
  const px = Buffer.alloc(H * W, 255); // white background, black text
  for (let i = 0; i < word.length; i++) {
    const glyph = FONT[word[i]];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (glyph[r][c] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            px[(pad + r * scale + dy) * W + pad + i * charW + c * scale + dx] = 0;
          }
        }
      }
    }
  }
  const raw = Buffer.alloc(H * (1 + W));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W)] = 0; // filter: none
    px.copy(raw, y * (1 + W) + 1, y * W, (y + 1) * W);
  }
  const idat = deflateSync(raw);
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const pageOne = `Docling E2E Page One ${stamp}`;
const pageTwo = `Docling E2E Page Two ${stamp}`;

const fileProp = (name: string, data: Buffer) => ({ filename: name, data });

async function run(
  action: { run: (ctx: never) => Promise<unknown> },
  propsValue: Record<string, unknown>,
  authOverride?: unknown,
): Promise<unknown> {
  return action.run(makeActionContext(propsValue, authOverride ?? auth) as never);
}

// The convert actions return the server's ConvertDocumentResponse verbatim
// (document + status + errors + timing).
interface ConvertOutput {
  document: {
    md_content?: string | null;
    json_content?: unknown;
    html_content?: string | null;
    text_content?: string | null;
    doctags_content?: string | null;
  } | null;
  status: "success" | "partial_success" | "skipped" | "failure";
  errors?: Array<Record<string, unknown>>;
  processing_time?: number;
}

function expectMd(out: unknown, needle: string): void {
  const conv = out as ConvertOutput;
  expect(conv.status).toBe("success");
  const md = conv.document?.md_content ?? "";
  expect(md).toContain(needle);
}

async function waitFor(
  probe: () => Promise<unknown>,
  label: string,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

describe.skipIf(!baseUrl)("live docling-serve v1", () => {

  beforeAll(async () => {
    // The stock image loads the layout model lazily; warm it up here so no
    // test pays the cold start.
    await waitFor(
      async () => {
        const res = await fetch(`${baseUrl}/health`, {
          headers: { "x-api-key": apiKey },
        });
        if (res.status !== 200) return undefined;
        const body = (await res.json().catch(() => ({}))) as { status?: string };
        return body.status === "ok" ? true : undefined;
      },
      "docling-serve /health",
      600_000,
    );
    const warm = (await run(convertFileAction, {
      file: fileProp(`warmup-${stamp}.pdf`, minimalPdf([`warmup ${stamp}`])),
      ocr: false,
      execution: "async",
      timeout_seconds: 600,
    })) as ConvertOutput;
    expect(warm.status).toBe("success");
  }, 600_000);

  it("health reports status and component versions", async () => {
    const out = (await run(healthAction, {})) as {
      status: string;
      versions: Record<string, unknown>;
    };
    expect(out.status).toBe("ok");
    const keys = Object.keys(out.versions);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => /docling/i.test(k))).toBe(true);
  }, 30_000);

  it("convert_file returns the markdown for a real PDF (default md-only)", async () => {
    const out = (await run(convertFileAction, {
      file: fileProp(`one-${stamp}.pdf`, minimalPdf([pageOne])),
      ocr: false,
    })) as ConvertOutput;
    expectMd(out, pageOne);
    // The markdown-only default: the other content fields stay null.
    expect(out.document?.json_content ?? null).toBeNull();
    expect(out.processing_time ?? 0).toBeGreaterThan(0);
  }, 300_000);

  it("convert_file with the all-format preset fills every content field", async () => {
    const out = (await run(convertFileAction, {
      file: fileProp(`all-${stamp}.pdf`, minimalPdf([pageOne])),
      format: "all",
      ocr: false,
    })) as ConvertOutput;
    expectMd(out, pageOne);
    const doc = out.document!;
    expect(doc.text_content ?? "").toContain(pageOne);
    expect(doc.html_content ?? "").toContain(pageOne);
    expect(doc.doctags_content ?? "").toContain("<doctag>");
    const json = doc.json_content as { version?: string } | null;
    expect(json).toBeTruthy();
    expect(String(json?.version ?? "")).toMatch(/^\d/);
  }, 300_000);

  it("convert_file accepts a data-URI string file (the reactor config shape)", async () => {
    const uri =
      "data:application/pdf;base64," + minimalPdf([pageOne]).toString("base64");
    const out = (await run(convertFileAction, {
      file: uri,
      ocr: false,
    })) as ConvertOutput;
    expectMd(out, pageOne);
  }, 300_000);

  it("convert_file in sync mode converts within the server's sync window", async () => {
    const out = (await run(convertFileAction, {
      file: fileProp(`sync-${stamp}.pdf`, minimalPdf([pageOne])),
      ocr: false,
      execution: "sync",
    })) as ConvertOutput;
    expectMd(out, pageOne);
  }, 300_000);

  it("convert_file honors page_range against a multi-page PDF", async () => {
    const two = minimalPdf([pageOne, pageTwo]);
    const firstOnly = (await run(convertFileAction, {
      file: fileProp(`range1-${stamp}.pdf`, two),
      page_range: "1",
      ocr: false,
    })) as ConvertOutput;
    expect(firstOnly.document?.md_content ?? "").toContain("Page One");
    expect(firstOnly.document?.md_content ?? "").not.toContain("Page Two");

    const lastOnly = (await run(convertFileAction, {
      file: fileProp(`range2-${stamp}.pdf`, two),
      page_range: "2-",
      ocr: false,
    })) as ConvertOutput;
    expect(lastOnly.document?.md_content ?? "").toContain("Page Two");
    expect(lastOnly.document?.md_content ?? "").not.toContain("Page One");
  }, 300_000);

  // v1's URL sources pass an SSRF gate: only globally routable hosts are
  // accepted (private, loopback, localhost are rejected — "URL is not
  // allowed"), so this test uses a stable public fixture: the W3C test
  // PDF, one page whose text is "Dummy PDF file".
  it("convert_url fetches and converts a globally routable URL", async () => {
    const out = (await run(convertUrlAction, {
      url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
      ocr: false,
    })) as ConvertOutput;
    expect(out.status).toBe("success");
    expect(out.document?.md_content ?? "").toContain("Dummy PDF file");
  }, 300_000);

  it("submit_job + get_result complete an async job", async () => {
    const submitted = (await run(submitJobAction, {
      file: fileProp(`job-${stamp}.pdf`, minimalPdf([pageOne])),
      ocr: false,
    })) as { task_id: string; task_status: string };
    expect(submitted.task_id).toBeTruthy();
    expect(["pending", "started"]).toContain(submitted.task_status);

    // The first get_result may land before the job finishes; poll until done.
    let out = (await run(getResultAction, {
      task_id: submitted.task_id,
      wait_seconds: 5,
    })) as {
      done: boolean;
      task_id: string;
      document?: { md_content?: string | null };
      task_status?: string;
    };
    const deadline = Date.now() + 300_000;
    while (!out.done) {
      expect(Date.now()).toBeLessThan(deadline);
      expect(out.task_status).toBeDefined();
      out = (await run(getResultAction, {
        task_id: submitted.task_id,
        wait_seconds: 5,
      })) as typeof out;
    }
    expect(out.task_id).toBe(submitted.task_id);
    expect(out.document?.md_content ?? "").toContain(pageOne);
  }, 330_000);

  it("get_result rejects an unknown task id as a validation error", async () => {
    await expect(
      run(getResultAction, { task_id: `no-such-task-${stamp}` }),
    ).rejects.toMatchObject({ kind: "VALIDATION", name: "DoclingError" });
  }, 30_000);

  it("chunk (hierarchical) returns document chunks for body text", async () => {
    const out = (await run(chunkAction, {
      file: fileProp(
        `chunk-${stamp}.pdf`,
        bodyPdf([
          "Docling E2E body text line one with enough words to be a paragraph.",
          "Docling E2E body text line two continues the same paragraph.",
          "Docling E2E body text line three closes out the paragraph.",
        ]),
      ),
      chunker: "hierarchical",
      ocr: false,
    })) as { chunks: Array<{ text?: string | null }> };
    expect(out.chunks.length).toBeGreaterThan(0);
    const texts = out.chunks.map((c) => c.text ?? "");
    expect(texts.join("\n")).toContain("body text");
  }, 300_000);

  // --- the auth-gating finding -------------------------------------------
  // v1.32.0 gates only the /v1/* routes; /health and /version stay open, so
  // a wrong key passes every liveness endpoint. These three tests pin the
  // real behavior: health is open, the connection check (validate) catches
  // the key via a gated probe, and a real request fails with the AUTH kind.

  it("health stays open even with a rejected key (v1 route-level gating)", async () => {
    const out = (await run(healthAction, {}, {
      type: "CUSTOM_AUTH",
      props: { base_url: baseUrl, api_key: `${apiKey}-wrong` },
    })) as { status: string };
    expect(out.status).toBe("ok");
  }, 30_000);

  it("the connection check rejects a wrong key (gated probe)", async () => {
    const res = await doclingAuth.validate!({
      auth: { base_url: baseUrl!, api_key: `${apiKey}-wrong` },
      server: {} as never,
    });
    expect(res).toMatchObject({ valid: false });
    if (!res.valid) expect(res.error).toMatch(/401/);
  }, 30_000);

  it("a rejected key maps to an AUTH error on a real request", async () => {
    await expect(
      run(
        convertFileAction,
        {
          file: fileProp(`auth-${stamp}.pdf`, minimalPdf([pageOne])),
          ocr: false,
        },
        {
          type: "CUSTOM_AUTH",
          props: { base_url: baseUrl, api_key: `${apiKey}-wrong` },
        },
      ),
    ).rejects.toMatchObject({ kind: "AUTH", name: "DoclingError" });
  }, 60_000);

  it("an unparseable file fails the job with a JOB_FAILED error", async () => {
    const garbage = Buffer.from(
      "this is not a pdf, only bytes " + stamp,
      "utf8",
    );
    await expect(
      run(convertFileAction, {
        file: fileProp(`garbage-${stamp}.pdf`, garbage),
        ocr: false,
      }),
    ).rejects.toMatchObject({ kind: "JOB_FAILED", name: "DoclingError" });
  }, 300_000);
});

// The OCR question the mock cannot settle: the stock CPU image's bundled
// model set. Verified on v1.32.0: the image pre-downloads the RapidOCR
// (PP-OCRv6 ONNX) weights into its artifacts path, so do_ocr=true works out
// of the box. Only a raster image (no text layer) actually runs the OCR
// engine; a text-layer PDF bypasses it. The fixture renders bitmap-font
// text into a PNG and asserts the server reads it back.
describe.skipIf(!baseUrl)("live docling-serve: OCR on the stock image", () => {
  it("converts a raster image with the default ocr setting and reads the text back", async () => {
    const png = textPng("HELLO OCR DOCLING");
    const out = (await run(convertFileAction, {
      file: { filename: `ocr-${Date.now()}.png`, data: png },
      // no ocr prop: the piece default (true) is what gets exercised.
    })) as ConvertOutput;
    expect(out.status).toBe("success");
    const md = out.document?.md_content ?? "";
    expect(md).toContain("OCR DOCLING");
  }, 360_000);
});
