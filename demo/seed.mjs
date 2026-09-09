// Wait for the demo stack (docker compose -f demo/docker-compose.yml up -d)
// to become ready, mint a paperless-ngx API token, and print the exact
// values the two Connect connections need.
//
//   node demo/seed.mjs
//
// No dependencies; Node >= 18 (the repo requires 24). The paperless token
// is persisted to demo/.paperless-token so re-runs reuse it; a token is
// only accepted once it has proven itself by listing documents, and a
// stale one (e.g. from a deleted-and-recreated stack) is replaced with a
// fresh mint.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// (fetch's AbortSignal timeout below is the hang guard: while the
// container converges, a request accepted by a dying worker can never
// answer, and only an abort makes the probe retryable.)

const here = path.dirname(fileURLToPath(import.meta.url));
const tokenFile = path.join(here, ".paperless-token");

const DOCLING_URL = process.env.DOCLING_URL ?? "http://localhost:5001";
const PAPERLESS_URL = process.env.PAPERLESS_URL ?? "http://localhost:18000";
const PAPERLESS_USER = process.env.PAPERLESS_USER ?? "admin";
const PAPERLESS_PASSWORD = process.env.PAPERLESS_PASSWORD ?? "paperless-demo";
const port = Number(new URL(PAPERLESS_URL).port);

// Polls a condition instead of sleeping a guessed interval. A probe that
// returns undefined retries; one that throws a non-retryable error fails
// the whole script (e.g. a bad login), so a misconfiguration is reported
// immediately instead of being retried for three minutes.

// A hard ceiling on one probe attempt. A 10s request abort covers
// network-level silence, but a response that delivers its headers and
// then never its body can outlive the abort (the fetch promise is
// already settled, and the body promise may never reject). Racing the
// probe against a timer guarantees the poll loop always makes progress.
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("probe stalled"), { retryable: true })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(label, probe, { timeoutMs = 180_000, everyMs = 1_000 } = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastNotice = 0;
  for (;;) {
    try {
      const value = await withTimeout(probe(), 30_000);
      if (value !== undefined) {
        console.log(`  ${label} is up`);
        return value;
      }
    } catch (err) {
      if (!err.retryable) throw err;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label} (is the compose stack running?)`);
    }
    if (Date.now() - start > 10_000 && Date.now() - lastNotice > 30_000) {
      lastNotice = Date.now();
      console.log(`  (still waiting for ${label} — ${Math.round((Date.now() - start) / 1000)}s …)`);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// A fetch to a server that is not listening yet throws a connection
// error; mark it retryable so the probe can be polled. The hard
// timeout covers a request accepted by a dying worker that never
// answers (headers delivered, body never). `connection: close` keeps
// every probe on a fresh TCP connection, so a stale pooled socket can
// never make the probe see a stale answer.
function getJson(url, headers = {}) {
  return fetch(url, {
    headers: { connection: "close", ...headers },
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw Object.assign(err, { retryable: true });
  });
}

async function doclingReady() {
  const res = await getJson(`${DOCLING_URL}/health`);
  if (res.status !== 200) return;
  const body = await res.json().catch(() => ({}));
  if (body.status !== "ok") return;
  const version = await getJson(`${DOCLING_URL}/version`).then((r) => r.json()).catch(() => null);
  return version ? String(version["docling-serve"] ?? "?") : "ok";
}

// The web process (gunicorn) starts well after the container reports
// "running"; a closed port is the readiness signal to wait on.
function portOpen() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", (err) => {
      reject(Object.assign(err, { retryable: true }));
    });
  });
}

// Throws non-retryable when the server answers and rejects the login
// (400/401/403), retryable while it is still coming up (connection refused,
// 5xx).
async function mintToken() {
  const res = await fetch(`${PAPERLESS_URL}/api/token/`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ username: PAPERLESS_USER, password: PAPERLESS_PASSWORD }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw Object.assign(err, { retryable: true });
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(
        `paperless rejected the login for ${PAPERLESS_USER} (HTTP ${res.status}); ` +
          `check PAPERLESS_ADMIN_USER / PAPERLESS_ADMIN_PASSWORD in demo/docker-compose.yml`,
      );
    }
    throw Object.assign(new Error(`paperless returned ${res.status} while minting the token`), {
      retryable: true,
    });
  }
  const body = await res.json();
  return body.token;
}

// A token only counts as ready when it can actually list documents.
// /api/user/1/ cannot gate this: on the 2.18 line it is not a
// token-authenticated API route (it 302-redirects even with a valid
// token), and while the container is still booting the server happily
// 200s anything, so a 200 there proves nothing.
async function documentCountFor(token) {
  const res = await getJson(`${PAPERLESS_URL}/api/documents/?page_size=1`, {
    authorization: `Token ${token}`,
  });
  if (res.status !== 200) return;
  const body = await res.json();
  return body.count;
}

console.log(`docling-serve    ${DOCLING_URL}`);
console.log(`paperless-ngx    ${PAPERLESS_URL}`);

const doclingVersion = await waitFor("docling-serve", doclingReady, { timeoutMs: 240_000 });

await waitFor("paperless-ngx web port", portOpen);

let token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
let announced = false;
const documentCount = await waitFor(
  "paperless-ngx",
  async () => {
    if (token !== "") {
      const n = await documentCountFor(token);
      if (n !== undefined) return n;
    }
    // Mint (or re-mint; paperless returns the same per-user token).
    // This only succeeds once the server accepts the admin login, and
    // the result is re-validated on the documents route below, so a
    // boot-window 200 can never make a bad token look good.
    const fresh = await mintToken();
    if (fresh === undefined) return;
    if (!announced) {
      announced = true;
      console.log("minting a paperless API token …");
    }
    token = fresh;
    writeFileSync(tokenFile, token, { mode: 0o600 });
    return documentCountFor(token);
  },
  { timeoutMs: 600_000 },
);

console.log(`\nReady. docling-serve ${doclingVersion}, paperless holds ${documentCount} document(s).\n`);
console.log("Create the two connections in Connect (Settings → Connections):");
console.log("");
console.log("  Paperless-ngx");
console.log(`    base_url  ${PAPERLESS_URL}`);
console.log(`    token     ${token}`);
console.log(`    (token file: ${path.relative(process.cwd(), tokenFile)})`);
console.log("");
console.log("  Docling Serve");
console.log(`    base_url  ${DOCLING_URL}`);
console.log("    api_key   (leave empty — the demo server runs unauthenticated)");
console.log("");
console.log("Then build the demo workflow (see demo/README.md) and upload");
console.log("demo/sample-invoice.pdf into paperless.");
