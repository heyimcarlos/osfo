import { defineConfig } from "vitest/config";

/** Node test configuration for Worker services backed by embedded PostgreSQL. */
export default defineConfig({
  test: {
    include: [
      "test/auth.test.ts",
      "test/db.test.ts",
      "test/registration.test.ts",
      "test/twilio-verify.test.ts",
    ],
    testTimeout: 15_000,
  },
});
