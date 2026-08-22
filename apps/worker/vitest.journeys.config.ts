/* oxlint-disable effecttsgo/async-function -- Cloudflare's per-file test configuration owns this Promise boundary. */
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { cloneTestDatabase } from "@osfo/db/testing/postgres";
import { defineConfig } from "vitest/config";

const workerBindings = {
  AI: {},
  BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
  BETTER_AUTH_BASE_URL: "https://osfo.test",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
  BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
  STRIPE_ADVENTURER_PRICE_ID: "price_adventurer",
  STRIPE_ADVENTURER_PRODUCT_ID: "prod_adventurer",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_approved",
  STRIPE_SECRET_KEY: "sk_test_osfo",
  STRIPE_WEBHOOK_SECRET: "whsec_test_osfo",
  TELEGRAM_ALLOWED_USER_IDS: "12345,67890",
  TELEGRAM_BOT_TOKEN: "telegram-test-bot-token",
  TELEGRAM_BOT_USERNAME: "osfo_test_bot",
  TELEGRAM_WEBHOOK_SECRET_TOKEN: "telegram-test-webhook-secret",
  TWILIO_ACCOUNT_SID: "AC11111111111111111111111111111111",
  TWILIO_AUTH_TOKEN: "test-only-twilio-token",
  TWILIO_VERIFY_SERVICE_SID: "VA22222222222222222222222222222222",
  WHATSAPP_ACCESS_TOKEN: "test-only-whatsapp-access-token",
  WHATSAPP_APP_SECRET: "test-only-whatsapp-app-secret",
  WHATSAPP_BOT_USERNAME: "osfo_test_whatsapp",
  WHATSAPP_PHONE_NUMBER_ID: "123456789",
  WHATSAPP_VERIFY_TOKEN: "test-only-whatsapp-verify-token",
};

let fileNumber = 0;

/** Full public Worker journeys with one native PostgreSQL clone per test file. */
export default defineConfig({
  plugins: [
    cloudflareTest(async ({ inject }) => {
      const context = inject("osfoJourney");
      fileNumber += 1;
      const database = await cloneTestDatabase({
        databaseName: `${context.databaseNamePrefix}journey_${fileNumber}`,
        maintenanceUrl: context.maintenanceUrl,
        templateName: context.templateName,
      });
      return {
        miniflare: {
          bindings: {
            ...workerBindings,
            BETTER_AUTH_API_URL: context.providerOrigin,
            DB: { connectionString: database.connectionString },
            STRIPE_API_BASE_URL: context.providerOrigin,
            TWILIO_VERIFY_API_BASE_URL: context.providerOrigin,
          },
        },
        wrangler: { configPath: "./test/wrangler.journeys.jsonc" },
      };
    }),
  ],
  test: {
    fileParallelism: false,
    globalSetup: ["./test/support/journey.globalsetup.ts"],
    include: ["test/journeys/**/*.test.ts"],
    onUnhandledError: (error) =>
      error.message === "Stream was cancelled." &&
      error.stack?.includes("/postgres/cf/polyfills.js")
        ? false
        : undefined,
    testTimeout: 60_000,
  },
});
