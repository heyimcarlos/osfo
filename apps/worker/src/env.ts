import { Redacted, Result, Schema } from "effect";

/** Runtime environments that select Osfo behavior and configuration. */
export const OsfoStage = Schema.Literals(["development", "preview", "test", "production"]);

/** A parsed Osfo runtime environment. */
export type OsfoStage = typeof OsfoStage.Type;

/** Parse an Osfo stage at a Cloudflare binding boundary. */
export const decodeOsfoStage = Schema.decodeUnknownOption(OsfoStage);

const BetterAuthSecret = Schema.String.check(
  Schema.makeFilter((value) => value.length >= 32 || "must contain at least 32 characters"),
);
const BetterAuthApiKey = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be empty"),
);
const TwilioAccountSid = Schema.String.check(
  Schema.makeFilter((value) => /^AC[0-9a-fA-F]{32}$/.test(value) || "must be a Twilio Account SID"),
);
const TwilioAuthToken = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be empty"),
);
const TwilioVerifyServiceSid = Schema.String.check(
  Schema.makeFilter(
    (value) => /^VA[0-9a-fA-F]{32}$/.test(value) || "must be a Twilio Verify Service SID",
  ),
);
const StripeSecret = Schema.String.check(Schema.isMinLength(1));
const StripeProductId = Schema.String.check(
  Schema.makeFilter((value) => /^prod_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Product ID"),
);
const StripePriceId = Schema.String.check(
  Schema.makeFilter((value) => /^price_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Price ID"),
);
const StripePortalConfigurationId = Schema.String.check(
  Schema.makeFilter(
    (value) => /^bpc_[A-Za-z0-9]+$/u.test(value) || "must be a Stripe Portal Configuration ID",
  ),
);
const WhatsAppPhoneNumber = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[1-9]\d{7,14}$/u.test(value) || "must be an E.164 number without the plus sign",
  ),
);
const MetaSecret = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be empty"),
);
const TelegramBotToken = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 || "must not be empty"),
);
const TelegramBotUsername = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[A-Za-z0-9_]{5,32}$/u.test(value) || "must be a Telegram bot username",
  ),
);
const TelegramWebhookSecret = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (/^[A-Za-z0-9_-]{1,256}$/u.test(value) && value.length >= 16) ||
      "must be a bounded Telegram webhook secret",
  ),
);
const TrustedOrigins = Schema.fromJsonString(
  Schema.Array(Schema.URLFromString).check(
    Schema.makeFilter((origins) => origins.length > 0 || "must contain at least one origin"),
  ),
);
const RawRuntimeConfig = Schema.Struct({
  BETTER_AUTH_API_KEY: BetterAuthApiKey,
  BETTER_AUTH_BASE_URL: Schema.URLFromString,
  BETTER_AUTH_SECRET: BetterAuthSecret,
  BETTER_AUTH_TRUSTED_ORIGINS: TrustedOrigins,
  META_APP_SECRET: MetaSecret,
  META_WEBHOOK_VERIFY_TOKEN: MetaSecret,
  OSFO_STAGE: OsfoStage,
  TELEGRAM_ALLOWED_USER_IDS: Schema.optional(Schema.String),
  TELEGRAM_BOT_TOKEN: Schema.optional(Schema.String),
  TELEGRAM_BOT_USERNAME: Schema.optional(Schema.String),
  TELEGRAM_WEBHOOK_SECRET_TOKEN: Schema.optional(Schema.String),
  STRIPE_ADVENTURER_PRICE_ID: StripePriceId,
  STRIPE_ADVENTURER_PRODUCT_ID: StripeProductId,
  STRIPE_PORTAL_CONFIGURATION_ID: StripePortalConfigurationId,
  STRIPE_SECRET_KEY: StripeSecret,
  STRIPE_WEBHOOK_SECRET: StripeSecret,
  TWILIO_ACCOUNT_SID: TwilioAccountSid,
  TWILIO_AUTH_TOKEN: TwilioAuthToken,
  TWILIO_VERIFY_SERVICE_SID: TwilioVerifyServiceSid,
  WHATSAPP_PHONE_NUMBER: WhatsAppPhoneNumber,
});

const RawTelegramConfig = Schema.Struct({
  OSFO_STAGE: Schema.Literals(["development", "preview", "test"]),
  TELEGRAM_ALLOWED_USER_IDS: Schema.Array(
    Schema.String.check(
      Schema.makeFilter((value) => /^\d{1,16}$/u.test(value) || "must be a Telegram User ID"),
    ),
  ).check(Schema.isMinLength(1)),
  TELEGRAM_BOT_TOKEN: TelegramBotToken,
  TELEGRAM_BOT_USERNAME: TelegramBotUsername,
  TELEGRAM_WEBHOOK_SECRET_TOKEN: TelegramWebhookSecret,
});

