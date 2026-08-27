/* oxlint-disable effecttsgo/process-env -- Vite owns this Node configuration boundary. */
import { defineConfig } from "vitest/config";

/** Focused tests against a verifier-owned Wrangler Worker and PostgreSQL database. */
export default defineConfig({
  // The preceding CI journeys run in Docker and can leave node_modules/.vite-temp root-owned.
  cacheDir:
    process.env.RUNNER_TEMP === undefined
      ? undefined
      : `${process.env.RUNNER_TEMP}/osfo-vite-composed`,
  test: {
    include: ["test/composed/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
