import { defineConfig } from "vitest/config";

/** Node test configuration for Worker services backed by isolated PGlite databases. */
export default defineConfig({
  test: {
    include: [
      "test/allowances.test.ts",
      "test/action-executor.test.ts",
      "test/auth.test.ts",
      "test/auth-session-authority.test.ts",
      "test/authorization.test.ts",
      "test/db.test.ts",
      "test/deletion-case-authority.test.ts",
      "test/document-generation.test.ts",
      "test/meta-whatsapp.test.ts",
      "test/onboarding.test.ts",
      "test/plan-policy.test.ts",
      "test/phone-account-authority.test.ts",
      "test/registration.test.ts",
      "test/twilio-verify.test.ts",
      "test/user-suspension-authority.test.ts",
      "test/whatsapp-agent-admission.test.ts",
      "test/whatsapp-admission.test.ts",
      "test/whatsapp-admission-postgres.test.ts",
      "test/whatsapp-handler.test.ts",
    ],
    testTimeout: 15_000,
  },
});
