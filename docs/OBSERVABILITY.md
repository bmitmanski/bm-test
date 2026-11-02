# Observability: logs, metrics, alerts, errors

```
 browser ──(window.onerror)──┐
                             ▼
 web (SPA) ── /api/* ──► app (Fastify)
                           │  stdout: JSON logs (pino)          /metrics: prom-client
                           ▼                                       ▼
                 Alloy ── docker logs ──► Loki          Alloy ── scrape every 15 s ──► Prometheus
                 Alloy ── /proc, /sys (CPU, RAM, disk) ─────────────────────────────► Prometheus
                                              \                 /
                                               ▼               ▼
                                     Grafana: dashboard + alerts ──► e-mail

 browser + API ── exceptions, traces ──► Sentry (issues, releases, source maps) ──► e-mail
```

| What | Where | Retention |
|---|---|---|
| Logs of every container | Loki | 7 days |
| App and server metrics | Prometheus | 15 days |
| Dashboard, alert rules, e-mail contact point | files in `infra/grafana/` (provisioning) | in the repo |
| Exceptions with stack traces and context | Sentry (SaaS) | 30 days on the free plan |

**Which tool for which question:**

| Question | Tool |
|---|---|
| Is it up? Is it getting slower? How many errors per minute? | Grafana (metrics) |
| What happened around 14:32, across all services? | Grafana (Loki logs) |
| **Which** errors exist, where in the code, how many users, since which release? | **Sentry** |
| Wake me up when something breaks | Grafana alerts (system health) + Sentry alerts (new or regressed errors) |

## What you can do in Grafana

| Area | What it is for | Where |
|---|---|---|
| **Dashboards** | Panels that answer "is it healthy?" at a glance. Graphs, stats, tables, log panels, variables (dropdowns such as `$route`), links between panels | Dashboards |
| **Explore** | Ad-hoc questions: write a LogQL or PromQL query and see the result. Split view puts logs and metrics side by side for the same time range | Explore |
| **Drilldown** | Query-less browsing: pick a service and click through log patterns or metrics without writing queries. Good for "what is even in here?" | Drilldown → Logs / Metrics |
| **Alerting** | Rules (when), contact points (who: e-mail, Slack, Discord…), notification policies (routing by labels), silences (mute during maintenance) | Alerting |
| **Annotations** | Vertical markers on graphs, e.g. "deploy abc123". Answers "did it break after the deploy?" | Dashboard settings, or the HTTP API |
| **Users and access** | Viewer/editor/admin roles, teams, service accounts with API tokens for automation | Administration |
| **Sharing** | Links to a panel at a given time range, snapshots, exported JSON | Share button on any panel |

## First steps

1. `https://grafana.<domain>` → user `admin`, password from `GRAFANA_ADMIN_PASSWORD` in `/opt/app/.env`.
2. **Dashboards → bm-test → bm-test · app**:
   - **Overview**: is the API up, requests/s, 5xx, p95 latency, frontend errors, restarts.
   - **HTTP**: traffic by status, latency per endpoint, 4xx vs 5xx vs frontend, business events.
   - **Node.js runtime and server**: CPU, RAM and disk of the VM, API memory, event loop lag.
   - **Logs**: a **Requests** table (time, method, URL, status, ms; sortable and filterable per column), errors, a business events table and a compact view of all API logs. Expand a log line for every JSON field, e.g. the stack trace.
3. **Drilldown → Logs**: the quickest way to browse logs of any container without writing a query. It parses the JSON, so you can filter by fields (`status`, `url`, `level`) in a few clicks and see recurring log patterns.
4. **Explore**: pick **Loki** or **Prometheus** and try the queries below.
5. **Alerting → Alert rules**: *Normal* = fine, *Pending* = condition true but still within `for`, *Firing* = alert sent.

### Useful queries

Loki (LogQL):

```logql
{service="app", level="error"}                         # API and frontend errors
{service="app"} | json | event="file.uploaded"         # one business event
{service="app"} | json | source="frontend"             # browser errors
{service="app"} | json | msg="request" | ms > 1000     # slow requests (one "request" line per request)
{service="app"} | json | msg="request" | status >= 500 # failed requests
{service="postgres"} |= "ERROR"                        # database errors
{service="caddy"}                                      # reverse proxy logs (certificates!)
sum by (level) (count_over_time({service="app"}[5m]))  # log volume by level
```

Prometheus (PromQL):

```promql
sum by (status_code) (rate(http_requests_total[5m]))                                  # traffic by status
sum(increase(http_errors_total{class="5xx"}[1h]))                                     # 5xx in the last hour
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))  # p95 per endpoint
sum by (event) (increase(app_events_total[1h]))                                       # business events
up{job="app"}                                                                          # is the API scrapeable
```

## How to set Grafana up well