/** Parsed runtime configuration for one Worker invocation. */
export interface RuntimeConfig {
  readonly auth: {
    readonly baseURL: string;
    readonly dashboard:
      | { readonly kind: "disabled" }
      | { readonly apiKey: Redacted.Redacted; readonly kind: "enabled" };
    readonly secret: Redacted.Redacted;
    readonly trustedOrigins: ReadonlyArray<string>;
  };
  readonly stage: OsfoStage;
  readonly meta: {
    readonly appSecret: Redacted.Redacted;
    readonly webhookVerifyToken: Redacted.Redacted;
  };
  readonly telegram:
    | { readonly kind: "disabled" }
    | {
        readonly allowedUserIds: ReadonlyArray<string>;
        readonly botToken: Redacted.Redacted;
        readonly botUsername: string;
        readonly kind: "enabled";
        readonly webhookSecret: Redacted.Redacted;
      };
  readonly stripe: {
    readonly adventurerPriceId: string;
    readonly adventurerProductId: string;
    readonly portalConfigurationId: string;
    readonly secretKey: Redacted.Redacted;
    readonly webhookSecret: Redacted.Redacted;
  };
  readonly whatsApp: {
    readonly phoneNumber: string;
  };
  readonly twilioVerify: {
    readonly accountSid: Redacted.Redacted;
    readonly authToken: Redacted.Redacted;
    readonly serviceSid: string;
  };
}

/** Raw Worker bindings accepted by the runtime configuration decoder. */
export interface RuntimeConfigInput {
  readonly BETTER_AUTH_API_KEY?: string;
  readonly BETTER_AUTH_BASE_URL?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly BETTER_AUTH_TRUSTED_ORIGINS?: string;
  readonly META_APP_SECRET?: string;
  readonly META_WEBHOOK_VERIFY_TOKEN?: string;
  readonly OSFO_STAGE?: string;
  readonly TELEGRAM_ALLOWED_USER_IDS?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TELEGRAM_BOT_USERNAME?: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
  readonly STRIPE_ADVENTURER_PRICE_ID?: string;
  readonly STRIPE_ADVENTURER_PRODUCT_ID?: string;
  readonly STRIPE_PORTAL_CONFIGURATION_ID?: string;
  readonly STRIPE_SECRET_KEY?: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
  readonly TWILIO_ACCOUNT_SID?: string;
  readonly TWILIO_AUTH_TOKEN?: string;
  readonly TWILIO_VERIFY_SERVICE_SID?: string;
  readonly WHATSAPP_PHONE_NUMBER?: string;
}

/** Decode and redact all Worker authentication configuration before use. */
export const decodeRuntimeConfig = (input: RuntimeConfigInput) =>
  Result.flatMap(Schema.decodeUnknownResult(RawRuntimeConfig)(input), (raw) => {
    const telegramValues = [
      raw.TELEGRAM_ALLOWED_USER_IDS,
      raw.TELEGRAM_BOT_TOKEN,
      raw.TELEGRAM_BOT_USERNAME,
      raw.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    ];
    const telegram = telegramValues.every((value) => value === undefined || value === "")
      ? Result.succeed<RuntimeConfig["telegram"]>({ kind: "disabled" })
      : Result.map(
          Schema.decodeUnknownResult(RawTelegramConfig)({
            OSFO_STAGE: raw.OSFO_STAGE,
            TELEGRAM_ALLOWED_USER_IDS:
              raw.TELEGRAM_ALLOWED_USER_IDS?.split(",").map((value) => value.trim()) ?? [],
            TELEGRAM_BOT_TOKEN: raw.TELEGRAM_BOT_TOKEN,
            TELEGRAM_BOT_USERNAME: raw.TELEGRAM_BOT_USERNAME,
            TELEGRAM_WEBHOOK_SECRET_TOKEN: raw.TELEGRAM_WEBHOOK_SECRET_TOKEN,
          }),
          (parsedTelegram): RuntimeConfig["telegram"] => ({
            allowedUserIds: parsedTelegram.TELEGRAM_ALLOWED_USER_IDS,
            botToken: Redacted.make(parsedTelegram.TELEGRAM_BOT_TOKEN),
            botUsername: parsedTelegram.TELEGRAM_BOT_USERNAME,
            kind: "enabled",
            webhookSecret: Redacted.make(parsedTelegram.TELEGRAM_WEBHOOK_SECRET_TOKEN),
          }),
        );
    return Result.map(telegram, (telegramConfig): RuntimeConfig => ({
      auth: {
        baseURL: raw.BETTER_AUTH_BASE_URL.href,
        dashboard: {
          apiKey: Redacted.make(raw.BETTER_AUTH_API_KEY),
          kind: "enabled",
        },
        secret: Redacted.make(raw.BETTER_AUTH_SECRET),
        trustedOrigins: raw.BETTER_AUTH_TRUSTED_ORIGINS.map((origin) => origin.origin),
      },
      meta: {
        appSecret: Redacted.make(raw.META_APP_SECRET),
        webhookVerifyToken: Redacted.make(raw.META_WEBHOOK_VERIFY_TOKEN),
      },
      stage: raw.OSFO_STAGE,
      stripe: {
        adventurerPriceId: raw.STRIPE_ADVENTURER_PRICE_ID,
        adventurerProductId: raw.STRIPE_ADVENTURER_PRODUCT_ID,
        portalConfigurationId: raw.STRIPE_PORTAL_CONFIGURATION_ID,
        secretKey: Redacted.make(raw.STRIPE_SECRET_KEY),
        webhookSecret: Redacted.make(raw.STRIPE_WEBHOOK_SECRET),
      },
      telegram: telegramConfig,
      whatsApp: { phoneNumber: raw.WHATSAPP_PHONE_NUMBER },
      twilioVerify: {
        accountSid: Redacted.make(raw.TWILIO_ACCOUNT_SID),
        authToken: Redacted.make(raw.TWILIO_AUTH_TOKEN),
        serviceSid: raw.TWILIO_VERIFY_SERVICE_SID,
      },
    }));
  });
