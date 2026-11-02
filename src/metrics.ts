import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// One registry per app instance, so tests can build many apps without name clashes.
export function createMetrics({ defaultMetrics = true } = {}) {
  const registry = new Registry();
  if (defaultMetrics) collectDefaultMetrics({ register: registry }); // heap, event loop lag, GC, ...

  // Series that appear only on the first error are invisible to increase()/rate() —
  // so the first 5xx after a restart would never alert. Pre-create them at 0.
  const httpErrors = new Counter({
    name: "http_errors_total",
    help: "HTTP responses with 4xx/5xx status",
    labelNames: ["class"],
    registers: [registry],
  });
  httpErrors.inc({ class: "4xx" }, 0);
  httpErrors.inc({ class: "5xx" }, 0);

  // Business events (visit.recorded, file.uploaded, ...) — the things a product owner asks about.
  const events = new Counter({
    name: "app_events_total",
    help: "Business events",
    labelNames: ["event"],
    registers: [registry],
  });
  for (const event of ["visit.recorded", "file.uploaded", "file.downloaded"]) events.inc({ event }, 0);

  return {
    registry,
    httpErrors,
    events,
    httpRequests: new Counter({
      name: "http_requests_total",
      help: "HTTP requests by route and status code",
      labelNames: ["method", "route", "status_code"],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request latency",
      labelNames: ["method", "route"],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    frontendErrors: new Counter({
      name: "frontend_errors_total",
      help: "Errors reported by the browser",
      registers: [registry],
    }),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
