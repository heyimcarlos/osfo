import { defineConfig } from "vitest/config";

/** Credentialed provider qualification excluded from ordinary repository and CI tests. */
export default defineConfig({
  test: {
    disableConsoleIntercept: true,
    fileParallelism: false,
    include: ["test/live/**/*.live.test.ts"],
    testTimeout: 15 * 60_000,
  },
});
