# bm-test: owning the full stack, A to Z

A small app (Fastify API + Vite frontend, TypeScript) with all the infrastructure around it: domain → VM → GitHub Actions (checks + deploy) → Postgres, Redis, S3 storage → logs, metrics and alerts in Grafana.

```
                 GitHub (push to main)
                        │
        ┌───────────────┴────────────────┐
        │  CI: typecheck, tests,         │
        │  compose/Caddy/Alloy checks    │
        │  build images → GHCR           │
        │  ssh → deploy.sh → smoke test  │
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
                 └─ cron: backup.sh (pg_dump)
```

> Step-by-step setup on GCP: [docs/SETUP-GCP.md](docs/SETUP-GCP.md)
> Logs, metrics, alerts, Grafana and test scenarios: [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md)

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

Push to `main` → checks → images in GHCR → `deploy.sh` on the VM → smoke test of `/api/ready`.
If the new containers are not healthy, `deploy.sh` rolls back to the previous images on its own.

Manual rollback: Actions → **Deploy** → *Run workflow* → `image_tag` = SHA of an older commit (no rebuild).

## Not here yet (the next big steps)

- **Off-site backups**: `backup.sh` writes to the same disk. Add disk snapshots, or copy dumps to a bucket, and test a restore.
- **Sentry**: error grouping, user context, source maps (today there is only `/api/client-errors`).
- **DB migrations**: today `CREATE TABLE IF NOT EXISTS` at startup. Use a tool (drizzle-kit, node-pg-migrate) as a deploy step.
- **Secrets management**: `.env` is edited by hand on the server. Next: SOPS + age in the repo, or Infisical/Doppler.
- **Infrastructure as Code**: the VM and DNS are clicked together. OpenTofu/Terraform, and Ansible instead of `bootstrap-vps.sh`.
- **Staging**: a second GitHub environment and a separate compose project/subdomain.
- **Zero-downtime deploys**: `up -d` restarts the container (a few seconds of downtime). Fix: two replicas behind Caddy, or blue/green.
- **Security**: Grafana is public behind a password only. Add `basic_auth`/an IP allowlist in Caddy. Dependabot/Renovate, image scanning (Trivy), rate limiting.
- **Keyless deploys**: Workload Identity Federation + IAP instead of an SSH key in GitHub secrets.
