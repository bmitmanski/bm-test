# bm-test — pełny stack od A do Z

Mała aplikacja (Fastify + TypeScript) z całą infrastrukturą: domena → VPS → GitHub Actions (checki + deploy) → Postgres, Redis, storage S3 → logi w Grafanie.

```
                 GitHub (push na main)
                        │
        ┌───────────────┴────────────────┐
        │  CI: typecheck, testy,         │
        │  walidacja compose/Caddy       │
        │  build obrazu → GHCR           │
        │  ssh → deploy.sh → smoke test  │
        └───────────────┬────────────────┘
                        ▼
  DNS  ──►  VPS (Docker Compose, /opt/app)
  twoja.domena   │
                 ├─ caddy      :80/:443, automatyczny HTTPS (Let's Encrypt)
                 ├─ app        Node 24, JSON-owe logi na stdout
                 ├─ postgres   18
                 ├─ redis      8 (hasło, AOF)
                 ├─ s3         SeaweedFS (S3-compatible)
                 ├─ alloy ──►  loki ──► grafana   (grafana.twoja.domena)
                 └─ cron: backup.sh (pg_dump)
```

> Instrukcja krok po kroku dla GCP: [docs/SETUP-GCP.md](docs/SETUP-GCP.md)

## Gdzie za darmo

| Warstwa | Darmowa opcja | Uwagi |
|---|---|---|
| **VPS** | **Oracle Cloud Always Free** — ARM Ampere, do 4 vCPU / 24 GB RAM, 200 GB dysku | Jedyna sensowna opcja „za darmo na zawsze” dla tego stacku. Wymaga karty (weryfikacja). Popularne regiony bywają „out of capacity” – próbuj kilka razy albo wybierz mniej oblegany region (region domowy wybierasz raz). Bezczynne instancje free-tier mogą być odzyskane — przejście na Pay-As-You-Go (dalej 0 zł w limitach) to zdejmuje. |
| | GCP e2-micro (1 GB RAM), AWS/Azure (kredyty na 6–12 mies.) | 1 GB RAM to za mało na Grafanę+Loki; AWS/Azure to tylko okres próbny. |
| | Płatnie, ale tanio: Hetzner ~4–5 €/mies. | Najmniej problemów, jeśli Oracle odpadnie. |
| **Domena** | DuckDNS (`twoja.duckdns.org`, wildcard działa, więc `grafana.twoja.duckdns.org` też) lub `1-2-3-4.sslip.io` | Prawdziwa domena to ~10 $/rok (Cloudflare Registrar/Porkbun, bez marży). GitHub Student Pack daje darmową domenę `.me`. |
| **DNS** | Cloudflare (free) | Przy prawdziwej domenie. |
| **CI/CD** | GitHub Actions | Repo publiczne: bez limitu; prywatne: 2000 min/mies. |
| **Registry** | GitHub Container Registry (GHCR) | |
| **DB, Redis, storage, logi** | Self-hosted na VPS (ten compose) | O to chodzi w „ownowaniu stacku”. Alternatywy managed: Neon/Supabase (PG), Upstash (Redis), Cloudflare R2 (10 GB), Grafana Cloud (logi). |

## Kolejność kroków

1. **Lokalnie** — postaw cały stack u siebie (patrz niżej). Wszystko musi działać zanim dotkniesz serwera.
2. **VPS** — załóż Ubuntu 24.04 (ARM na Oracle). Wygeneruj klucz deployowy:
   `ssh-keygen -t ed25519 -f deploy_key -N ""`
   i odpal jako root: `bash bootstrap-vps.sh "$(cat deploy_key.pub)"`.
   **Oracle:** otwórz porty 80/443 w *Security List* VCN **oraz** w iptables na maszynie (obrazy Oracle mają domyślne reguły REJECT poza 22).
3. **Domena** — rekord A (`@` i `grafana`) → IP VPS. Sprawdź: `dig +short twoja.domena`.
4. **Sekrety na serwerze** — skopiuj `.env.example` do `/opt/app/.env` (właściciel `deploy`), wpisz domenę i mocne hasła (`openssl rand -hex 24`).
5. **GitHub** — Settings → Environments → `production`:
   - secrets: `VPS_HOST`, `VPS_USER` (`deploy`), `VPS_SSH_KEY` (treść `deploy_key`), `VPS_KNOWN_HOSTS` (wynik `ssh-keyscan <ip>`)
   - variables: `DOMAIN`
   - opcjonalnie: required reviewers = ręczna akceptacja deployu.
   Dodaj też branch protection na `main` z wymaganym checkiem CI.
6. **Push na main** → checki → obraz w GHCR → deploy → smoke test `/ready`.
7. **Backup** — na VPS: `crontab -e` → `0 3 * * * /opt/app/scripts/backup.sh`. Przetestuj odtworzenie!
8. **Logi** — `https://grafana.twoja.domena` → Explore → Loki → `{service="app", level="error"}`.

Rollback: Actions → Deploy → *Run workflow* → podaj SHA starszego commita (bez przebudowy). `deploy.sh` sam cofa się do poprzedniego obrazu, jeśli nowy nie przejdzie healthchecka.

## Lokalnie

```bash
npm ci
npm test
docker compose -f infra/compose.yml -f infra/compose.dev.yml --env-file .env.example up -d --build
curl -k https://localhost/ready          # {"db":"ok","redis":"ok","storage":"ok"}
curl -k -XPOST https://localhost/visits  # Postgres + Redis
curl -k -F file=@README.md https://localhost/files   # upload do S3
```

Grafana lokalnie: `https://grafana.localhost` (admin / hasło z `.env.example`).

## Endpointy

| | |
|---|---|
| `GET /health` | liveness (healthcheck Dockera) |
| `GET /ready` | czy DB, Redis i S3 odpowiadają |
| `POST /visits` | licznik w Redis + wiersz w Postgres |
| `POST /files` | upload (multipart, max 10 MB) → S3 |
| `GET /files/:key` | pobranie pliku |

## Czego tu jeszcze nie ma (następne „duże kroki”)

- **Backupy poza serwerem** — `backup.sh` zapisuje na tym samym dysku. Dodaj `rclone` → Backblaze B2 / R2 i backup wolumenu S3. Regularnie testuj restore.
- **Monitoring i alerty** — logi to nie wszystko. Zewnętrzny uptime check (UptimeRobot / healthchecks.io, free), metryki (Alloy umie też Prometheus + node-exporter), alerty z Grafany na maila/Slacka.
- **Migracje DB** — teraz `CREATE TABLE IF NOT EXISTS` przy starcie. Docelowo narzędzie (drizzle-kit, node-pg-migrate) odpalane jako krok deployu.
- **Zarządzanie sekretami** — `.env` ręcznie na serwerze. Następny krok: SOPS + age w repo albo Infisical/Doppler.
- **Infrastructure as Code** — VPS i DNS klikane ręcznie. OpenTofu/Terraform (provider OCI + Cloudflare) i Ansible zamiast `bootstrap-vps.sh`.
- **Staging** — drugi `environment` w GitHubie, osobny compose project/subdomena.
- **Zero-downtime deploy** — `up -d` restartuje kontener (kilka sekund przerwy). Rozwiązanie: dwa repliki za Caddy albo blue/green.
- **Bezpieczeństwo** — Grafana jest publiczna (tylko hasło): dodaj `basic_auth`/IP allowlist w Caddy albo Cloudflare Access. Dependabot/Renovate, skan obrazów (Trivy), rate limiting.
- **Email/SMTP**, **CDN/WAF** (proxy Cloudflare przed VPS) — gdy będą potrzebne.
