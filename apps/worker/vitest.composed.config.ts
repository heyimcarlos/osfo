import { defineConfig } from "vitest/config";

/** Focused tests against a verifier-owned Wrangler Worker and PostgreSQL database. */
export default defineConfig({
  test: {
    include: ["test/composed/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
