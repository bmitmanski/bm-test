# GCP setup (Compute Engine), step by step

Target: one e2-medium VM (Ubuntu x86/64) in `europe-central2` running the whole stack from `infra/compose.yml`, deployed from GitHub Actions.

> ⚠️ Use a **private** Google account with the Free Trial (300 $ / 90 days), not a company project or a `@selleo.com` account.

Run the commands locally (WSL), from the repo root. Keep the variables in `.env.setup` (it is in `.gitignore`):

```bash
# .env.setup
PROJECT=          # PROJECT_ID from `gcloud projects list` (not the project name!)
VM=bm-test-instance-1
ZONE=europe-central2-a
IP=<static external IP>
DOMAIN=<subdomain>.duckdns.org
ACME_EMAIL=          # your e-mail (Let's Encrypt account)
```

Load them in every new terminal:

```bash
set -a; source .env.setup; set +a
```

## 1. Account and project

- Activate the Free Trial on a private Google account (a card is required) and create a new project.
- Billing → Budgets & alerts → a budget of e.g. 50 $ with an e-mail alert, so you see how fast the credit goes.

## 2. Static IP address

VPC network → IP addresses → **Reserve external static IP address**, region `europe-central2`.

After creating the VM (step 3), **attach the IP to it**: VM instances → your VM → Edit → Network interfaces → `nic0` → External IPv4 address → pick the reserved address → Save.
In the IP addresses table, the *In use by* column must show the VM, not `None`. An unattached static IP is billed, and an *Ephemeral* one can change.
Use this address everywhere (DNS, `.env.setup`, secrets). The internal `10.x.x.x` address is not needed anywhere.

## 3. Virtual machine

Compute Engine → Create instance:

- Machine type: **e2-medium** (2 vCPU, 4 GB RAM)
- Boot disk: **Ubuntu 26.04 LTS x86/64** (`amd64`, **not** Arm64), 50 GB, Balanced persistent disk
  - if the Docker installer does not support 26.04, recreate the VM with **24.04 LTS x86/64**
- Networking: attach the reserved static IP
- Firewall: tick **Allow HTTP traffic** and **Allow HTTPS traffic** (optionally add a UDP 443 rule for HTTP/3)

## 4. Server

