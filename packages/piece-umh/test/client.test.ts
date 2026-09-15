import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeBaseUrl, readAuth } from "../src/lib/common/auth-value";
import { UmhClient } from "../src/lib/common/client";
import { UmhApiError } from "../src/lib/common/errors";
import { failure } from "./helpers";
import { order, startMockUmh, type MockUmh } from "./mock-umh";

let mock: MockUmh;

beforeAll(async () => {
  mock = await startMockUmh({ orders: [order()] });
});

afterAll(async () => {
  await mock.close();
});

function clientFor(baseUrl: string): UmhClient {
  return new UmhClient({ baseUrl });
}

describe("base URL", () => {
  it("refuses a URL that already points at the API", () => {
    // Every request built on it would 404 with no hint why.
    expect(() => normalizeBaseUrl("http://localhost:8081/api")).toThrowError(
      /must not include the \/api suffix/,
    );
  });

  it("strips trailing slashes so paths do not double up", () => {
    expect(normalizeBaseUrl("http://localhost:8081///")).toBe(
      "http://localhost:8081",
    );
  });

  it("tells someone who omitted the scheme to add it", () => {
    // `localhost:8081` is a valid URL whose protocol is "localhost:", so the
    // useful answer is the missing http://, not a complaint about protocols.
    expect(() => normalizeBaseUrl("localhost:8081")).toThrowError(
      "Base URL is missing its scheme — use http://localhost:8081",
    );
  });

  it("still reports a genuinely wrong protocol as one", () => {
    expect(() => normalizeBaseUrl("ftp://floor.example.com")).toThrowError(
      /must be http or https/,
    );
  });

  it("reads the connection shape the reactor passes and the flat one AP passes", () => {
    const nested = readAuth({
      type: "CUSTOM_AUTH",
      props: { base_url: "http://localhost:8081" },
    });
    const flat = readAuth({ base_url: "http://localhost:8081" });

    expect(nested).toEqual(flat);
  });
});

describe("requests", () => {
  it("reads an empty collection answered as null, not as a crash", async () => {
    // The floor's own spelling of "nothing here" — the normal state at boot
    // with the ERP in manual mode.
    mock.state.orders = null;

    await expect(clientFor(mock.baseUrl).listOrders()).resolves.toEqual([]);

    mock.state.orders = [order()];
  });

  it("maps an unknown order to a not_found error carrying the floor's message", async () => {
    const error = await failure(clientFor(mock.baseUrl).getOrder("nope"));

    expect(error).toBeInstanceOf(UmhApiError);
    expect(error).toMatchObject({
      status: 404,
      category: "not_found",
      retryable: false,
    });
    expect((error as UmhApiError).message).toContain("order not found");
  });

  it("marks a server fault retryable and a bad request not", async () => {
    mock.failNext("/api/orders", 503, { error: "restarting" });
    const server = await failure(clientFor(mock.baseUrl).listOrders());

    mock.failNext("/api/orders", 400, { error: "invalid request body" });
    const bad = await failure(clientFor(mock.baseUrl).listOrders());

    expect(server).toMatchObject({ category: "server", retryable: true });
    expect(bad).toMatchObject({ category: "validation", retryable: false });
  });

  it("reports an unreachable floor as a retryable network failure", async () => {
    // Port 1 refuses immediately, so this does not wait on a timeout.
    const error = await failure(clientFor("http://127.0.0.1:1").health());

    expect(error).toMatchObject({ category: "network", retryable: true });
    expect(error.message).toContain("Could not reach the UMH floor API");
  });

  it("says so when the floor answers too slowly", async () => {
    const stalling = new UmhClient(
      { baseUrl: mock.baseUrl },
      {
        fetchImpl: ((_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          })) as unknown as typeof fetch,
        defaultTimeoutMs: 20,
      },
    );

    const error = await failure(stalling.listOrders());

    expect(error).toMatchObject({ category: "timeout", retryable: true });
    expect(error.message).toContain("did not answer");
  });

  it("puts the health probe at the root, not under /api", async () => {
    await clientFor(mock.baseUrl).health();

    expect(mock.requests.map((entry) => entry.path)).toContain("/health");
  });
});
