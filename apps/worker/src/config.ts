import { Option, Redacted, Schema } from "effect";

/** Runtime environments that select Osfo behavior and configuration. */
export const OsfoStage = Schema.Literals(["development", "preview", "test", "production"]);

/** A parsed Osfo runtime environment. */
export type OsfoStage = typeof OsfoStage.Type;

/** Parse an Osfo stage at a Cloudflare binding boundary. */
export const decodeOsfoStage = Schema.decodeUnknownOption(OsfoStage);

const TrustedOrigins = Schema.fromJsonString(Schema.Array(Schema.URLFromString));
const productionApiOrigin = "https://api.osfo.ai";
const productionWebOrigin = "https://osfo.ai";

type RawConfigBinding =
  | "BETTER_AUTH_API_KEY"
  | "BETTER_AUTH_BASE_URL"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_TRUSTED_ORIGINS"
  | "OSFO_STAGE"
  | "STRIPE_ADVENTURER_PRICE_ID"
  | "STRIPE_ADVENTURER_PRODUCT_ID"
  | "STRIPE_PORTAL_CONFIGURATION_ID"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "TELEGRAM_ALLOWED_USER_IDS"
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_BOT_USERNAME"
  | "TELEGRAM_WEBHOOK_SECRET_TOKEN"
  | "TWILIO_ACCOUNT_SID"
  | "TWILIO_AUTH_TOKEN"
  | "TWILIO_VERIFY_SERVICE_SID"
  | "WHATSAPP_ACCESS_TOKEN"
  | "WHATSAPP_APP_SECRET"
  | "WHATSAPP_BOT_USERNAME"
  | "WHATSAPP_PHONE_NUMBER_ID"
  | "WHATSAPP_PUBLIC_PHONE_NUMBER"
  | "WHATSAPP_VERIFY_TOKEN";

type GeneratedCloudflareBindings = Omit<Env, RawConfigBinding>;

/** Generated Cloudflare bindings and raw Worker configuration values. */
export interface CloudflareEnv extends GeneratedCloudflareBindings {
  readonly BETTER_AUTH_API_KEY?: string;
  readonly BETTER_AUTH_BASE_URL?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly BETTER_AUTH_TRUSTED_ORIGINS?: string;
  readonly OSFO_STAGE?: string;
  readonly STRIPE_ADVENTURER_PRICE_ID?: string;
  readonly STRIPE_ADVENTURER_PRODUCT_ID?: string;
  readonly STRIPE_PORTAL_CONFIGURATION_ID?: string;
  readonly STRIPE_SECRET_KEY?: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
  readonly TELEGRAM_ALLOWED_USER_IDS?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TELEGRAM_BOT_USERNAME?: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
  readonly TWILIO_ACCOUNT_SID?: string;
  readonly TWILIO_AUTH_TOKEN?: string;
  readonly TWILIO_VERIFY_SERVICE_SID?: string;
  readonly WHATSAPP_ACCESS_TOKEN?: string;
  readonly WHATSAPP_APP_SECRET?: string;
  readonly WHATSAPP_BOT_USERNAME?: string;
  readonly WHATSAPP_PHONE_NUMBER_ID?: string;
  readonly WHATSAPP_PUBLIC_PHONE_NUMBER?: string;
  readonly WHATSAPP_VERIFY_TOKEN?: string;
}

/** Better Auth and dashboard configuration. */
export interface AuthConfig {
  readonly baseURL: string;
  readonly credentialAuthentication: "disabled" | "enabled";
  readonly dashboard:
    | { readonly kind: "disabled" }
    | {
        readonly apiKey: Redacted.Redacted;
        readonly kind: "enabled";
      };
  readonly secret: Redacted.Redacted;
  readonly trustedOrigins: ReadonlyArray<string>;
}

/** Resolve the first trusted web origin used for public Osfo links. */
export const publicWebBaseUrl = (config: AuthConfig): URL =>
  new URL(config.trustedOrigins[0] ?? config.baseURL);

/** WhatsApp webhook, delivery, and public identity configuration. */
export interface WhatsAppConfig {
  readonly accessToken: Redacted.Redacted;
  readonly appSecret: Redacted.Redacted;
  readonly botUsername: string;
  readonly phoneNumberId: string;
  readonly publicPhoneNumber: string;
  readonly verifyToken: Redacted.Redacted;
}

/** Stripe billing configuration. */
export interface StripeConfig {
  readonly adventurerPriceId: string;
  readonly adventurerProductId: string;
  readonly portalConfigurationId: string;
  readonly secretKey: Redacted.Redacted;
  readonly webhookSecret: Redacted.Redacted;
}

/** Telegram onboarding and delivery configuration. */
export interface TelegramConfig {
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly botToken: Redacted.Redacted;
  readonly botUsername: string;
  readonly webhookSecret: Redacted.Redacted;
}

/** Twilio Verify configuration. */
export interface TwilioVerifyConfig {
  readonly accountSid: Redacted.Redacted;
  readonly authToken: Redacted.Redacted;
  readonly serviceSid: string;
}

