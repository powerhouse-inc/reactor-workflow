import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  normalizeBaseUrl,
  readAuth,
} from "../pieces/paperless-ngx/lib/common/auth-value";
import { PaperlessApiError } from "../pieces/paperless-ngx/lib/common/errors";
import {
  PaperlessClient,
  type VersionCache,
} from "../pieces/paperless-ngx/lib/common/client";
import type { MockPaperless } from "./mock-paperless";
import { startMockPaperless } from "./mock-paperless";

function clientFor(
  mock: MockPaperless,
  options: { versionCache?: VersionCache; apiVersion?: number } = {},
): PaperlessClient {
  return new PaperlessClient(
    { baseUrl: mock.baseUrl, token: "test-token" },
    options,
  );
}

describe("normalizeBaseUrl", () => {
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://paperless.example.com/")).toBe(
      "https://paperless.example.com",
    );
  });

  it("rejects a base URL that already points at the API", () => {
    expect(() => normalizeBaseUrl("https://paperless.example.com/api")).toThrow(
      /must not include the \/api suffix/,
    );
  });

  it("rejects a non-URL", () => {
    expect(() => normalizeBaseUrl("paperless")).toThrow(/not a valid URL/);
  });

  it("rejects a non-http scheme", () => {
    expect(() => normalizeBaseUrl("ftp://paperless.example.com")).toThrow(
      /must be http or https/,
    );
  });
});

describe("readAuth", () => {
  it("reads the reactor's shaped CUSTOM_AUTH value", () => {
    expect(
      readAuth({
        type: "CUSTOM_AUTH",
        props: { base_url: "https://p.example.com/", token: " abc " },
      }),
    ).toEqual({ baseUrl: "https://p.example.com", token: "abc" });
  });

  it("reads the flat value Activepieces 0.32.0 hands to validate", () => {
    expect(
      readAuth({ base_url: "https://p.example.com", token: "abc" }),
    ).toEqual({ baseUrl: "https://p.example.com", token: "abc" });
  });

  it("fails clearly when the token is missing", () => {
    expect(() => readAuth({ base_url: "https://p.example.com" })).toThrow(
      /missing its API token/,
    );
  });
});

describe("PaperlessClient versioning", () => {
  let mock: MockPaperless;

  afterEach(async () => {
    await mock.close();
  });

  it("pins version 10 on a 3.x server without a probe", async () => {
    mock = await startMockPaperless();
    const client = clientFor(mock);
    const settings = await client.uiSettings();

    expect(settings.username).toBe("archivist");
    expect(settings.serverVersion).toBe("3.1.3");
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].accept).toBe("application/json; version=10");
  });

  it("negotiates down to 9 on a 2.18 server, then remembers it", async () => {
    mock = await startMockPaperless({
      allowedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      serverVersion: "2.18.4",
    });
    const stored: number[] = [];
    const cache: VersionCache = {
      get: () => Promise.resolve(undefined),
      set: (version) => {
        stored.push(version);
        return Promise.resolve();
      },
    };
    const client = clientFor(mock, { versionCache: cache });

    const first = await client.uiSettings();
    expect(first.username).toBe("archivist");

    // Optimistic v10 -> 406, unversioned probe, replay pinned at 9.
    expect(mock.requests.map((request) => request.accept)).toEqual([
      "application/json; version=10",
      "application/json",
      "application/json; version=9",
    ]);
    expect(stored).toEqual([9]);

    // The pin sticks: no second 406, no second probe.
    await client.uiSettings();
    expect(mock.requests).toHaveLength(4);
    expect(mock.requests[3].accept).toBe("application/json; version=9");
  });

  it("uses a cached version without a 406 round trip", async () => {
    mock = await startMockPaperless({
      allowedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      serverVersion: "2.18.4",
    });
    const client = clientFor(mock, {
      versionCache: {
        get: () => Promise.resolve(9),
        set: () => Promise.resolve(),
      },
    });

    await client.uiSettings();

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].accept).toBe("application/json; version=9");
  });

  it("refuses a server too old to speak version 9, naming the ceiling", async () => {
    mock = await startMockPaperless({
      allowedVersions: [1, 2, 3, 4, 5, 6, 7],
      serverVersion: "2.14.7",
    });
    const client = clientFor(mock);

    await expect(client.uiSettings()).rejects.toThrow(
      /API version 7 at most.*needs 9 or newer.*2\.14\.7/s,
    );
  });
});

