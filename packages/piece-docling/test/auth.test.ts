import { doclingAuth, authFromCtx } from "../src/lib/auth.js";
import { startMockDocling } from "./mock-docling-serve.js";
import type { MockDocling } from "./mock-docling-serve.js";
import { healthAction } from "../src/lib/actions/health.js";
import { makeActionContext } from "./mock-context.js";
import { startMockDocling as startMock2 } from "./mock-docling-serve.js";

const SERVER = { apiUrl: "", publicUrl: "" } as never; // validate never touches server

describe("doclingAuth.validate", () => {
  let mock: MockDocling;
  beforeAll(async () => {
    mock = await startMockDocling({ apiKey: "k-test" });
  });
  afterAll(async () => await mock.close());

  it("validates against a healthy server with a correct key", async () => {
    const res = await doclingAuth.validate!({
      auth: { base_url: mock.baseUrl, api_key: "k-test" },
      server: SERVER,
    });
    expect(res).toEqual({ valid: true });
  });

  it("reports a rejected key", async () => {
    const res = await doclingAuth.validate!({
      auth: { base_url: mock.baseUrl, api_key: "wrong" },
      server: SERVER,
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.error).toMatch(/401/);
  });

  it("reports an unreachable server", async () => {
    const res = await doclingAuth.validate!({
      auth: { base_url: "http://127.0.0.1:1", api_key: undefined },
      server: SERVER,
    });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.error).toMatch(/Could not reach/);
  });
});

describe("authFromCtx", () => {
  it("normalizes base URL and optional key", () => {
    expect(authFromCtx({ auth: { props: { base_url: "http://x:5001/", api_key: "k" } } })).toEqual({
      baseUrl: "http://x:5001",
      apiKey: "k",
    });
    expect(authFromCtx({ auth: { props: { base_url: "", api_key: "" } } })).toEqual({
      baseUrl: "http://localhost:5001",
    });
    expect(authFromCtx({ auth: undefined })).toEqual({ baseUrl: "http://localhost:5001" });
  });
});

describe("health action", () => {
  it("returns status + versions", async () => {
    const mock = await startMock2({ apiKey: "k-test" });
    try {
      const out = await healthAction.run(
        makeActionContext(
          {},
          { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "k-test" } },
        ) as never,
      );
      // vitest 4.1.1 types expect.objectContaining as `any`; `as unknown` is the
      // minimal silencer for no-unsafe-assignment.
      expect(out).toEqual({ status: "ok", versions: expect.objectContaining({ "docling-serve": "1.32.0", docling: "2.126.0" }) as unknown });
    } finally {
      await mock.close();
    }
  });

  it("throws a typed AUTH error on 401", async () => {
    const mock = await startMock2({ apiKey: "k-test" });
    try {
      await expect(
        healthAction.run(
          makeActionContext(
            {},
            { type: "CUSTOM_AUTH", props: { base_url: mock.baseUrl, api_key: "nope" } },
          ) as never,
        ),
      ).rejects.toMatchObject({ kind: "AUTH", name: "DoclingError" });
    } finally {
      await mock.close();
    }
  });
});
