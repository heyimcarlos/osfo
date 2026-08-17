import { defineConfig } from "vitest/config";

/** Explicit real PostgreSQL test configuration for transaction concurrency evidence. */
export default defineConfig({
  test: {
    fileParallelism: false,
    include: [
      "test/allowances.real-postgres.test.ts",
      "test/account-authorities.real-postgres.test.ts",
      "test/gmail.real-postgres.test.ts",
      "test/real-postgres-fixture.real-postgres.test.ts",
      "test/stripe-billing.real-postgres.test.ts",
      "test/whatsapp-admission.real-postgres.test.ts",
    ],
    testTimeout: 30_000,
  },
});
