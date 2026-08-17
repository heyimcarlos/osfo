import { defineConfig } from "vitest/config";

/** Node integration tests for the pinned disposable Python file container. */
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["test/file-task.integration.test.ts"],
    testTimeout: 120_000,
  },
});
