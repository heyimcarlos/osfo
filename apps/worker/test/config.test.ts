import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { decodeOsfoStage, loadConfig, publicWebBaseUrl } from "../src/config";
import { launchModelAccessPolicy } from "../src/domain/model-access-policy";

describe("Worker configuration", () => {
  it("loads the complete deployment configuration", () => {
    const config = loadConfig(env);

    expect(config).toMatchObject({
      auth: {
        baseURL: "https://osfo.test/",
        credentialAuthentication: "enabled",
        trustedOrigins: ["https://osfo.test"],
      },
      companyConversation: {
        dailyTurnLimit: null,
        modelRoute: launchModelAccessPolicy.plans.free.route,
      },
      stage: "test",
      telegram: {
        botUsername: "osfo_test_bot",
      },
    });
  });

  it("names a missing binding without exposing its value", () => {
    expect(() => loadConfig({ ...env, BETTER_AUTH_SECRET: "" })).toThrowError(
      "Worker configuration is invalid: BETTER_AUTH_SECRET is required",
    );
  });

  it("leaves provider identifier validation to provider adapters", () => {
    const config = loadConfig({
      ...env,
      STRIPE_ADVENTURER_PRICE_ID: "configured-price",
      STRIPE_ADVENTURER_PRODUCT_ID: "configured-product",
      STRIPE_PORTAL_CONFIGURATION_ID: "configured-portal",
      TWILIO_ACCOUNT_SID: "configured-account",
      TWILIO_VERIFY_SERVICE_SID: "configured-service",
    });

    expect(config.stripe).toMatchObject({
      adventurerPriceId: "configured-price",
      adventurerProductId: "configured-product",
      portalConfigurationId: "configured-portal",
    });
    expect(config.twilioVerify.serviceSid).toBe("configured-service");
  });

  it("accepts product stages but rejects infrastructure stage names", () => {
    expect(Option.isSome(decodeOsfoStage("preview"))).toBe(true);
    expect(Option.isNone(decodeOsfoStage("pr-212"))).toBe(true);
    expect(() => loadConfig({ ...env, OSFO_STAGE: "pr-212" })).toThrowError(
      "Worker configuration is invalid: OSFO_STAGE is not supported",
    );
  });

  it("normalizes required Telegram configuration and redacts secrets", () => {
    const botToken = "telegram-test-bot-token";
    const webhookSecret = "telegram-test-webhook-secret";
    const config = loadConfig({
      ...env,
      TELEGRAM_BOT_TOKEN: botToken,
      TELEGRAM_BOT_USERNAME: " osfo_test_bot ",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: webhookSecret,
    });

    expect(config.telegram).toMatchObject({
      botUsername: "osfo_test_bot",
    });
    expect(JSON.stringify(config)).not.toContain(botToken);
    expect(JSON.stringify(config)).not.toContain(webhookSecret);
  });

  it("requires Telegram configuration and accepts it in production", () => {
    expect(() => loadConfig({ ...env, TELEGRAM_BOT_TOKEN: "" })).toThrowError(
      "Worker configuration is invalid: TELEGRAM_BOT_TOKEN is required",
    );

    expect(loadConfig({ ...env, OSFO_STAGE: "production" })).toMatchObject({
      stage: "production",
      telegram: {
        botUsername: "osfo_test_bot",
      },
    });
  });

  it("keeps the company conversation ceiling off and the route fixed by default", () => {
    expect(loadConfig(env).companyConversation.dailyTurnLimit).toBeNull();
  });

  it("accepts a bounded company conversation envelope from raw configuration", () => {
    const config = loadConfig({
      ...env,
      COMPANY_CONVERSATION_DAILY_TURN_LIMIT: "50",
      COMPANY_CONVERSATION_MODEL: "@cf/openai/gpt-oss-120b",
    });
    const ignoringInvalidOverride = loadConfig({
      ...env,
      COMPANY_CONVERSATION_DAILY_TURN_LIMIT: "not-a-number",
      COMPANY_CONVERSATION_MODEL: "totally-invalid-slug",
    });

    expect(config.companyConversation).toMatchObject({
      dailyTurnLimit: 50,
      modelRoute: "@cf/openai/gpt-oss-120b",
    });
    expect(ignoringInvalidOverride.companyConversation.modelRoute).toBe(
      launchModelAccessPolicy.plans.free.route,
    );
    expect(ignoringInvalidOverride.companyConversation.dailyTurnLimit).toBeNull();
  });

  it("rejects invalid Better Auth URLs with safe messages", () => {
    expect(() => loadConfig({ ...env, BETTER_AUTH_BASE_URL: "not-a-url" })).toThrowError(
      "Worker configuration is invalid: BETTER_AUTH_BASE_URL must contain a URL",
    );
    expect(() => loadConfig({ ...env, BETTER_AUTH_TRUSTED_ORIGINS: "[]" })).toThrowError(
      "Worker configuration is invalid: BETTER_AUTH_TRUSTED_ORIGINS must contain a URL",
    );
  });

  it("uses the first trusted web origin for public links", () => {
    const config = loadConfig(env);

    expect(publicWebBaseUrl(config.auth).href).toBe("https://osfo.test/");
  });

  it("uses the hosted web origin for production auth and public links", () => {
    const config = loadConfig({
      ...env,
      BETTER_AUTH_BASE_URL: "https://api.osfo.ai",
      BETTER_AUTH_TRUSTED_ORIGINS: '["http://localhost:5173"]',
      OSFO_STAGE: "production",
    });

    expect(config.auth.trustedOrigins).toEqual(["https://osfo.ai"]);
    expect(publicWebBaseUrl(config.auth).href).toBe("https://osfo.ai/");
  });
});
