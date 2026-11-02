#!/usr/bin/env bash
# Runs on the VPS, called by the Deploy workflow: deploy.sh <app image> <web image>
set -euo pipefail
cd /opt/app

declare -A NEW=([APP_IMAGE]="$1" [WEB_IMAGE]="$2")
declare -A OLD=()

# Persist images in .env so a manual `docker compose up` keeps the same version.
set_env() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    echo "$1=$2" >> .env
  fi
}

for var in "${!NEW[@]}"; do
  OLD[$var]=$(grep -E "^$var=" .env | cut -d= -f2- || true)
  set_env "$var" "${NEW[$var]}"
done

docker compose pull --quiet
docker compose up -d --remove-orphans

# `up -d` only recreates containers whose compose definition changed, not the files they mount
# (and rsync replaces files, so single-file bind mounts keep the old inode). Recreate config-driven
# services whenever their config files change.
CONFIG_HASH=$(find caddy alloy loki grafana -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
if [ "$CONFIG_HASH" != "$(cat .config-hash 2>/dev/null)" ]; then
  echo "Config files changed, recreating caddy, alloy, loki, grafana"
  docker compose up -d --force-recreate caddy alloy loki grafana
fi

healthy() {
  local status
  for _ in $(seq 1 30); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q "$1")")
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  return 1
}

echo "Waiting for app and web to become healthy..."
if ! healthy app || ! healthy web; then
  echo "Deploy unhealthy, rolling back"
  docker compose logs --tail 50 app web
  for var in "${!OLD[@]}"; do
    [ -n "${OLD[$var]}" ] && set_env "$var" "${OLD[$var]}"
  done
  docker compose up -d app web
  exit 1
fi

echo "$CONFIG_HASH" > .config-hash
docker image prune -f >/dev/null
echo "Deployed ${NEW[APP_IMAGE]} and ${NEW[WEB_IMAGE]}"
