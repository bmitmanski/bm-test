import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createServices } from "./services";

async function main() {
  const config = loadConfig();
  const services = await createServices(config);
  // JSON logs to stdout -> Docker -> Alloy -> Loki -> Grafana.
  const app = buildApp(services.deps, {
    logger: { level: config.logLevel, formatters: { level: (label) => ({ level: label }) } },
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await services.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ host: "0.0.0.0", port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
