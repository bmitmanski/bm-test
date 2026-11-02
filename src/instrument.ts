import * as Sentry from "@sentry/node";

// Loaded before anything else (first import in index.ts) so Sentry can instrument fastify, pg and ioredis.
// Without SENTRY_DSN (local dev, tests) the SDK does nothing.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? "development",
  release: process.env.APP_VERSION, // commit SHA, set in the Docker image
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.2),
  integrations: [
    // 4xx are client mistakes: visible in metrics, not worth an issue in Sentry.
    Sentry.fastifyIntegration({ shouldHandleError: (_error, _request, reply) => reply.statusCode >= 500 }),
  ],
});
