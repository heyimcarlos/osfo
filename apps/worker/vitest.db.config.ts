import { defineConfig } from "vitest/config";

/** Node test configuration for Worker services backed by isolated PGlite databases. */
export default defineConfig({
  test: {
    include: [
      "test/allowances.test.ts",
      "test/action-executor.test.ts",
      "test/auth.test.ts",
      "test/auth-session-authority.test.ts",
      "test/billing-authorization.test.ts",
      "test/authorization.test.ts",
      "test/billing-subscriptions.test.ts",
      "test/billing-subscriptions-failures.test.ts",
      "test/billing-presentation.test.ts",
      "test/billing-return.test.ts",
      "test/checkout-evidence.test.ts",
      "test/channel-links.test.ts",
      "test/db.test.ts",
      "test/file-content.test.ts",
      "test/deletion-case-authority.test.ts",
      "test/document-generation.test.ts",
      "test/plan-policy.test.ts",
      "test/phone-account-authority.test.ts",
      "test/stripe-billing.test.ts",
      "test/stripe-billing-eligibility.test.ts",
      "test/stripe-adapter.test.ts",
      "test/stripe-webhooks.test.ts",
      "test/session-recall-authorization.test.ts",
      "test/session-recall-authorization-postgres.test.ts",
      "test/twilio-verify.test.ts",
      "test/user-suspension-authority.test.ts",
      "test/webhook-ingestion.test.ts",
      "test/webhooks.test.ts",
    ],
    testTimeout: 15_000,
  },
});
