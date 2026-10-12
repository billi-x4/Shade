import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const backendDir = fileURLToPath(new URL("../backend", import.meta.url));
const reuse = !process.env.CI;

/**
 * End-to-end smoke against the real backend (in-memory database, test env) and the Vite dev server,
 * which proxies /api and /v1 so the browser stays same-origin exactly as in production.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Not `npm run dev`: that loads backend/.env, whose DATABASE_URL would point the test server
      // at a real database. The server finds its files from import.meta.url, not the cwd.
      command: "node src/bin/server.ts",
      cwd: backendDir,
      url: "http://127.0.0.1:8787/healthz",
      reuseExistingServer: reuse,
      timeout: 120_000,
      env: {
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: "8787",
        APP_ORIGIN: "http://localhost:5173",
        SHADE_NETWORKS: "testnet",
        AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
        MAIL_TRANSPORT: "console",
        LOG_LEVEL: "warn",
        // Empty counts as unset (loadConfig): a value exported in the shell cannot leak in, and
        // the server falls back to an in-memory database.
        DATABASE_URL: "",
        DATABASE_URL_UNPOOLED: "",
        SHADE_WORKER: "off",
      },
    },
    {
      command: "npm run dev -w @shade/frontend",
      cwd: repoRoot,
      url: "http://localhost:5173",
      reuseExistingServer: reuse,
      timeout: 120_000,
    },
  ],
});
