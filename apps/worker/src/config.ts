import { Option, Redacted, Schema } from "effect";

import type { Browser } from "./services/browser-host";

import { launchModelAccessPolicy, ManagedModelRoute } from "./domain/model-access-policy";

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
  | "BETTER_AUTH_API_URL"
  | "BETTER_AUTH_BASE_URL"
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_TRUSTED_ORIGINS"
  | "COMPANY_CONVERSATION_DAILY_TURN_LIMIT"
  | "COMPANY_CONVERSATION_MODEL"
  | "COMPANY_CONVERSATION_PUBLIC_SEARCH_DAILY_LIMIT"
  | "BROWSER_HOST_ENDPOINT"
  | "BROWSER_HOST_OWNER_USER_ID"
  | "BROWSER_HOST_SESSION_ID"
  | "BROWSER_HOST_TOKEN"
  | "COMPOSIO_API_KEY"
  | "INTEGRATION_PROVIDER_BASE_URL"
  | "OSFO_STAGE"
  | "RESEARCH_REPORT_PROVIDER_BASE_URL"
  | "STRIPE_ADVENTURER_PRICE_ID"
  | "STRIPE_ADVENTURER_PRODUCT_ID"
  | "STRIPE_API_BASE_URL"
  | "STRIPE_PORTAL_CONFIGURATION_ID"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "SUPERMEMORY_API_BASE_URL"
  | "SUPERMEMORY_API_KEY"
  | "TELEGRAM_API_BASE_URL"
  | "TELEGRAM_BOT_TOKEN"
  | "TELEGRAM_BOT_USERNAME"
  | "TELEGRAM_WEBHOOK_SECRET_TOKEN"
  | "TWILIO_ACCOUNT_SID"
  | "TWILIO_AUTH_TOKEN"
  | "TWILIO_VERIFY_API_BASE_URL"
  | "TWILIO_VERIFY_SERVICE_SID"
  | "WHATSAPP_ACCESS_TOKEN"
  | "WHATSAPP_API_BASE_URL"
  | "WHATSAPP_APP_SECRET"
  | "WHATSAPP_BOT_USERNAME"
  | "WHATSAPP_PHONE_NUMBER_ID"
  | "WHATSAPP_VERIFY_TOKEN"
  | "WHATSAPP_WAKEUP_TEMPLATE_APPROVAL"
  | "WHATSAPP_WAKEUP_TEMPLATE_NAME"
  | "WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION";

type GeneratedCloudflareBindings = Omit<Env, RawConfigBinding>;

/** Generated Cloudflare bindings and raw Worker configuration values. */
export interface CloudflareEnv extends GeneratedCloudflareBindings {
  readonly BETTER_AUTH_API_KEY?: string;
  readonly BETTER_AUTH_API_URL?: string;
  readonly BETTER_AUTH_BASE_URL?: string;
  readonly BETTER_AUTH_SECRET?: string;
  readonly BETTER_AUTH_TRUSTED_ORIGINS?: string;
  readonly COMPANY_CONVERSATION_DAILY_TURN_LIMIT?: string;
  readonly COMPANY_CONVERSATION_MODEL?: string;
  readonly COMPANY_CONVERSATION_PUBLIC_SEARCH_DAILY_LIMIT?: string;
  readonly BROWSER_HOST_ENDPOINT?: string;
  readonly BROWSER_HOST_OWNER_USER_ID?: string;
  readonly BROWSER_HOST_SESSION_ID?: string;
  readonly BROWSER_HOST_TOKEN?: string;
  readonly COMPOSIO_API_KEY?: string;
  readonly INTEGRATION_PROVIDER_BASE_URL?: string;
  readonly OSFO_STAGE?: string;
  readonly RESEARCH_REPORT_PROVIDER_BASE_URL?: string;
  readonly STRIPE_ADVENTURER_PRICE_ID?: string;
  readonly STRIPE_ADVENTURER_PRODUCT_ID?: string;
  readonly STRIPE_API_BASE_URL?: string;
  readonly STRIPE_PORTAL_CONFIGURATION_ID?: string;
  readonly STRIPE_SECRET_KEY?: string;
  readonly STRIPE_WEBHOOK_SECRET?: string;
  readonly SUPERMEMORY_API_BASE_URL?: string;
  readonly SUPERMEMORY_API_KEY?: string;
  readonly TELEGRAM_API_BASE_URL?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TELEGRAM_BOT_USERNAME?: string;
  readonly TELEGRAM_WEBHOOK_SECRET_TOKEN?: string;
  readonly TWILIO_ACCOUNT_SID?: string;
  readonly TWILIO_AUTH_TOKEN?: string;
  readonly TWILIO_VERIFY_API_BASE_URL?: string;
  readonly TWILIO_VERIFY_SERVICE_SID?: string;
  readonly WHATSAPP_ACCESS_TOKEN?: string;
  readonly WHATSAPP_API_BASE_URL?: string;
  readonly WHATSAPP_APP_SECRET?: string;
  readonly WHATSAPP_BOT_USERNAME?: string;
  readonly WHATSAPP_PHONE_NUMBER_ID?: string;
  readonly WHATSAPP_VERIFY_TOKEN?: string;
  readonly WHATSAPP_WAKEUP_TEMPLATE_APPROVAL?: string;
  readonly WHATSAPP_WAKEUP_TEMPLATE_NAME?: string;
  readonly WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION?: string;
}

