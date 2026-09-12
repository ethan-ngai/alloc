import { defineConfig } from "vitest/config";

// Files run serially: each starts and removes its own containers, and the
// Docker CLI is a shared, single-daemon resource.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