**1. Everything as code.** This is what the repo does: datasources, the dashboard, alert rules and contact points live in `infra/grafana/` and are loaded at startup (provisioning). A new server or a wiped volume gives you the same Grafana, and every change goes through a PR.
- Workflow for dashboards: change the dashboard in the UI → *Edit → Save dashboard → Export → Export as JSON* → replace `infra/grafana/dashboards/app.json` → commit. UI edits that are not exported are lost on restart.
- Alert rules provisioned from files are read-only in the UI. Edit `rules.yml` and redeploy.
- Datasources have fixed `uid`s (`prometheus`, `loki`) so dashboards and rules can reference them.
- At larger scale: the Terraform Grafana provider, or Grafana Cloud.

**2. Dashboards: one screen, top-down.** A good service dashboard follows the **RED** method (Rate, Errors, Duration) for the app and **USE** (Utilization, Saturation, Errors) for the machine:
- top row: a few big numbers that answer "is it OK?" (up, error count, p95);
- below: trends that answer "since when and how much?";
- at the bottom: logs, to answer "why?";
- correct units on every panel (`reqps`, `s`, `bytes`, `percentunit`), sensible thresholds and colours;
- one dashboard per service, not one giant dashboard for everything.

**3. Alerts: few, on symptoms, actionable.**
- Alert on what users feel (down, errors, slow) rather than on every cause (CPU 80%). Exceptions: resources that end in an outage without warning, such as a full disk.
- Every alert must lead to an action. If the answer is "ignore it", delete the alert. Example: there is no alert on 4xx.
- Use `for` (e.g. 1–5 min) so a single spike doesn't page anyone.
- Add a `severity` label and route on it: `critical` → phone/Slack, `warning` → e-mail.
- Put a short summary in each rule and link the dashboard (`dashboardUId`). A runbook link is better still.
- Test the contact point (*Alerting → Contact points → Test*) and silence alerts during planned maintenance.

**4. Labels and cardinality.** Every unique label combination is a separate series stored in Prometheus/Loki. Use bounded values only: route patterns (`/files/:key`), status codes, service names. Never put user IDs, full URLs, file names or request IDs in labels; they belong in the log line.

**5. Security.**
- Strong admin password, sign-up disabled (already set in `compose.yml`).
- Create a separate **Viewer** account for daily use instead of using `admin`.
- Grafana is on the public internet: add `basic_auth` or an IP allowlist in Caddy, or put it behind Cloudflare Access.
- Use a **service account token** (Administration → Service accounts), not the admin password, for automation such as CI.

**6. Ideas for the next step.**
- **Deploy annotations**: the deploy workflow calls the Grafana API (`POST /api/annotations`) with a service account token, and every graph gets a "deploy <sha>" marker.
- **Postgres and Redis metrics**: Alloy has `prometheus.exporter.postgres` and `prometheus.exporter.redis` built in.
- **Tracing** (OpenTelemetry → Tempo) to see where time goes inside a request (DB, Redis, S3).
- **SLOs**: e.g. "99.5% of requests succeed within 500 ms over 30 days", with an error budget instead of per-spike alerts.

## App metrics

| Metric | What it measures |
|---|---|
| `http_requests_total{method,route,status_code}` | every request; `route` is the pattern (`/files/:key`), not the raw URL, to keep the number of series low |
| `http_request_duration_seconds` | latency histogram, used for p50/p95/p99 |
| `http_errors_total{class="4xx"\|"5xx"}` | errors. The counters **start at 0**, so the first error after a restart still triggers an alert. A series created only at the first error is invisible to `increase()` |
| `app_events_total{event}` | business events: `visit.recorded`, `file.uploaded`, `file.downloaded` |
| `frontend_errors_total` | JS errors reported by browsers |
| `process_*`, `nodejs_*` | Node.js runtime: memory, event loop lag, GC, process start time |
| `node_*` | the VM: CPU, RAM, disk, network (Alloy `prometheus.exporter.unix`) |

## Alerts

Rules live in `infra/grafana/provisioning/alerting/rules.yml`. The contact point and notification routing live in `contact-points.yml`.

| Alert | Condition | Severity | Why |
|---|---|---|---|
| API is down | `up{job="app"} < 1` for 1 min | critical | the most important alert: the app is down |
| Server errors (5xx) | any 5xx in 5 min | critical | production usually uses a percentage threshold; this one is sensitive for testing |
| Frontend JS errors | any in 5 min | warning | errors users hit that the server never sees |
| API restarted | `process_start_time_seconds` changed in 10 min | warning | a crash or a deploy |
| Slow API | p95 > 1 s for 1 min | warning | degradation before it turns into errors |
| Disk almost full | > 85% for 5 min | critical | the most common silent failure on a small VM (logs, backups) |
| Low memory | > 90% for 5 min | warning | risk of the kernel's OOM killer stopping processes |
| Errors in Postgres logs | `ERROR` in the logs within 5 min | warning | example of an alert based on **logs** (Loki) rather than metrics |

**There is intentionally no alert on 4xx.** Those are client mistakes, e.g. a bad form. They show up on the dashboard but should not wake anyone up.

### E-mail notifications (SMTP)

Without SMTP, alerts still fire but are only visible in Grafana. To receive e-mails, e.g. via Gmail:

