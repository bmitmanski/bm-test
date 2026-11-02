#!/usr/bin/env bash
# Run LOCALLY. Sets variables in /opt/app/.env on the server (adds missing ones, replaces existing ones).
# Reads IP from .env.setup in the repo root.
#
#   infra/scripts/server-env.sh DEBUG_ROUTES=true ALERT_EMAIL=you@gmail.com
#   infra/scripts/server-env.sh --apply SMTP_ENABLED=true   # also recreate containers whose config changed
#   infra/scripts/server-env.sh --list                      # show variable names (values hidden)
set -euo pipefail
cd "$(dirname "$0")/../.."

set -a; source .env.setup; set +a
: "${IP:?IP missing in .env.setup}"
SSH=(ssh -i ~/.ssh/bm-test-deploy "deploy@$IP")

APPLY=false
case "${1:-}" in
  --list) "${SSH[@]}" "cut -d= -f1 /opt/app/.env | grep -v '^#'"; exit ;;
  --apply) APPLY=true; shift ;;
esac
[ $# -gt 0 ] || { sed -n '2,8p' "$0"; exit 1; }

for kv in "$@"; do
  [[ "$kv" == *=* ]] || { echo "Expected KEY=VALUE, got: $kv"; exit 1; }
done

# Values travel as arguments to `bash -s`, so local shell variables in them are expanded here, not on the server.
"${SSH[@]}" bash -s -- "$APPLY" "$@" <<'REMOTE'
set -euo pipefail
cd /opt/app
APPLY=$1; shift
cp .env .env.bak
for kv in "$@"; do
  key=${kv%%=*}; value=${kv#*=}
  if grep -q "^${key}=" .env; then
    # awk instead of sed: values may contain / | & (passwords).
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > .env.tmp && mv .env.tmp .env
    echo "updated $key"
  else
    echo "${key}=${value}" >> .env
    echo "added   $key"
  fi
done
chmod 600 .env
if [ "$APPLY" = true ]; then
  docker compose up -d   # recreates only containers whose config changed
fi
REMOTE