/** Better Auth and dashboard configuration. */
export interface AuthConfig {
  readonly baseURL: string;
  readonly credentialAuthentication: "disabled" | "enabled";
  readonly dashboard:
    | { readonly kind: "disabled" }
    | {
        readonly apiKey: Redacted.Redacted;
        readonly apiUrl?: string | undefined;
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
  readonly apiBaseURL?: string | undefined;
  readonly appSecret: Redacted.Redacted;
  readonly botUsername: string;
  readonly phoneNumberId: string;
  readonly verifyToken: Redacted.Redacted;
  readonly wakeUp:
    | { readonly _tag: "Inactive" }
    | {
        readonly _tag: "Active";
        readonly templateName: string;
        readonly templatePolicyVersion: "whatsapp-wakeup-v1";
      };
}

/** Stripe billing configuration. */
export interface StripeConfig {
  readonly adventurerPriceId: string;
  readonly adventurerProductId: string;
  /** API origin override for emulated or proxied Stripe deployments. */
  readonly apiBaseURL?: string | undefined;
  readonly portalConfigurationId: string;
  readonly secretKey: Redacted.Redacted;
  readonly webhookSecret: Redacted.Redacted;
}

/** Supermemory Knowledge Base configuration. */
export interface SupermemoryConfig {
  /** API origin override for emulated or proxied Supermemory deployments. */
  readonly apiBaseURL?: string | undefined;
  /** Admin-role key required to upsert an empty User container before first ingestion. */
  readonly apiKey: Redacted.Redacted;
}

/** Telegram linking and delivery configuration. */
export interface TelegramConfig {
  /** API origin override for emulated or proxied Telegram Bot API deployments. */
  readonly apiBaseURL?: string | undefined;
  readonly botToken: Redacted.Redacted;
  readonly botUsername: string;
  readonly webhookSecret: Redacted.Redacted;
}

/** Twilio Verify configuration. */
export interface TwilioVerifyConfig {
  readonly accountSid: Redacted.Redacted;
  readonly authToken: Redacted.Redacted;
  /** API origin override for emulated or proxied Verify deployments. */
  readonly apiBaseURL?: string | undefined;
  readonly serviceSid: string;
}

/** Bounded envelope configuration for the pre-registration Company Conversation. */
export interface CompanyConversationConfig {
  /** Optional per-address daily model-turn ceiling; null disables the ceiling. */
  readonly dailyTurnLimit: number | null;
  /** Fixed Workers AI route served by every company conversation facet. */
  readonly modelRoute: ManagedModelRoute;
  /** Optional per-address daily public-search ceiling; null disables search. */
  readonly publicSearchDailyLimit: number | null;
}

/** Optional Composio Platform configuration for approved direct integrations. */
export interface ComposioConfig {
  readonly apiKey: Redacted.Redacted;
}

/** Dedicated provider selection for bounded Research Report execution. */
export type ResearchReportProviderConfig =
  | { readonly _tag: "Cloudflare" }
  | { readonly _tag: "LocalVerification"; readonly baseURL: string };

/** Provider selection for approved direct integrations. */
export type IntegrationProviderConfig =
  | { readonly _tag: "Composio"; readonly config: ComposioConfig | null }
  | { readonly _tag: "LocalVerification"; readonly baseURL: string };

/** Parsed configuration used by one request application. */
export interface CloudflareConfig {
  readonly browserHost: Browser.Binding | null;
  readonly auth: AuthConfig;
  readonly companyConversation: CompanyConversationConfig;
  readonly composio: ComposioConfig | null;
  readonly integrationProvider: IntegrationProviderConfig;
  readonly researchReportProvider: ResearchReportProviderConfig;
  readonly stage: OsfoStage;
  readonly stripe: StripeConfig;
  readonly supermemory: SupermemoryConfig;
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

