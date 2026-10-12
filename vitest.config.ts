import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["backend", "backend/sdk", "frontend"],
  },
});
