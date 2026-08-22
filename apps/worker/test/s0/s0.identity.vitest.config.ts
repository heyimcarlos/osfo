/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/global-date, effecttsgo/global-random, effecttsgo/async-function, effecttsgo/global-fetch -- throwaway S0 spike harness code, plain Node is intentional */
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const workerBindings = {
  AI: {},
  BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
  BETTER_AUTH_BASE_URL: "https://osfo.test",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
  BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
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
  TWILIO_VERIFY_API_BASE_URL: "http://127.0.0.1:9798",
  WHATSAPP_ACCESS_TOKEN: "test-only-whatsapp-access-token",
  WHATSAPP_APP_SECRET: "test-only-whatsapp-app-secret",
  WHATSAPP_BOT_USERNAME: "osfo_test_whatsapp",
  WHATSAPP_PHONE_NUMBER_ID: "123456789",
  WHATSAPP_VERIFY_TOKEN: "test-only-whatsapp-verify-token",
};

export default defineConfig({
  plugins: [
    cloudflareTest(() => ({
      wrangler: { configPath: "./test/s0/wrangler.auth.jsonc" },
      miniflare: {
        bindings: {
          ...workerBindings,
          DB: {
            connectionString:
              process.env.OSFO_S0_DB_URL ?? "postgres://osfo:osfo@127.0.0.1:5432/osfo_s0_auth",
          },
        },
      },
    })),
  ],
  test: {
    include: ["test/s0/**/*.registration.test.ts"],
    globalSetup: ["./test/s0/identity.globalsetup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