  return {
    browserHost: parseBrowserHost(stage, env),
    auth: {
      baseURL: baseURL.href,
      credentialAuthentication: "enabled",
      dashboard: {
        apiKey: Redacted.make(required(env, "BETTER_AUTH_API_KEY")),
        apiUrl: optionalUrl(env, "BETTER_AUTH_API_URL"),
        kind: "enabled",
      },
      secret: Redacted.make(secret),
      trustedOrigins,
    },
    companyConversation: {
      dailyTurnLimit: parseOptionalPositiveInt(
        "COMPANY_CONVERSATION_DAILY_TURN_LIMIT",
        env.COMPANY_CONVERSATION_DAILY_TURN_LIMIT,
      ),
      modelRoute: Option.getOrElse(
        Schema.decodeOption(ManagedModelRoute)(
          env.COMPANY_CONVERSATION_MODEL ?? launchModelAccessPolicy.plans.free.route,
        ),
        () => launchModelAccessPolicy.plans.free.route,
      ),
      publicSearchDailyLimit: parseOptionalPositiveInt(
        "COMPANY_CONVERSATION_PUBLIC_SEARCH_DAILY_LIMIT",
        env.COMPANY_CONVERSATION_PUBLIC_SEARCH_DAILY_LIMIT,
      ),
    },
    composio:
      env.COMPOSIO_API_KEY === undefined || env.COMPOSIO_API_KEY.trim().length === 0
        ? null
        : { apiKey: Redacted.make(env.COMPOSIO_API_KEY) },
    integrationProvider: parseIntegrationProvider(stage, env),
    researchReportProvider: parseResearchReportProvider(stage, env),
    stage,
    stripe: {
      adventurerPriceId: required(env, "STRIPE_ADVENTURER_PRICE_ID").trim(),
      adventurerProductId: required(env, "STRIPE_ADVENTURER_PRODUCT_ID").trim(),
      apiBaseURL: optionalUrl(env, "STRIPE_API_BASE_URL"),
      portalConfigurationId: required(env, "STRIPE_PORTAL_CONFIGURATION_ID").trim(),
      secretKey: Redacted.make(required(env, "STRIPE_SECRET_KEY")),
      webhookSecret: Redacted.make(required(env, "STRIPE_WEBHOOK_SECRET")),
    },
    supermemory: {
      apiBaseURL: optionalUrl(env, "SUPERMEMORY_API_BASE_URL"),
      apiKey: Redacted.make(required(env, "SUPERMEMORY_API_KEY")),
    },
    telegram: {
      apiBaseURL: optionalUrl(env, "TELEGRAM_API_BASE_URL"),
      botToken: Redacted.make(required(env, "TELEGRAM_BOT_TOKEN")),
      botUsername: required(env, "TELEGRAM_BOT_USERNAME").trim(),
      webhookSecret: Redacted.make(required(env, "TELEGRAM_WEBHOOK_SECRET_TOKEN")),
    },
    twilioVerify: {
      accountSid: Redacted.make(required(env, "TWILIO_ACCOUNT_SID")),
      apiBaseURL: optionalUrl(env, "TWILIO_VERIFY_API_BASE_URL"),
      authToken: Redacted.make(required(env, "TWILIO_AUTH_TOKEN")),
      serviceSid: required(env, "TWILIO_VERIFY_SERVICE_SID").trim(),
    },
    whatsApp: {
      accessToken: Redacted.make(required(env, "WHATSAPP_ACCESS_TOKEN")),
      apiBaseURL: optionalUrl(env, "WHATSAPP_API_BASE_URL"),
      appSecret: Redacted.make(required(env, "WHATSAPP_APP_SECRET")),
      botUsername: required(env, "WHATSAPP_BOT_USERNAME").trim(),
      phoneNumberId: required(env, "WHATSAPP_PHONE_NUMBER_ID").trim(),
      verifyToken: Redacted.make(required(env, "WHATSAPP_VERIFY_TOKEN")),
      wakeUp: parseWhatsAppWakeUp(env),
    },
  };
};

type RequiredBinding = Exclude<
  RawConfigBinding,
  | "BETTER_AUTH_API_URL"
  | "COMPOSIO_API_KEY"
  | "INTEGRATION_PROVIDER_BASE_URL"
  | "OSFO_STAGE"
  | "RESEARCH_REPORT_PROVIDER_BASE_URL"
  | "STRIPE_API_BASE_URL"
  | "SUPERMEMORY_API_BASE_URL"
  | "TELEGRAM_API_BASE_URL"
  | "TWILIO_VERIFY_API_BASE_URL"
  | "WHATSAPP_API_BASE_URL"
  | "WHATSAPP_WAKEUP_TEMPLATE_APPROVAL"
  | "WHATSAPP_WAKEUP_TEMPLATE_NAME"
  | "WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION"
>;

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

const parseOptionalPositiveInt = (binding: string, value: string | undefined): number | null => {
  if (value === undefined || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : invalid(`${binding} must contain a positive integer`);
};

const optionalUrl = (
  env: CloudflareEnv,
  binding:
    | "BETTER_AUTH_API_URL"
    | "STRIPE_API_BASE_URL"
    | "SUPERMEMORY_API_BASE_URL"
    | "TELEGRAM_API_BASE_URL"
    | "TWILIO_VERIFY_API_BASE_URL"
    | "WHATSAPP_API_BASE_URL",
): string | undefined => {
  const value = env[binding];
  return value === undefined || value.trim().length === 0
    ? undefined
    : parseUrl(binding, value).href;
};

const parseWhatsAppWakeUp = (env: CloudflareEnv): WhatsAppConfig["wakeUp"] => {
  const templateName = env.WHATSAPP_WAKEUP_TEMPLATE_NAME?.trim();
  const policyVersion = env.WHATSAPP_WAKEUP_TEMPLATE_POLICY_VERSION?.trim();
  const approval = env.WHATSAPP_WAKEUP_TEMPLATE_APPROVAL?.trim();
  if (
    templateName !== "osfo_update" ||
    policyVersion !== "whatsapp-wakeup-v1" ||
    approval !== `approved:${policyVersion}:${templateName}:en,es`
  ) {
    return { _tag: "Inactive" };
  }
  return { _tag: "Active", templateName, templatePolicyVersion: policyVersion };
};

const parseResearchReportProvider = (
  stage: OsfoStage,
  env: CloudflareEnv,
): ResearchReportProviderConfig => {
  const value = env.RESEARCH_REPORT_PROVIDER_BASE_URL?.trim();
  if (value === undefined || value.length === 0) return { _tag: "Cloudflare" };
  if (stage !== "development" && stage !== "test") {
    return invalid("RESEARCH_REPORT_PROVIDER_BASE_URL is restricted to local verification");
  }
  const baseURL = parseUrl("RESEARCH_REPORT_PROVIDER_BASE_URL", value);
  if (!loopbackHosts.has(baseURL.hostname)) {
    return invalid("RESEARCH_REPORT_PROVIDER_BASE_URL must use a loopback host");
  }
  return { _tag: "LocalVerification", baseURL: baseURL.href };
};

const parseIntegrationProvider = (
  stage: OsfoStage,
  env: CloudflareEnv,
): IntegrationProviderConfig => {
  const value = env.INTEGRATION_PROVIDER_BASE_URL?.trim();
  const composio =
    env.COMPOSIO_API_KEY === undefined || env.COMPOSIO_API_KEY.trim().length === 0
      ? null
      : { apiKey: Redacted.make(env.COMPOSIO_API_KEY) };
  if (value === undefined || value.length === 0) {
    if (stage === "production" && composio === null) {
      return invalid("COMPOSIO_API_KEY is required in production");
    }
    return { _tag: "Composio", config: composio };
  }
  if (composio !== null) {
    return invalid("COMPOSIO_API_KEY cannot be configured with INTEGRATION_PROVIDER_BASE_URL");
  }
  if (stage !== "development" && stage !== "test") {
    return invalid("INTEGRATION_PROVIDER_BASE_URL is restricted to local verification");
  }
  const baseURL = parseUrl("INTEGRATION_PROVIDER_BASE_URL", value);
  if (!loopbackHosts.has(baseURL.hostname)) {
    return invalid("INTEGRATION_PROVIDER_BASE_URL must use a loopback host");
  }
  return { _tag: "LocalVerification", baseURL: baseURL.href };
};

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

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

/** Local opt-in only; a remote Worker has no provisioned desktop host by default. */
const parseBrowserHost = (stage: OsfoStage, env: CloudflareEnv): Browser.Binding | null => {
  if (stage !== "development" && stage !== "test") return null;
  const endpoint = env.BROWSER_HOST_ENDPOINT;
  const ownerUserId = env.BROWSER_HOST_OWNER_USER_ID;
  const hostSessionId = env.BROWSER_HOST_SESSION_ID;
  const token = env.BROWSER_HOST_TOKEN;
  if (
    endpoint !== "http://127.0.0.1:39270/inventory" ||
    ownerUserId === undefined ||
    ownerUserId.length === 0 ||
    ownerUserId.length > 200 ||
    hostSessionId === undefined ||
    hostSessionId.length === 0 ||
    hostSessionId.length > 200 ||
    token === undefined ||
    token.length < 32 ||
    token.length > 512
  )
    return null;
  return { endpoint, ownerUserId, hostSessionId, token: Redacted.make(token) };
};
