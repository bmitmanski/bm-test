#!/usr/bin/env bash
# Daily Postgres dump. Cron on the VPS: 0 3 * * * /opt/app/scripts/backup.sh
# TODO: also push dumps off the server (Backblaze B2 / Cloudflare R2 via rclone) — a backup on the same disk is not a backup.
set -euo pipefail
cd /opt/app
set -a; source .env; set +a

DIR=/opt/backups
mkdir -p "$DIR"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > "$DIR/pg-$(date +%F).sql.gz"
find "$DIR" -name 'pg-*.sql.gz' -mtime +7 -delete