**4.1. gcloud CLI** (if you don't have it). Log in with the private account and pick the trial project:

```bash
curl -sSL https://sdk.cloud.google.com | bash && exec -l $SHELL
gcloud init
```

Make sure gcloud points at your project. Project IDs are globally unique and often differ from the name (e.g. `bm-test-123456`). With the wrong ID you get `PERMISSION_DENIED ... compute.googleapis.com`:

```bash
gcloud projects list                  # PROJECT_ID column
gcloud config set project $PROJECT
gcloud compute instances list         # must show your VM
```

**4.2. Deploy key for GitHub Actions:**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/bm-test-deploy -N "" -C github-actions-deploy
```

**4.3. Bootstrap** (Docker, `deploy` user, ufw, fail2ban, key-only SSH, automatic security updates):

```bash
gcloud compute scp infra/scripts/bootstrap-vps.sh ~/.ssh/bm-test-deploy.pub $VM:~ --zone=$ZONE
gcloud compute ssh $VM --zone=$ZONE -- 'sudo bash ~/bootstrap-vps.sh "$(cat ~/bm-test-deploy.pub)"'
```

**4.4. Check**: log in as `deploy`, the same way GitHub will:

```bash
ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'docker compose version'
```

## 5. Domain (before `.env`)

### Option A: DuckDNS (free)

1. https://www.duckdns.org → log in (GitHub/Google).
2. *sub domain* → e.g. `bm-test` → **add domain**.
3. *current ip* → the static IP → **update ip**.

Or with one request (pass `ip` explicitly, otherwise DuckDNS uses the IP of the machine sending the request):

```bash
curl "https://www.duckdns.org/update?domains=bm-test&token=<YOUR_TOKEN>&ip=$IP&verbose=true"
```

Subdomains (`grafana.bm-test.duckdns.org`) work automatically (wildcard). You don't need DuckDNS's IP-update cron because the IP is static. DuckDNS does not support CAA records; skip that.

### Option B: your own domain

At the registrar or in Cloudflare (**DNS only** mode, grey cloud):

| Type | Name | Value |
|---|---|---|
| A | `@` | `<IP>` |
| A | `grafana` | `<IP>` |
| CAA | `@` | `0 issue "letsencrypt.org"` |

Check: both commands must return your IP, otherwise Caddy can't get a certificate:

```bash
dig +short $DOMAIN; dig +short grafana.$DOMAIN
```

## 6. Secrets on the server

Passwords are generated locally and only ever land on the server:

```bash
ssh -i ~/.ssh/bm-test-deploy deploy@$IP "cat > /opt/app/.env" <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
POSTGRES_USER=app
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=app
REDIS_PASSWORD=$(openssl rand -hex 24)
S3_BUCKET=uploads
S3_ACCESS_KEY=$(openssl rand -hex 12)
S3_SECRET_KEY=$(openssl rand -hex 24)
GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 16)
LOG_LEVEL=info
DEBUG_ROUTES=false
ALERT_EMAIL=$ACME_EMAIL
# SMTP for alert e-mails, see docs/OBSERVABILITY.md (optional, alerts work in the UI without it)
SMTP_ENABLED=false
EOF
ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'chmod 600 /opt/app/.env && grep GRAFANA /opt/app/.env'
```

**Basic auth in front of Grafana** (a second lock before Grafana's own login; user `admin`). Only the bcrypt hash goes to the server, the password stays in your `.env.setup`:

```bash
PW=$(openssl rand -hex 12) && echo "GRAFANA_BASIC_AUTH_PASSWORD=$PW" >> .env.setup
HASH=$(docker run --rm caddy:2.11-alpine caddy hash-password --plaintext "$PW")
# Single quotes keep the $ signs of the hash literal for Docker Compose.
printf "GRAFANA_BASIC_AUTH_HASH='%s'\n" "$HASH" | ssh -i ~/.ssh/bm-test-deploy deploy@$IP "cat >> /opt/app/.env"
```

`DEBUG_ROUTES=false`: the endpoints that deliberately fail (`/debug/*`, the *Test failures* buttons) must not be public in production, anyone could crash the API. Turn them on only temporarily, for a demo.

Save the Grafana password. Run this **once**: Grafana only applies `GRAFANA_ADMIN_PASSWORD` on its very first start. If you change it later, reset it in Grafana:

```bash
ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'cd /opt/app && set -a && . ./.env && set +a \
  && docker compose exec -T grafana grafana cli admin reset-admin-password "$GRAFANA_ADMIN_PASSWORD"'
```

**Changing variables later** (run locally; it backs up the old file to `/opt/app/.env.bak`):

```bash
infra/scripts/server-env.sh ALERT_EMAIL=you@gmail.com                             # only edit .env
infra/scripts/server-env.sh --apply SMTP_ENABLED=true SMTP_PASSWORD=xxxx          # edit + recreate changed containers
infra/scripts/server-env.sh --list                                                # variable names, values hidden
```

Without `--apply`, the change takes effect on the next deploy (it runs `docker compose up -d`).

## 7. GitHub

> Order matters: **secrets first, then push to `main`**. Otherwise the first deploy fails.

`gh` must be recent (≥ 2.31 for `gh variable`). The Ubuntu package is too old; install from https://cli.github.com, then `gh auth login`.

**7.1. Repo:**

```bash
gh repo create bm-test --private --source=. --remote=origin
```

**7.2. `production` environment and secrets:**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api -X PUT repos/$REPO/environments/production
gh secret set VPS_HOST        --env production --body "$IP"
gh secret set VPS_USER        --env production --body "deploy"
gh secret set VPS_SSH_KEY     --env production < ~/.ssh/bm-test-deploy
gh secret set VPS_KNOWN_HOSTS --env production --body "$(ssh-keyscan -t ed25519 $IP 2>/dev/null)"
gh variable set DOMAIN        --env production --body "$DOMAIN"
```

Manual approval before production (required reviewers; free on public repos, private ones need GitHub Pro/Team):

```bash
gh api -X PUT repos/$REPO/environments/production --input - <<EOF
{"reviewers":[{"type":"User","id":$(gh api user -q .id)}],"prevent_self_review":false,
 "deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}
EOF
```

Optional: Settings → Branches → protect `main` with the CI check required.

**7.3. First commit and push** (deploys run from `main`):

```bash
git branch -M main
git add -A && git commit -m "Initial app with full infra and CI/CD"
git push -u origin main
gh run watch
```

**7.4. Staging** (same VM, `https://staging.$DOMAIN`; DuckDNS covers subdomains, nothing to do in DNS). The pipeline deploys to staging first, runs e2e tests against it, and only then deploys the same images to production.

Env file on the server, with its own passwords (generated on the server, they never leave it):

```bash
ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'bash -s' <<'REMOTE'
cd /opt/app && [ ! -e .env.staging ] && umask 077 && cat > .env.staging <<EOF
POSTGRES_USER=app
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=app
REDIS_PASSWORD=$(openssl rand -hex 16)
S3_BUCKET=uploads
S3_ACCESS_KEY=$(openssl rand -hex 12)
S3_SECRET_KEY=$(openssl rand -hex 24)
SENTRY_DSN=<the API DSN, same as production; events are tagged environment=staging>
LOG_LEVEL=info
DEBUG_ROUTES=true
EOF
REMOTE
```

GitHub environment `staging`: the same VM, so the same secrets; `DOMAIN` is the environment's public host:

```bash
gh api -X PUT repos/$REPO/environments/staging
gh secret set VPS_HOST        --env staging --body "$IP"
gh secret set VPS_USER        --env staging --body "deploy"
gh secret set VPS_SSH_KEY     --env staging < ~/.ssh/bm-test-deploy
gh secret set VPS_KNOWN_HOSTS --env staging --body "$(ssh-keyscan -t ed25519 $IP 2>/dev/null)"
gh variable set DOMAIN        --env staging --body "staging.$DOMAIN"
```

Change staging variables with `infra/scripts/server-env.sh --staging --apply KEY=value`.

## 8. Verify

```bash
curl https://$DOMAIN/api/ready     # {"db":"ok","redis":"ok","storage":"ok"}
```

- Frontend: `https://$DOMAIN`
- Grafana: `https://grafana.$DOMAIN` (user `admin`) → Dashboards → bm-test → **bm-test · app**. More in [OBSERVABILITY.md](OBSERVABILITY.md)
- No certificate? Check Caddy's logs. Usually DNS doesn't point at the server yet, or there is no firewall rule for port 80:

  ```bash
  ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'cd /opt/app && docker compose logs caddy --tail 30'
  ```

**Backup cron job** (daily at 03:00 server time, UTC):

```bash
ssh -i ~/.ssh/bm-test-deploy deploy@$IP '(crontab -l 2>/dev/null; echo "0 3 * * * /opt/app/scripts/backup.sh >> /opt/backups/backup.log 2>&1") | crontab -'
```

`backup.sh` dumps Postgres to `/opt/backups/pg-YYYY-MM-DD.sql.gz` and keeps 7 days. That is on the same disk, so also set up **disk snapshots**: Compute Engine → Snapshots → *Create snapshot schedule* (daily, keep 7 days) and attach it to the VM's disk. Snapshots cover everything (S3 files, Redis, Grafana) and live outside the VM.

Restore a dump:

```bash
cd /opt/app && gunzip -c /opt/backups/pg-2026-11-02.sql.gz | docker compose exec -T postgres psql -U app app
```

## 9. Uptime monitoring

GCP → Monitoring → Uptime checks → Create:

- HTTPS, host `$DOMAIN`, path **`/api/ready`** (not `/ready`, which now returns the frontend page with a 200), every 1 min
- create an alert with an e-mail notification in the same wizard

Test: `docker compose stop app` on the server → did the e-mail arrive? Then `docker compose start app`.

## 10. Sentry (bug tracker)

Until this step is done, Sentry is simply off: the SDKs are no-ops and CI skips the upload and release steps.

**10.1. Account and projects** at https://sentry.io (free Developer plan):

- Create an organization. Its **slug** is in the URL: `https://<org-slug>.sentry.io`.
- Create project **bm-test-api**, platform *Node.js*.
- Create project **bm-test-web**, platform *Browser JavaScript*.
- For each project, copy its **DSN** from Project settings → Client Keys (DSN).

**10.2. Auth token** for source map upload and releases: Settings → Developer Settings → **Organization Tokens** → Create. Copy it now; it is shown only once.

**10.3. GitHub** (repo-level, because the build job runs outside the `production` environment):

```bash
gh secret set SENTRY_AUTH_TOKEN      --body "<org auth token>"
gh variable set SENTRY_ORG           --body "<org-slug>"
gh variable set SENTRY_PROJECT_API   --body "bm-test-api"
gh variable set SENTRY_PROJECT_WEB   --body "bm-test-web"
gh variable set SENTRY_DSN_WEB       --body "<DSN of bm-test-web>"
```

The frontend DSN is public by design (it ends up in the JS bundle), so a variable is fine. Only the auth token is a secret.

**10.4. Server**: the API DSN goes into `/opt/app/.env`. Without `--apply` the next deploy picks it up:

```bash
infra/scripts/server-env.sh SENTRY_DSN="<DSN of bm-test-api>"
```

**10.5. Deploy and test**: push to `main`, then click the test-failure buttons and open Sentry → **Issues**.
Browser events go through `/sentry-tunnel` on your own domain, so ad blockers don't drop them.

## Rollback

Actions → **Deploy** → *Run workflow* → `image_tag` = SHA of an older commit (no image rebuild). This goes straight to production, skipping staging and e2e.
`deploy.sh` rolls back to the previous images on its own if the new ones fail the healthcheck.

## Next (TODO)

- [x] Frontend (SPA) behind Caddy, API under `/api` (same domain, no CORS)
- [x] Metrics (Prometheus) + dashboard + alerts in Grafana, see [OBSERVABILITY.md](OBSERVABILITY.md)
- [x] Sentry (API + frontend, release = SHA, source maps from CI), see step 10
- [x] Protect Grafana (basic auth)
- [x] Staging on the same VM, e2e tests against it before production
- [ ] Deploy via Workload Identity Federation + IAP (port 22 closed, no SSH key in secrets)
- [ ] DB migrations in the pipeline
- [ ] Off-site backups + a tested restore
