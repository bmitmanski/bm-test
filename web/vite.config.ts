import { defineConfig } from "vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";

// Set in CI (web/Dockerfile build args + secret). Without the token, nothing is uploaded.
const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, VITE_APP_VERSION } = process.env;

export default defineConfig({
  server: {
    // Same routing as production Caddy: /api/* -> API without the prefix.
    proxy: {
      "/api": { target: "http://localhost:3000", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  // "hidden": maps are generated for Sentry but not referenced from the served JS.
  build: { sourcemap: "hidden" },
  plugins: [
    sentryVitePlugin({
      disable: !SENTRY_AUTH_TOKEN,
      authToken: SENTRY_AUTH_TOKEN,
      org: SENTRY_ORG,
      project: SENTRY_PROJECT,
      release: { name: VITE_APP_VERSION },
      sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] }, // don't ship maps to users
      telemetry: false,
    }),
  ],
});
