import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const workerBindings = {
  AI: {},
  BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
  BETTER_AUTH_BASE_URL: "https://osfo.test",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
  BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
  META_APP_SECRET: "test-only-meta-app-secret",
  META_WEBHOOK_VERIFY_TOKEN: "test-only-meta-webhook-token",
  TWILIO_ACCOUNT_SID: "AC11111111111111111111111111111111",
  STRIPE_ADVENTURER_PRICE_ID: "price_adventurer",
  STRIPE_ADVENTURER_PRODUCT_ID: "prod_adventurer",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_approved",
  STRIPE_SECRET_KEY: "sk_test_osfo",
  STRIPE_WEBHOOK_SECRET: "whsec_test_osfo",
  TELEGRAM_ALLOWED_USER_IDS: "12345,67890",
  TELEGRAM_BOT_TOKEN: "telegram-test-bot-token",
  TELEGRAM_BOT_USERNAME: "osfo_test_bot",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "telegram-test-webhook-secret",
  TWILIO_AUTH_TOKEN: "test-only-twilio-token",
  TWILIO_VERIFY_SERVICE_SID: "VA22222222222222222222222222222222",
  WHATSAPP_PHONE_NUMBER: "14165550100",
};

/** Local Cloudflare Worker and execution-unit test configuration. */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { bindings: workerBindings },
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
  test: {
    fileParallelism: false,
    include: [
      "test/action-approval.test.ts",
      "test/config.test.ts",
      "test/file-ingestion.test.ts",
      "test/document-artifacts-r2.test.ts",
      "test/document-compute.test.ts",
      "test/document-download.test.ts",
      "test/managed-turn-execution.test.ts",
      "test/model-access-policy.test.ts",
      "test/osfo-agent.test.ts",
      "test/registration-dialogue.test.ts",
      "test/session-execution.test.ts",
      "test/session-lifecycle.test.ts",
      "test/session-recall.test.ts",
      "test/worker.test.ts",
    ],
    testTimeout: 30_000,
  },
});
