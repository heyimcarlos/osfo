import { defineConfig } from "vitest/config";

/** Node test configuration for Worker services backed by embedded PostgreSQL. */
export default defineConfig({
  test: {
    include: [
      "test/allowances.test.ts",
      "test/auth.test.ts",
      "test/authorization.test.ts",
      "test/db.test.ts",
      "test/onboarding.test.ts",
      "test/plan-policy.test.ts",
      "test/registration.test.ts",
      "test/twilio-verify.test.ts",
    ],
    testTimeout: 15_000,
  },
});
