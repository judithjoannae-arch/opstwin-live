import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiTarget = env.VITE_DEV_API_TARGET || "http://localhost:8000";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Same-origin /api keeps the HTTP-only session cookie first-party.
      proxy: { "/api": { target: apiTarget, ws: true } },
    },
    preview: {
      port: 4173,
      proxy: { "/api": { target: apiTarget, ws: true } },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
    },
  };
});