1. The Google account needs 2-step verification enabled.
2. Go to https://myaccount.google.com/apppasswords and create an app password (16 characters).
3. Add to `/opt/app/.env` on the server:

   ```bash
   ALERT_EMAIL=you@gmail.com
   SMTP_ENABLED=true
   SMTP_HOST=smtp.gmail.com:587
   SMTP_USER=you@gmail.com
   SMTP_PASSWORD=<app password without spaces>
   ```

4. Restart Grafana: `cd /opt/app && docker compose up -d grafana`.
5. Test: Alerting → Contact points → `email` → **Test**.

You can use Slack, Discord or Telegram instead of e-mail (Alerting → Contact points). To keep such a change across restarts, add it to `contact-points.yml`.

## Test scenarios (buttons in the UI)

The **Test failures** buttons only work with `DEBUG_ROUTES=true` in `/opt/app/.env`. After changing it, run `docker compose up -d app`.

| Button | Logs (Loki) | Metrics | Alert (after ~1–2 min) |
|---|---|---|---|
| Record a visit / Upload a file | `event="visit.recorded"` / `file.uploaded` | `app_events_total` | — |
| Server error (500) | `level=error` with a stack trace | `http_errors_total{class="5xx"}` | **Server errors (5xx)** |
| Database error (500) | an error in the API **and** `ERROR` in the Postgres logs | 5xx | **5xx** and **Errors in Postgres logs** |
| Validation error (400) | `level=info`, status 400 | `class="4xx"` | none, and that's correct |
| Slow request | `ms` ~2500 on the `request` line | p95 latency goes up | **Slow API**, if clicked a few times |
| JS error / unhandled rejection | `source="frontend"`, `level=error` | `frontend_errors_total` | **Frontend JS errors** |
| Crash the API process | `level=fatal`, then startup logs | `process_start_time_seconds` changes | **API restarted** |

Lessons worth remembering from these tests:

- **Metrics from the last seconds before a crash are lost.** Prometheus scrapes every 15 s and counters live in the process's memory. Logs survive because they go to stdout immediately. That is why you need both.
- **Alerts have latency**: scrape (15 s) + rule evaluation (every 1 min) + `for` + `group_wait` (30 s). Expect the e-mail 1–3 minutes after the event.
- **The very first error right after the API starts** may not be counted if it happens before the first scrape.

## Sentry: reviewing errors

Setup steps: [SETUP-GCP.md, step 10](SETUP-GCP.md#10-sentry-bug-tracker).

What is wired up:

| | API (`@sentry/node`, `src/instrument.ts`) | Frontend (`@sentry/browser`, `web/src/main.ts`) |
|---|---|---|
| Captured | unhandled errors in requests that end in **5xx**, uncaught exceptions (crash), startup failures | uncaught errors, unhandled promise rejections |
| Not captured | 4xx (client mistakes; they are in metrics) | — |
| Release | `APP_VERSION` = commit SHA | the same SHA, baked in at build time |
| Readable stack traces | compiled JS is close to the TS source | **source maps** uploaded from CI, then removed from the image |
| Tracing (20% sample) | Fastify, pg, ioredis spans | page load + `fetch` to `/api`, linked to the API trace |

Off unless a DSN is set: local dev and tests send nothing.

**How to work with it:**

- **Issues**: every distinct error is one issue, with all occurrences grouped by stack trace. Sort by *Events* or *Users* to see what hurts most.
- **Issue page**: the stack trace (with your TypeScript source for the frontend), **breadcrumbs** (clicks, `fetch` calls and console logs just before the error), browser/OS, URL, release, and the linked **trace** (browser request → API → Postgres).
- **Triage**: *Resolve* when fixed. If the error comes back in a later release, Sentry marks it **Regressed** and notifies you. *Archive* (ignore) known noise, *Assign* to a person.
- **Releases**: each deploy creates a release (the *Sentry release* step in `deploy.yml`). An issue shows the release it first appeared in, which answers "which deploy broke this?".
- **Alerts**: each new project gets a default rule that e-mails you on a **new issue**. Add more in Alerts, e.g. "more than 10 events in 1 hour".
- The same button click shows up in Grafana (counts, alerts) **and** in Sentry (the details). Use Grafana to notice, Sentry to understand.
- **Tunnel**: ad blockers block requests to `sentry.io`, so the browser SDK sends to `/sentry-tunnel` on your own domain instead. The web container's Caddy forwards those requests to the `bm-test-web` project only. The target comes from the DSN at build time (`web/Dockerfile`, `web/Caddyfile`).

Free-plan limits: about 5k errors and 10k performance events a month. Lower `tracesSampleRate` if you get close.

## Still missing

- **Sentry: suspect commits**: install the GitHub integration in Sentry, then change `set_commits: skip` to `auto` in `deploy.yml`. Sentry then points at the commit that probably caused an issue.
- **Tracing** (OpenTelemetry → Tempo): how long each step of a request takes (DB, Redis, S3).
- **Grafana protection**: basic auth or an IP allowlist in Caddy.
- **Postgres and Redis metrics**: Alloy has `prometheus.exporter.postgres` and `prometheus.exporter.redis` built in.
