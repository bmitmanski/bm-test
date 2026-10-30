# Setup na GCP (Compute Engine) — krok po kroku

Docelowo: jedna maszyna e2-medium (Ubuntu x86/64) w `europe-central2`, na niej cały stack z `infra/compose.yml`, deploy z GitHub Actions.

> ⚠️ Używaj **prywatnego** konta Google z Free Trial (300 $ / 90 dni), nie firmowego projektu ani konta `@selleo.com`.

Komendy uruchamiasz lokalnie (WSL), w katalogu repo. Zmienne trzymasz w `.env.setup` (jest w `.gitignore`):

```bash
# .env.setup
PROJECT=          # PROJECT_ID z `gcloud projects list` (to nie to samo co nazwa projektu!)
VM=bm-test-instance-1
ZONE=europe-central2-a
IP=<statyczny zewnętrzny IP>
DOMAIN=<subdomena>.duckdns.org
ACME_EMAIL=          # twój e-mail (powiadomienia Let's Encrypt)
```

W każdym nowym terminalu wczytaj je:

```bash
set -a; source .env.setup; set +a
```

## 1. Konto i projekt

- Aktywuj Free Trial na prywatnym koncie Google (wymaga karty), utwórz nowy projekt.
- Billing → Budgets & alerts → budżet np. 50 $ z alertem e-mail (żeby widzieć, ile kredytu schodzi).

## 2. Statyczny adres IP

VPC network → IP addresses → **Reserve external static IP address**, region `europe-central2`.

Po utworzeniu maszyny (krok 3) **przypnij go do niej**: VM instances → maszyna → Edit → Network interfaces → `nic0` → External IPv4 address → wybierz zarezerwowany adres → Save.
W tabeli IP addresses kolumna *In use by* musi pokazywać maszynę, a nie `None` (nieprzypięty statyczny IP jest płatny, a tymczasowy *Ephemeral* może się zmienić).
Ten adres wpisujesz wszędzie (DNS, `.env.setup`, sekrety). Adres wewnętrzny `10.x.x.x` nie jest nigdzie potrzebny.

## 3. Maszyna wirtualna

Compute Engine → Create instance:

- Machine type: **e2-medium** (2 vCPU, 4 GB RAM)
- Boot disk: **Ubuntu 26.04 LTS x86/64** (`amd64`, **nie** Arm64), 50 GB, Balanced persistent disk
  - jeśli instalator Dockera nie wspiera 26.04 → odtwórz na **24.04 LTS x86/64**
- Networking: przypisz zarezerwowany statyczny IP
- Firewall: zaznacz **Allow HTTP traffic** i **Allow HTTPS traffic** (opcjonalnie dodaj regułę UDP 443 dla HTTP/3)

## 4. Serwer

**4.1. gcloud CLI** (jeśli nie masz) — zaloguj się prywatnym kontem i wybierz projekt z triala:

```bash
curl -sSL https://sdk.cloud.google.com | bash && exec -l $SHELL
gcloud init
```

Upewnij się, że gcloud wskazuje Twój projekt. ID projektu jest globalnie unikalne i często różni się od nazwy (np. `bm-test-123456`). Przy złym ID dostaniesz `PERMISSION_DENIED ... compute.googleapis.com`:

```bash
gcloud projects list                  # kolumna PROJECT_ID
gcloud config set project $PROJECT
gcloud compute instances list         # musi pokazać Twoją maszynę
```

**4.2. Klucz deployowy dla GitHub Actions:**

```bash
ssh-keygen -t ed25519 -f ~/.ssh/bm-test-deploy -N "" -C github-actions-deploy
```

**4.3. Bootstrap** (Docker, użytkownik `deploy`, ufw, fail2ban, SSH tylko na klucze, automatyczne aktualizacje):

```bash
gcloud compute scp infra/scripts/bootstrap-vps.sh ~/.ssh/bm-test-deploy.pub $VM:~ --zone=$ZONE
gcloud compute ssh $VM --zone=$ZONE -- 'sudo bash ~/bootstrap-vps.sh "$(cat ~/bm-test-deploy.pub)"'
```

**4.4. Sprawdzenie** — logowanie jako `deploy`, tak jak zrobi to GitHub:

```bash
ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'docker compose version'
```

## 5. Domena (przed `.env`)

### Wariant A: DuckDNS (za darmo)

1. https://www.duckdns.org → zaloguj się (GitHub/Google).
2. *sub domain* → np. `bm-test` → **add domain**.
3. *current ip* → statyczny IP → **update ip**.

