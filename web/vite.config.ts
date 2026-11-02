import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Same routing as production Caddy: /api/* -> API without the prefix.
    proxy: {
      "/api": { target: "http://localhost:3000", rewrite: (path) => path.replace(/^\/api/, "") },
    },
  },
  build: { sourcemap: true },
});
