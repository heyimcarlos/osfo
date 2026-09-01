import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";

import { loadConfig, type CloudflareEnv, type OsfoStage } from "./config";

const configuredEnv: CloudflareEnv = {
  ...env,
  BETTER_AUTH_API_KEY: "test-only-better-auth-dashboard-api-key",
  BETTER_AUTH_BASE_URL: "https://osfo.test",
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-characters",
  BETTER_AUTH_TRUSTED_ORIGINS: '["https://osfo.test"]',
  COMPOSIO_API_KEY: "configured-for-test",
  STRIPE_ADVENTURER_PRICE_ID: "price_adventurer",
  STRIPE_ADVENTURER_PRODUCT_ID: "prod_adventurer",
  STRIPE_PORTAL_CONFIGURATION_ID: "bpc_approved",
  STRIPE_SECRET_KEY: "sk_test_osfo",
  STRIPE_WEBHOOK_SECRET: "whsec_test_osfo",
  SUPERMEMORY_API_KEY: "test-only-supermemory-api-key",
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

it("requires a nonempty Composio credential in production", () => {
  const { COMPOSIO_API_KEY: configuredComposioKey, ...envWithoutComposio } = configuredEnv;
  expect(configuredComposioKey).toBe("configured-for-test");

  expect(() =>
    loadConfig({
      ...envWithoutComposio,
      OSFO_STAGE: "production",
    }),
  ).toThrowError("Worker configuration is invalid: COMPOSIO_API_KEY is required in production");
  expect(() =>
    loadConfig({
      ...envWithoutComposio,
      COMPOSIO_API_KEY: "   ",
      OSFO_STAGE: "production",
    }),
  ).toThrowError("Worker configuration is invalid: COMPOSIO_API_KEY is required in production");

  for (const stage of ["development", "test"] satisfies ReadonlyArray<OsfoStage>) {
    expect(
      loadConfig({
        ...envWithoutComposio,
        OSFO_STAGE: stage,
      }).integrationProvider,
    ).toEqual({ _tag: "Composio", config: null });
  }
});
