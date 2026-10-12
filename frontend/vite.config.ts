import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const contract = fileURLToPath(new URL("../backend/src/contract/index.ts", import.meta.url));
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shade/contract": contract,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in dev: the browser only ever talks to Vite, which forwards API calls.
    proxy: {
      "/api": { target: apiTarget, changeOrigin: false, xfwd: true },
      "/v1": { target: apiTarget, changeOrigin: false, xfwd: true },
    },
  },
  preview: { port: 4173, strictPort: true },
  build: { sourcemap: true, target: "es2022" },
});
