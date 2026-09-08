import { startMockDocling, MOCK_MD, MOCK_CHUNKS, type MockDocling } from "./mock-docling-serve.js";

let mock: MockDocling;

async function get(path: string, key?: string) {
  const url = new URL(path, mock.baseUrl);
  if (key) url.searchParams.set("api_key", key);
  const res = await fetch(url, { headers: key ? { "x-api-key": key } : {} });
  return { status: res.status, body: (await res.json()) as unknown };
}

beforeAll(async () => {
  mock = await startMockDocling({ apiKey: "k-test" });
});
afterAll(async () => await mock.close());

it("enforces X-Api-Key when configured", async () => {
  expect((await get("/health")).status).toBe(401);
  const res = await fetch(mock.baseUrl + "/health", { headers: { "x-api-key": "k-test" } });
  expect(res.status).toBe(200);
  expect((await res.json()) as unknown).toEqual({ status: "ok" });
});

it("serves /version with the real 1.32.0 hyphenated key set", async () => {
  const res = await fetch(mock.baseUrl + "/version", { headers: { "x-api-key": "k-test" } });
  const body = (await res.json()) as Record<string, string>;
  expect(body["docling-serve"]).toBe("1.32.0");
  expect(body["docling"]).toBe("2.126.0");
  expect(body.plaform).toBeDefined(); // upstream typo, matched verbatim
});

it("sync /v1/convert/source returns the canned document for the requested formats", async () => {
  const res = await fetch(mock.baseUrl + "/v1/convert/source", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k-test" },
    body: JSON.stringify({
      sources: [{ kind: "file", base64_string: "AAAA", filename: "a.pdf" }],
      options: { to_formats: ["md"] },
      target: { kind: "inbody" },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string; document: { md_content: string; json_content: unknown } };
  expect(body.status).toBe("success");
  expect(body.document.md_content).toBe(MOCK_MD);
  expect(body.document.json_content).toBeNull(); // not requested
});

it("async: submit → poll (started → success) → result", async () => {
  const sub = await fetch(mock.baseUrl + "/v1/convert/source/async", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k-test" },
    body: JSON.stringify({
      sources: [{ kind: "http", url: "https://example.com/x.pdf" }],
      options: { to_formats: ["md", "json"] },
      target: { kind: "inbody" },
    }),
  });
  const task = (await sub.json()) as { task_id: string; task_status: string };
  expect(task.task_status).toBe("pending");
  const before = mock.pollCount;
  const p1 = await get(`/v1/status/poll/${task.task_id}?wait=5`, "k-test");
  expect(p1.body).toMatchObject({ task_status: "started" });
  const p2 = await get(`/v1/status/poll/${task.task_id}?wait=5`, "k-test");
  expect(p2.body).toMatchObject({ task_status: "success" });
  expect(mock.pollCount).toBe(before + 2);
  const result = await get(`/v1/result/${task.task_id}`, "k-test");
  expect(result.body).toMatchObject({ status: "success" });
  expect((result.body as { document: { json_content: unknown } }).document.json_content).toBeTruthy();
});

it("chunk async: submit → poll → result returns the chunk payload, not a document", async () => {
  const sub = await fetch(mock.baseUrl + "/v1/chunk/async", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k-test" },
    body: JSON.stringify({
      sources: [{ kind: "file", base64_string: "AAAA", filename: "c.pdf" }],
      options: { to_formats: ["md"] },
    }),
  });
  const task = (await sub.json()) as { task_id: string; task_status: string; task_type: string };
  expect(task.task_type).toBe("chunk");
  expect(task.task_status).toBe("pending");
  const p1 = await get(`/v1/status/poll/${task.task_id}?wait=5`, "k-test");
  expect(p1.body).toMatchObject({ task_status: "started" });
  const p2 = await get(`/v1/status/poll/${task.task_id}?wait=5`, "k-test");
  expect(p2.body).toMatchObject({ task_status: "success" });
  const result = await get(`/v1/result/${task.task_id}`, "k-test");
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ chunks: MOCK_CHUNKS, processing_time: 0.3 });
  expect((result.body as { document?: unknown }).document).toBeUndefined();
});

it("reports 429 with Retry-After for backpressure, then succeeds", async () => {
  const m2 = await startMockDocling({ apiKey: "k-test", backpressure: 2 });
  try {
    const doConvert = () =>
      fetch(m2.baseUrl + "/v1/convert/source/async", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k-test" },
        body: JSON.stringify({ sources: [{ kind: "http", url: "https://example.com/y.pdf" }] }),
      });
    const r1 = await doConvert();
    expect(r1.status).toBe(429);
    expect(r1.headers.get("retry-after")).toBe("0");
    expect((await doConvert()).status).toBe(429);
    expect((await doConvert()).status).toBe(200);
  } finally {
    await m2.close();
  }
});

it("504 on sync when syncSlow", async () => {
  const m3 = await startMockDocling({ apiKey: "k-test", syncSlow: true });
  try {
    const res = await fetch(m3.baseUrl + "/v1/convert/source", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k-test" },
      body: JSON.stringify({ sources: [{ kind: "http", url: "https://example.com/z.pdf" }] }),
    });
    expect(res.status).toBe(504);
  } finally {
    await m3.close();
  }
});

it("async job failure surfaces TaskFailureResult on /v1/result", async () => {
  const m4 = await startMockDocling({ apiKey: "k-test", failJobs: ["bad.pdf"] });
  try {
    const sub = await fetch(m4.baseUrl + "/v1/convert/source/async", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k-test" },
      body: JSON.stringify({ sources: [{ kind: "file", base64_string: "AAAA", filename: "bad.pdf" }] }),
    });
    const task = (await sub.json()) as { task_id: string };
    // drain to failure
    let status = "started";
    for (let i = 0; i < 5 && status !== "failure"; i++) {
      const p = await fetch(`${m4.baseUrl}/v1/status/poll/${task.task_id}`, { headers: { "x-api-key": "k-test" } });
      status = ((await p.json()) as { task_status: string }).task_status;
    }
    expect(status).toBe("failure");
    const result = await fetch(`${m4.baseUrl}/v1/result/${task.task_id}`, { headers: { "x-api-key": "k-test" } });
    expect(result.status).toBe(200);
    expect((await result.json()) as unknown).toMatchObject({
      failure: { category: "inference_failure", retryable: false },
    });
  } finally {
    await m4.close();
  }
});

it("chunk endpoint returns the canned chunks", async () => {
  const res = await fetch(mock.baseUrl + "/v1/chunk/hybrid/source", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "k-test" },
    body: JSON.stringify({ sources: [{ kind: "http", url: "https://example.com/c.pdf" }] }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()) as unknown).toMatchObject({ chunks: expect.any(Array) });
});
