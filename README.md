# bm-test: owning the full stack, A to Z

A small app (Fastify API + Vite frontend, TypeScript) with all the infrastructure around it: domain → VM → GitHub Actions (checks + deploy) → Postgres, Redis, S3 storage → logs, metrics and alerts in Grafana, errors in Sentry.

| Environment | URL | |
|---|---|---|
| **Production** | https://bm-test.duckdns.org | deployed after e2e on staging + manual approval; test-failure buttons off |
| **Staging** | https://staging.bm-test.duckdns.org | every push to `main`; test-failure buttons on |
| Grafana | https://grafana.bm-test.duckdns.org | both environments (Environment dropdown on the dashboard); basic auth + Grafana login |

Health: `/api/health` (version = commit SHA), `/api/ready` (DB, Redis, S3).

```
                 GitHub (push to main)
                        │
        ┌───────────────┴────────────────┐
        │  CI: typecheck, tests,         │
        │  compose/Caddy/Alloy checks    │
        │  build images → GHCR           │
        │  deploy → staging → e2e tests  │
        │  same images → production      │
        └───────────────┬────────────────┘
                        ▼
  DNS  ──►  VM (Docker Compose, /opt/app)
  your.domain    │
                 ├─ caddy      :80/:443, HTTPS; / → web, /api/* → app
                 ├─ web        SPA (Vite) with buttons that trigger test failures
                 ├─ app        Node 24 (Fastify), JSON logs, /metrics
                 ├─ postgres   18
                 ├─ redis      8 (password, AOF)
                 ├─ s3         SeaweedFS (S3-compatible)
                 ├─ alloy ──►  loki + prometheus ──► grafana (dashboard, alerts)
                 ├─ cron: backup.sh (pg_dump)
                 └─ staging    app, web, postgres, redis, s3 (compose.staging.yml)
                               staging.your.domain, behind the same caddy, logs in the same Grafana

  Sentry (SaaS) ◄── exceptions + traces from browser and API
```

> Step-by-step setup on GCP: [docs/SETUP-GCP.md](docs/SETUP-GCP.md)
> Logs, metrics, alerts, Grafana, Sentry and test scenarios: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)

## Where to host it for free

| Layer | Free option | Notes |
|---|---|---|
| **VM** | **GCP Free Trial**: 300 $ for 90 days | What this repo targets. An e2-medium costs ~35 $/month, so the credit covers the whole trial. Use a private Google account, not a company project. |
| | **Oracle Cloud Always Free**: ARM, up to 4 vCPU / 24 GB RAM | The only VM that is free forever and big enough. Requires a card; popular regions are often out of ARM capacity. |
| | AWS Free Plan (~200 $ credits for 6 months) | Most common at clients. |
| | Paid but cheap: Hetzner, ~4–5 €/month | Fewest surprises. |
| **Domain** | DuckDNS (`you.duckdns.org`, wildcard works, so `grafana.you.duckdns.org` too) | A real domain costs ~10 $/year (Cloudflare Registrar, Porkbun). |
| **DNS** | Cloudflare (free) | With a real domain. |
| **CI/CD** | GitHub Actions | Public repos: unlimited; private: 2000 min/month. |
| **Registry** | GitHub Container Registry (GHCR) | |
| **DB, Redis, storage, logs** | Self-hosted on the VM (this compose file) | That is the point of owning the stack. Managed alternatives: Neon (Postgres), Upstash (Redis), Cloudflare R2 (S3), Grafana Cloud. |

## Local development

**Day-to-day (hot reload):** Postgres, Redis and S3 run in Docker; the API and frontend run on your machine.

```bash
npm ci && npm ci --prefix web
npm run deps:up      # Postgres, Redis, S3 in Docker (ports 5432, 6379, 8333)
npm run dev          # API on :3000, restarts on save, readable logs (pino-pretty)
npm run dev:web      # second terminal: UI on http://localhost:5173, /api proxied to :3000
```

