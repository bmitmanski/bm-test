import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp, Deps } from "../src/app";

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  let counter = 0;
  return {
    db: { query: async () => ({ rows: [{ id: 1, created_at: new Date().toISOString() }] }) },
    redis: { incr: async () => ++counter, ping: async () => "PONG" },
    storage: { put: async () => {}, get: async () => null, ping: async () => {} },
    ...overrides,
  };
}

test("GET /health returns ok", async () => {
  const res = await buildApp(fakeDeps()).inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, "ok");
});

test("GET /ready returns 503 when a dependency fails", async () => {
  const deps = fakeDeps({ redis: { incr: async () => 0, ping: async () => { throw new Error("down"); } } });
  const res = await buildApp(deps).inject({ method: "GET", url: "/ready" });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { db: "ok", redis: "fail", storage: "ok" });
});

test("POST /visits increments counter", async () => {
  const app = buildApp(fakeDeps());
  await app.inject({ method: "POST", url: "/visits" });
  const res = await app.inject({ method: "POST", url: "/visits" });
  assert.equal(res.json().hits, 2);
});
