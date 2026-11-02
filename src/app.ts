import Fastify, { FastifyReply, FastifyRequest, FastifyServerOptions, LogController } from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Readable } from "node:stream";
import { createMetrics, Metrics } from "./metrics";

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

export interface AppOptions {
  fastify?: FastifyServerOptions;
  metrics?: Metrics;
  // Endpoints that deliberately fail, for testing logs/metrics/alerts. Never enable for real users.
  debugRoutes?: boolean;
}

// One compact line per request instead of Fastify's two verbose ones ("incoming request" + "request completed").
// 5xx errors are still logged by Fastify with the stack trace (defaultErrorLog).
class RequestLogController extends LogController {
  incomingRequest() {}

  requestCompleted(_error: unknown, req: FastifyRequest, reply: FastifyReply) {
    const route = req.routeOptions.url ?? "unmatched";
    // Scrapes and healthchecks run every few seconds: debug level keeps them out of production logs.
    const level = route === "/metrics" || route === "/health" ? "debug" : reply.statusCode >= 400 ? "warn" : "info";
    reply.log[level]({ method: req.method, url: req.url, route, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, "request");
  }
}

export function buildApp(deps: Deps, { fastify = {}, metrics = createMetrics({ defaultMetrics: false }), debugRoutes = false }: AppOptions = {}) {
  const app = Fastify({ logController: new RequestLogController(), ...fastify });
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  const track = (event: string, data: Record<string, unknown> = {}) => {
    metrics.events.inc({ event });
    app.log.info({ event, ...data }, event);
  };

  app.addHook("onResponse", async (req, reply) => {
    // Route pattern (/files/:key), not the raw URL, to keep label cardinality low.
    const route = req.routeOptions.url ?? "unmatched";
    if (route === "/metrics") return;
    metrics.httpRequests.inc({ method: req.method, route, status_code: reply.statusCode });
    metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 400) metrics.httpErrors.inc({ class: reply.statusCode >= 500 ? "5xx" : "4xx" });
  });

  // Scraped by Alloy over the internal Docker network; Caddy blocks it from the outside.
  app.get("/metrics", async (_req, reply) => {
    reply.type(metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  // Liveness: process is up. Used by Docker healthcheck and the deploy smoke test.
  app.get("/health", async () => ({ status: "ok", version: process.env.APP_VERSION ?? "dev", debugRoutes }));

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
    track("visit.recorded", { visitId: rows[0].id, hits });
    return { hits, visit: rows[0] };
  });

  app.post("/files", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "no file" });
    const key = `${randomUUID()}-${file.filename}`;
    const body = await file.toBuffer();
    await deps.storage.put(key, body, file.mimetype);
    track("file.uploaded", { key, bytes: body.length, mimetype: file.mimetype });
    return reply.code(201).send({ key });
  });

  app.get<{ Params: { key: string } }>("/files/:key", async (req, reply) => {
    const obj = await deps.storage.get(req.params.key);
    if (!obj) return reply.code(404).send({ error: "not found" });
    track("file.downloaded", { key: req.params.key });
    if (obj.contentType) reply.type(obj.contentType);
    return reply.send(obj.body);
  });

  // Browser errors (window.onerror) land in the same logs/metrics as server ones.
  app.post<{ Body: { message: string; stack?: string; url?: string } }>(
    "/client-errors",
    {
      bodyLimit: 16 * 1024,
      schema: {
        body: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string" }, stack: { type: "string" }, url: { type: "string" } },
        },
      },
    },
    async (req, reply) => {
      metrics.frontendErrors.inc();
      req.log.error({ source: "frontend", ...req.body }, `frontend error: ${req.body.message}`);
      return reply.code(204).send();
    },
  );

  if (debugRoutes) {
    // Unhandled exception -> 500, logged at level=error with stack trace.
    app.get("/debug/error", async () => {
      throw new Error("Test server error triggered from UI");
    });

    // Client mistake -> 400 from schema validation (should NOT page anyone).
    app.post("/debug/validation", { schema: { body: { type: "object", required: ["email"] } } }, async () => ({ ok: true }));

    // Slow endpoint -> shows up in the latency histogram (p95).
    app.get<{ Querystring: { ms?: number } }>(
      "/debug/slow",
      { schema: { querystring: { type: "object", properties: { ms: { type: "integer", minimum: 0, maximum: 10000 } } } } },
      async (req) => {
        const ms = req.query.ms ?? 2000;
        await sleep(ms);
        return { sleptMs: ms };
      },
    );

    // A dependency fails -> 500 with a different error (simulates DB being down).
    app.get("/debug/db-error", async () => deps.db.query("SELECT * FROM table_that_does_not_exist"));

    // Uncaught exception outside any request -> Sentry reports it, the process dies, Docker restarts it.
    app.post("/debug/crash", async (req, reply) => {
      req.log.fatal("Crash requested from UI");
      reply.send({ crashing: true });
      setTimeout(() => {
        throw new Error("Test crash: uncaught exception triggered from UI");
      }, 100);
    });
  }

  return app;
}
