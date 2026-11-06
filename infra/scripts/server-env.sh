#!/usr/bin/env bash
# Run LOCALLY. Sets variables in /opt/app/.env on the server (adds missing ones, replaces existing ones).
# Reads IP from .env.setup in the repo root.
#
#   infra/scripts/server-env.sh ALERT_EMAIL=you@gmail.com
#   infra/scripts/server-env.sh --apply SMTP_ENABLED=true             # also recreate containers whose config changed
#   infra/scripts/server-env.sh --list                                # show variable names (values hidden)
#   infra/scripts/server-env.sh --staging --apply DEBUG_ROUTES=false  # staging: /opt/app/.env.staging
set -euo pipefail
cd "$(dirname "$0")/../.."

set -a; source .env.setup; set +a
: "${IP:?IP missing in .env.setup}"
SSH=(ssh -i ~/.ssh/bm-test-deploy "deploy@$IP")

APPLY=false
LIST=false
ENV_FILE=.env
while [[ "${1:-}" == --* ]]; do
  case "$1" in
    --staging) ENV_FILE=.env.staging ;;
    --apply) APPLY=true ;;
    --list) LIST=true ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done
if [ "$LIST" = true ]; then "${SSH[@]}" "cut -d= -f1 /opt/app/$ENV_FILE | grep -v '^#'"; exit; fi
[ $# -gt 0 ] || { sed -n '2,8p' "$0"; exit 1; }

for kv in "$@"; do
  [[ "$kv" == *=* ]] || { echo "Expected KEY=VALUE, got: $kv"; exit 1; }
done

# Values travel as arguments to `bash -s`, so local shell variables in them are expanded here, not on the server.
"${SSH[@]}" bash -s -- "$ENV_FILE" "$APPLY" "$@" <<'REMOTE'
set -euo pipefail
cd /opt/app
ENV_FILE=$1 APPLY=$2; shift 2
cp "$ENV_FILE" "$ENV_FILE.bak"
for kv in "$@"; do
  key=${kv%%=*}; value=${kv#*=}
  if grep -q "^${key}=" "$ENV_FILE"; then
    # awk instead of sed: values may contain / | & (passwords).
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    echo "updated $key"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    echo "added   $key"
  fi
done
chmod 600 "$ENV_FILE"
if [ "$APPLY" = true ]; then
  # Recreates only containers whose config changed.
  if [ "$ENV_FILE" = .env.staging ]; then
    docker compose -f compose.staging.yml --env-file .env.staging up -d
  else
    docker compose up -d
  fi
fi
REMOTE
