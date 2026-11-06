// End-to-end tests against a deployed environment (real Caddy, Postgres, Redis, S3).
// Run by the Deploy workflow against staging before production; locally:
//   BASE_URL=https://staging.bm-test.duckdns.org npm run test:e2e
// Only safe operations: nothing here crashes the API or creates Sentry issues.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.BASE_URL?.replace(/\/$/, "");
if (!BASE_URL) throw new Error("Set BASE_URL, e.g. https://staging.bm-test.duckdns.org");

const api = (path: string, init?: RequestInit) =>
  fetch(`${BASE_URL}/api${path}`, { ...init, signal: AbortSignal.timeout(10_000) });

test("serves the version under test", async () => {
  const res = await api("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  if (process.env.EXPECTED_VERSION) assert.equal(body.version, process.env.EXPECTED_VERSION);
});

test("Postgres, Redis and S3 are ready", async () => {
  const res = await api("/ready");
  assert.deepEqual(await res.json(), { db: "ok", redis: "ok", storage: "ok" });
  assert.equal(res.status, 200);
});

test("records visits in Postgres and Redis", async () => {
  const first = await (await api("/visits", { method: "POST" })).json();
  const second = await (await api("/visits", { method: "POST" })).json();
  assert.ok(first.visit.id, "visit row returned");
  assert.ok(second.hits > first.hits, "Redis counter increases");
});

test("uploads a file to S3 and downloads the same content", async () => {
  const content = `e2e ${randomUUID()}`;
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/plain" }), "e2e.txt");

  const up = await api("/files", { method: "POST", body: form });
  assert.equal(up.status, 201, await up.clone().text());
  const { key } = await up.json();

  const down = await api(`/files/${encodeURIComponent(key)}`);
  assert.equal(down.status, 200);
  assert.match(down.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await down.text(), content);
});

test("unknown file is a 404", async () => {
  const res = await api(`/files/does-not-exist-${randomUUID()}`);
  await res.body?.cancel();
  assert.equal(res.status, 404);
});

test("invalid input is rejected with 400", async () => {
  const res = await api("/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ not: "a message" }),
  });
  await res.body?.cancel();
  assert.equal(res.status, 400);
});

test("metrics are not public", async () => {
  const res = await api("/metrics");
  await res.body?.cancel();
  assert.equal(res.status, 404);
});

test("frontend is served over HTTPS", async () => {
  const res = await fetch(BASE_URL, { signal: AbortSignal.timeout(10_000) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /<script/);
});
