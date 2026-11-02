# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /web
COPY package*.json ./
RUN npm ci
COPY . .
ARG APP_VERSION=dev
# Public values, baked into the bundle / used to name the Sentry release.
ARG SENTRY_DSN=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ENV VITE_APP_VERSION=$APP_VERSION VITE_SENTRY_DSN=$SENTRY_DSN SENTRY_ORG=$SENTRY_ORG SENTRY_PROJECT=$SENTRY_PROJECT
# The auth token is a build secret: available to this step only, never stored in an image layer.
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN npm run build
# Target of the /sentry-tunnel route, from the DSN (https://<key>@<host>/<project>). Without a DSN the route is a 404.
RUN <<'EOF'
set -eu
if [ -n "$SENTRY_DSN" ]; then
  rest=${SENTRY_DSN#*@}; host=${rest%%/*}; project=${rest##*/}
  cat > sentry-tunnel.caddy <<CADDY
rewrite * /api/$project/envelope/
reverse_proxy https://$host {
	header_up Host {upstream_hostport}
}
CADDY
else
  echo "respond 404" > sentry-tunnel.caddy
fi
EOF

FROM caddy:2.11-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /web/sentry-tunnel.caddy /etc/caddy/sentry-tunnel.caddy
COPY --from=build /web/dist /srv
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
