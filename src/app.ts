import Fastify, { FastifyServerOptions } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

// Dependencies are injected so tests can swap them for fakes.
export interface Deps {
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
  redis: { incr(key: string): Promise<number>; ping(): Promise<string> };
  storage: {
    put(key: string, body: Buffer, contentType: string): Promise<void>;
    get(key: string): Promise<{ body: Readable; contentType?: string } | null>;
    ping(): Promise<void>;
  };
}

export function buildApp(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify(opts);
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Liveness: process is up. Used by Docker healthcheck and the deploy smoke test.
  app.get("/health", async () => ({ status: "ok", version: process.env.APP_VERSION ?? "dev" }));

  // Readiness: all backing services respond.
  app.get("/ready", async (_req, reply) => {
    const checks = await Promise.allSettled([
      deps.db.query("SELECT 1"),
      deps.redis.ping(),
      deps.storage.ping(),
    ]);
    const [db, redis, storage] = checks.map((c) => (c.status === "fulfilled" ? "ok" : "fail"));
    const ok = checks.every((c) => c.status === "fulfilled");
    return reply.code(ok ? 200 : 503).send({ db, redis, storage });
  });

  // Touches Postgres + Redis in one request.
  app.post("/visits", async (req) => {
    const hits = await deps.redis.incr("visits:counter");
    const { rows } = await deps.db.query(
      "INSERT INTO visits (user_agent) VALUES ($1) RETURNING id, created_at",
      [req.headers["user-agent"] ?? null],
    );
    req.log.info({ visitId: rows[0].id, hits }, "visit recorded");
    return { hits, visit: rows[0] };
  });

  app.post("/files", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no file" });
    const key = `${randomUUID()}-${file.filename}`;
    await deps.storage.put(key, await file.toBuffer(), file.mimetype);
    return reply.code(201).send({ key });
  });

  app.get<{ Params: { key: string } }>("/files/:key", async (req, reply) => {
    const obj = await deps.storage.get(req.params.key);
    if (!obj) return reply.code(404).send({ error: "not found" });
    if (obj.contentType) reply.type(obj.contentType);
    return reply.send(obj.body);
  });

  return app;
}