/** Parsed configuration used by one request application. */
export interface CloudflareConfig {
  readonly auth: AuthConfig;
  readonly stage: OsfoStage;
  readonly stripe: StripeConfig;
  readonly telegram: TelegramConfig;
  readonly twilioVerify: TwilioVerifyConfig;
  readonly whatsApp: WhatsAppConfig;
}

/** A safe deployment configuration failure. */
export class WorkerConfigurationError extends Schema.TaggedError<WorkerConfigurationError>()(
  "WorkerConfigurationError",
  { message: Schema.String },
) {}

/** Load, validate, normalize, and redact the complete Worker configuration. */
export const loadConfig = (env: CloudflareEnv): CloudflareConfig => {
  const stage = Option.getOrElse(decodeOsfoStage(env.OSFO_STAGE), () =>
    invalid("OSFO_STAGE is not supported"),
  );
  const baseURL = parseUrl("BETTER_AUTH_BASE_URL", required(env, "BETTER_AUTH_BASE_URL").trim());
  const trustedOrigins = selectTrustedOrigins(
    stage,
    baseURL,
    parseTrustedOrigins(required(env, "BETTER_AUTH_TRUSTED_ORIGINS").trim()),
  );
  const secret = required(env, "BETTER_AUTH_SECRET");
  if (secret.length < 32) invalid("BETTER_AUTH_SECRET must contain at least 32 characters");

  const allowedUserIds = required(env, "TELEGRAM_ALLOWED_USER_IDS")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (allowedUserIds.length === 0) invalid("TELEGRAM_ALLOWED_USER_IDS is required");

  return {
    auth: {
      baseURL: baseURL.href,
      credentialAuthentication: "enabled",
      dashboard: {
        apiKey: Redacted.make(required(env, "BETTER_AUTH_API_KEY")),
        kind: "enabled",
      },
      secret: Redacted.make(secret),
      trustedOrigins,
    },
    stage,
    stripe: {
      adventurerPriceId: required(env, "STRIPE_ADVENTURER_PRICE_ID").trim(),
      adventurerProductId: required(env, "STRIPE_ADVENTURER_PRODUCT_ID").trim(),
      portalConfigurationId: required(env, "STRIPE_PORTAL_CONFIGURATION_ID").trim(),
      secretKey: Redacted.make(required(env, "STRIPE_SECRET_KEY")),
      webhookSecret: Redacted.make(required(env, "STRIPE_WEBHOOK_SECRET")),
    },
    telegram: {
      allowedUserIds,
      botToken: Redacted.make(required(env, "TELEGRAM_BOT_TOKEN")),
      botUsername: required(env, "TELEGRAM_BOT_USERNAME").trim(),
      webhookSecret: Redacted.make(required(env, "TELEGRAM_WEBHOOK_SECRET_TOKEN")),
    },
    twilioVerify: {
      accountSid: Redacted.make(required(env, "TWILIO_ACCOUNT_SID")),
      authToken: Redacted.make(required(env, "TWILIO_AUTH_TOKEN")),
      serviceSid: required(env, "TWILIO_VERIFY_SERVICE_SID").trim(),
    },
    whatsApp: {
      accessToken: Redacted.make(required(env, "WHATSAPP_ACCESS_TOKEN")),
      appSecret: Redacted.make(required(env, "WHATSAPP_APP_SECRET")),
      botUsername: required(env, "WHATSAPP_BOT_USERNAME").trim(),
      phoneNumberId: required(env, "WHATSAPP_PHONE_NUMBER_ID").trim(),
      publicPhoneNumber: required(env, "WHATSAPP_PUBLIC_PHONE_NUMBER").trim(),
      verifyToken: Redacted.make(required(env, "WHATSAPP_VERIFY_TOKEN")),
    },
  };
};

type RequiredBinding = Exclude<RawConfigBinding, "OSFO_STAGE">;

const required = (env: CloudflareEnv, binding: RequiredBinding): string => {
  const value = env[binding];
  return value === undefined || value.trim().length === 0
    ? invalid(`${binding} is required`)
    : value;
};

const parseUrl = (binding: string, value: string): URL => {
  if (!URL.canParse(value)) invalid(`${binding} must contain a URL`);
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    invalid(`${binding} must contain a URL`);
  }
  return url;
};

const parseTrustedOrigins = (value: string): ReadonlyArray<string> => {
  const parsed = Schema.decodeOption(TrustedOrigins)(value);
  return Option.match(parsed, {
    onNone: () => invalid("BETTER_AUTH_TRUSTED_ORIGINS must contain a URL"),
    onSome: (origins) =>
      origins.length === 0
        ? invalid("BETTER_AUTH_TRUSTED_ORIGINS must contain a URL")
        : origins.map((origin) => parseUrl("BETTER_AUTH_TRUSTED_ORIGINS", origin.href).origin),
  });
};

const selectTrustedOrigins = (
  stage: OsfoStage,
  baseURL: URL,
  configuredOrigins: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  stage === "production" && baseURL.origin === productionApiOrigin
    ? [productionWebOrigin]
    : configuredOrigins;

const invalid = (message: string): never => {
  throw new WorkerConfigurationError({
    message: `Worker configuration is invalid: ${message}`,
  });
};