describe("PaperlessClient list envelopes", () => {
  let mock: MockPaperless;

  afterEach(async () => {
    await mock.close();
  });

  it("reads the v10 paginated tasks envelope", async () => {
    mock = await startMockPaperless();
    const task = mock.seedTask({ status: "success", related_document_ids: [7] });
    const client = clientFor(mock);

    const { results, count } = await client.list<Record<string, unknown>>(
      "tasks/",
      { task_id: task.task_id },
    );

    expect(count).toBe(1);
    expect(results[0].related_document_ids).toEqual([7]);
  });

  it("reads the v9 unpaginated tasks list", async () => {
    mock = await startMockPaperless({
      allowedVersions: [9],
      serverVersion: "2.18.4",
    });
    const task = mock.seedTask({ status: "success", related_document_ids: [7] });
    const client = clientFor(mock, { apiVersion: 9 });

    const { results, count } = await client.list<Record<string, unknown>>(
      "tasks/",
      { task_id: task.task_id },
    );

    expect(count).toBe(1);
    // Raw v9 wire format: a *string* id, as paperless 2.18.4 really answers.
    // normalizeTask is what turns it back into a number.
    expect(results[0].related_document).toBe("7");
    expect(results[0].task_file_name).toBeNull();
  });
});

describe("PaperlessClient error mapping", () => {
  let mock: MockPaperless;

  beforeEach(async () => {
    mock = await startMockPaperless();
  });

  afterEach(async () => {
    await mock.close();
  });

  it("maps a rejected token to a credential error", async () => {
    const client = new PaperlessClient({
      baseUrl: mock.baseUrl,
      token: "wrong",
    });

    await expect(client.uiSettings()).rejects.toMatchObject({
      name: "PaperlessApiError",
      status: 401,
      category: "credential",
      retryable: false,
    });
  });

  it("maps a 404 to a not-found error that names the base URL", async () => {
    const client = clientFor(mock);

    await expect(
      client.request({ path: "documents/999/" }),
    ).rejects.toMatchObject({ category: "not_found", status: 404 });
    await expect(client.request({ path: "documents/999/" })).rejects.toThrow(
      new RegExp(mock.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("surfaces the DRF validation detail", async () => {
    mock.failOnce("PATCH /documents/1/", 400, {
      title: ["This field may not be blank."],
    });
    mock.seedDocument({ id: 1 });
    const client = clientFor(mock);

    await expect(
      client.request({
        method: "PATCH",
        path: "documents/1/",
        json: { title: "" },
      }),
    ).rejects.toThrow(/title: This field may not be blank\./);
  });

  it("marks 5xx and rate limits as retryable", async () => {
    mock.failOnce("GET /documents/", 503);
    const client = clientFor(mock);
    await expect(client.request({ path: "documents/" })).rejects.toMatchObject({
      category: "server",
      retryable: true,
    });

    mock.failOnce("GET /documents/", 429);
    await expect(client.request({ path: "documents/" })).rejects.toMatchObject({
      category: "rate_limit",
      retryable: true,
    });
  });

  it("reports an unreachable server as a retryable network error", async () => {
    await mock.close();
    const client = clientFor(mock);

    const error: unknown = await client
      .request({ path: "documents/" })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PaperlessApiError);
    expect(error).toMatchObject({ category: "network", retryable: true });
  });
});
