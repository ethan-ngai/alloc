import { defineConfig } from "vitest/config";

// E2E spawns a real API process against a shared replica set; keep it serial.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
