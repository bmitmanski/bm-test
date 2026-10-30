#!/usr/bin/env bash
# Runs on the VPS, called by the Deploy workflow: deploy.sh <image>
set -euo pipefail
cd /opt/app

IMAGE="$1"
PREVIOUS=$(grep -E '^APP_IMAGE=' .env | cut -d= -f2- || true)

# Persist the image in .env so a manual `docker compose up` keeps the same version.
if grep -q '^APP_IMAGE=' .env; then
  sed -i "s|^APP_IMAGE=.*|APP_IMAGE=${IMAGE}|" .env
else
  echo "APP_IMAGE=${IMAGE}" >> .env
fi

docker compose pull --quiet
docker compose up -d --remove-orphans

echo "Waiting for app to become healthy..."
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")
  [ "$status" = healthy ] && break
  sleep 2
done

if [ "$status" != healthy ]; then
  echo "App unhealthy, rolling back to ${PREVIOUS:-<none>}"
  docker compose logs --tail 50 app
  if [ -n "$PREVIOUS" ]; then
    sed -i "s|^APP_IMAGE=.*|APP_IMAGE=${PREVIOUS}|" .env
    docker compose up -d app
  fi
  exit 1
fi

docker image prune -f >/dev/null
echo "Deployed ${IMAGE}"
