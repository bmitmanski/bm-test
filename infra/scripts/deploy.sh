#!/usr/bin/env bash
# Runs on the VPS, called by the Deploy workflow (.github/workflows/deploy-env.yml):
#   deploy.sh shared                                   edge proxy + observability, one instance for all environments
#   deploy.sh <staging|production> <app image> <web image>
set -euo pipefail
cd /opt/app

if [ "${1:-}" = shared ]; then
  SHARED=(caddy loki prometheus alloy grafana)
  # --no-deps: never touches production's app/web. Also creates the "edge" network on the first run.
  docker compose up -d --no-deps "${SHARED[@]}"

  # `up -d` only recreates containers whose compose definition changed, not the files they mount
  # (and rsync replaces files, so single-file bind mounts keep the old inode). Recreate config-driven
  # services whenever their config files change.
  CONFIG_HASH=$(find caddy alloy loki grafana -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
  if [ "$CONFIG_HASH" != "$(cat .config-hash 2>/dev/null)" ]; then
    echo "Config files changed, recreating caddy, alloy, loki, grafana"
    docker compose up -d --no-deps --force-recreate caddy alloy loki grafana
    echo "$CONFIG_HASH" > .config-hash
  fi
  exit 0
fi

ENV=${1:?usage: deploy.sh shared | deploy.sh <staging|production> <app image> <web image>}
case "$ENV" in
  production) ENV_FILE=.env;         COMPOSE=(docker compose);                                                   SERVICES=(app web) ;;
  staging)    ENV_FILE=.env.staging; COMPOSE=(docker compose -f compose.staging.yml --env-file .env.staging); SERVICES=(staging-app staging-web) ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac
[ -f "$ENV_FILE" ] || { echo "Missing /opt/app/$ENV_FILE (see docs/SETUP-GCP.md)"; exit 1; }

declare -A NEW=([APP_IMAGE]="${2:?app image}" [WEB_IMAGE]="${3:?web image}")
declare -A OLD=()

# Persist images in the env file so a manual `docker compose up` keeps the same version.
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}

for var in "${!NEW[@]}"; do
  OLD[$var]=$(grep -E "^$var=" "$ENV_FILE" | cut -d= -f2- || true)
  set_env "$var" "${NEW[$var]}"
done

"${COMPOSE[@]}" pull --quiet "${SERVICES[@]}"
"${COMPOSE[@]}" up -d --remove-orphans

healthy() {
  local status
  for _ in $(seq 1 30); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$("${COMPOSE[@]}" ps -q "$1")")
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  return 1
}

echo "Waiting for ${SERVICES[*]} ($ENV) to become healthy..."
for svc in "${SERVICES[@]}"; do
  healthy "$svc" && continue
  echo "Deploy unhealthy, rolling back $ENV"
  "${COMPOSE[@]}" logs --tail 50 "${SERVICES[@]}"
  for var in "${!OLD[@]}"; do
    [ -n "${OLD[$var]}" ] && set_env "$var" "${OLD[$var]}"
  done
  "${COMPOSE[@]}" up -d "${SERVICES[@]}"
  exit 1
done

docker image prune -f >/dev/null
echo "Deployed ${NEW[APP_IMAGE]} and ${NEW[WEB_IMAGE]} to $ENV"
