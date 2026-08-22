import { defineConfig } from "vitest/config";

/** Native PostgreSQL tests that require OSFO_TEST_POSTGRES_URL. */
export default defineConfig({
  test: {
    include: ["test/pg-control.test.ts"],
  },
});