The API reads its config from `.env.development`. That file is committed because it only holds local passwords matching `.env.example`.

**The full production-like stack** (Caddy, HTTPS, Grafana, Prometheus, Loki):

```bash
npm run stack:up     # builds the images and starts everything
curl -k https://localhost/api/ready   # {"db":"ok","redis":"ok","storage":"ok"}
npm run stack:down   # stops it (volumes are kept; `down -v` deletes them)
```

UI: `https://localhost` (accept the local certificate). Grafana: `https://grafana.localhost` (admin / `change-me`).

`deps:up` and `stack:up` share the same Postgres, Redis and S3 containers, so you can mix them.

Tests: `npm test`.

## Endpoints

Public under `/api/...` (Caddy strips the prefix). `/metrics` is reachable only from the internal Docker network.

| | |
|---|---|
| `GET /health` | liveness (Docker healthcheck) |
| `GET /ready` | do DB, Redis and S3 respond |
| `POST /visits` | Redis counter + Postgres row |
| `POST /files` | upload (multipart, max 10 MB) → S3 |
| `GET /files/:key` | download a file |
| `POST /client-errors` | browser JS errors → logs and metrics |
| `GET /metrics` | Prometheus metrics (internal only) |
| `/debug/*` | test failures, only with `DEBUG_ROUTES=true` |

## Deploy and rollback

```
push to main → checks → build images once (GHCR, tag = commit SHA)
             → staging     deploy.sh + smoke test      https://staging.<domain>
             → e2e         test/e2e/*.e2e.ts against staging: version, Postgres, Redis, S3 upload/download, routing
             → approval    a human clicks Approve (GitHub environment protection)
             → production  the same images, deploy.sh + smoke test
```

- **Staging** runs on the same VM as a second compose project (`infra/compose.staging.yml`, env file `/opt/app/.env.staging`): its own database, Redis and S3, `DEBUG_ROUTES=true`, `environment: staging` in Sentry and `env="staging"` in Loki. The production Caddy routes `staging.<domain>` to it over a shared Docker network (`edge`).
- **Shared infra** (Caddy, Loki, Prometheus, Alloy, Grafana) has one instance; it is updated in the staging step (`deploy.sh shared`).
- If the new containers are not healthy, `deploy.sh` rolls back to the previous images on its own.
- E2E locally: `BASE_URL=https://staging.<domain> npm run test:e2e`.
- **Manual approval before production**: the `production` environment has a required reviewer, so after e2e the run waits for *Review deployments → Approve* (also for rollbacks). Free on public repos; private repos need GitHub Pro/Team.

Manual rollback: Actions → **Deploy** → *Run workflow* → `image_tag` = SHA of an older commit (no rebuild).

## Not here yet (the next big steps)

- **Off-site backups**: `backup.sh` writes to the same disk. Add disk snapshots, or copy dumps to a bucket, and test a restore.
- **DB migrations**: today `CREATE TABLE IF NOT EXISTS` at startup. Use a tool (drizzle-kit, node-pg-migrate) as a deploy step.
- **Secrets management**: `.env` is edited by hand on the server. Next: SOPS + age in the repo, or Infisical/Doppler.
- **Infrastructure as Code**: the VM and DNS are clicked together. OpenTofu/Terraform, and Ansible instead of `bootstrap-vps.sh`.
- **Staging isolation**: staging shares the VM, Caddy and Grafana with production. Client projects usually give it its own VM or cloud project, so OS/firewall/Docker changes can be tried there first.
- **Zero-downtime deploys**: `up -d` restarts the container (a few seconds of downtime). Fix: two replicas behind Caddy, or blue/green.
- **Security**: Dependabot/Renovate, image scanning (Trivy), rate limiting. Grafana has basic auth + its own login; SSO (Cloudflare Access, IAP) would be stronger.
- **Keyless deploys**: Workload Identity Federation + IAP instead of an SSH key in GitHub secrets.
