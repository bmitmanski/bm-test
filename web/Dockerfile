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

FROM caddy:2.11-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /web/dist /srv
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