Poddomeny (`grafana.bm-test.duckdns.org`, `api.…`) działają automatycznie (wildcard). Skrypt aktualizujący IP z instrukcji DuckDNS nie jest potrzebny, bo IP jest statyczne. DuckDNS nie obsługuje rekordu CAA — pomiń go.

### Wariant B: własna domena

U rejestratora lub w Cloudflare (tryb **DNS only**, szara chmurka):

| Typ | Nazwa | Wartość |
|---|---|---|
| A | `@` | `<IP>` |
| A | `grafana` | `<IP>` |
| A | `api` | `<IP>` (pod przyszły podział frontend/API) |
| CAA | `@` | `0 issue "letsencrypt.org"` |

Sprawdź — obie komendy muszą zwrócić Twoje IP, inaczej Caddy nie dostanie certyfikatu:

```bash
dig +short $DOMAIN; dig +short grafana.$DOMAIN
```

## 6. Sekrety na serwerze

Hasła generują się lokalnie i trafiają tylko na serwer:

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
EOF
ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'chmod 600 /opt/app/.env && grep GRAFANA /opt/app/.env'
```

Zapisz hasło do Grafany.

## 7. GitHub

> Kolejność: **najpierw sekrety, potem push na `main`** — inaczej pierwszy deploy się wysypie.

**7.1. Repo:**

```bash
gh repo create bm-test --private --source=. --remote=origin
```

**7.2. Environment `production` i sekrety:**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api -X PUT repos/$REPO/environments/production
gh secret set VPS_HOST        --env production --body "$IP"
gh secret set VPS_USER        --env production --body "deploy"
gh secret set VPS_SSH_KEY     --env production < ~/.ssh/bm-test-deploy
gh secret set VPS_KNOWN_HOSTS --env production --body "$(ssh-keyscan -t ed25519 $IP 2>/dev/null)"
gh variable set DOMAIN        --env production --body "$DOMAIN"
```

Opcjonalnie: Settings → Environments → production → *Required reviewers* (ręczna akceptacja deployu) oraz Settings → Branches → ochrona `main` z wymaganym checkiem CI.

**7.3. Pierwszy commit i push** (deploy odpala się z `main`):

```bash
git branch -M main
git add -A && git commit -m "Initial app with full infra and CI/CD"
git push -u origin main
gh run watch
```

## 8. Weryfikacja

```bash
curl https://$DOMAIN/ready     # {"db":"ok","redis":"ok","storage":"ok"}
```

- Grafana: `https://grafana.$DOMAIN` (login `admin`) → Explore → Loki → `{service="app"}`
- Brak certyfikatu? Sprawdź logi Caddy (najczęściej: DNS jeszcze nie wskazuje na serwer albo brak reguły firewalla na port 80):

  ```bash
  ssh -i ~/.ssh/bm-test-deploy deploy@$IP 'cd /opt/app && docker compose logs caddy --tail 30'
  ```

**Backup do crona:**

```bash
ssh -i ~/.ssh/bm-test-deploy deploy@$IP '(crontab -l 2>/dev/null; echo "0 3 * * * /opt/app/scripts/backup.sh >> /opt/backups/backup.log 2>&1") | crontab -'
```

## 9. Monitoring dostępności

GCP → Monitoring → Uptime checks → Create:

- HTTPS, host `$DOMAIN`, ścieżka `/ready`, co 1 min
- w kreatorze utwórz alert z powiadomieniem na e-mail

Test: `docker compose stop app` na serwerze → czy przyszedł mail? Potem `docker compose start app`.

## Rollback

Actions → **Deploy** → *Run workflow* → `image_tag` = SHA starszego commita (bez przebudowy obrazu).
`deploy.sh` sam wraca do poprzedniego obrazu, jeśli nowy nie przejdzie healthchecka.

## Dalej (TODO)

- [ ] Frontend (SPA) za Caddy, podział `domena` / `api.domena`
- [ ] Sentry (API + frontend, release = SHA, source mapy z CI)
- [ ] Alerty z logów w Grafanie (wzrost błędów) → e-mail/Slack
- [ ] Ochrona Grafany (basic auth / allowlista IP)
- [ ] Deploy przez Workload Identity Federation + IAP (zamknięty port 22, bez kluczy SSH w sekretach)
- [ ] Migracje DB w pipeline, testy integracyjne w CI
- [ ] Backup poza serwer + przetestowany restore
