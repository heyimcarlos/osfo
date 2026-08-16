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
const WhatsAppPhoneNumber = Schema.String.check(
  Schema.makeFilter(
    (value) => /^[1-9]\d{7,14}$/u.test(value) || "must be an E.164 number without the plus sign",
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
  OSFO_STAGE: OsfoStage,
  TWILIO_ACCOUNT_SID: TwilioAccountSid,
  TWILIO_AUTH_TOKEN: TwilioAuthToken,
  TWILIO_VERIFY_SERVICE_SID: TwilioVerifyServiceSid,
  WHATSAPP_PHONE_NUMBER: WhatsAppPhoneNumber,
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
  readonly OSFO_STAGE?: string;
  readonly TWILIO_ACCOUNT_SID?: string;
  readonly TWILIO_AUTH_TOKEN?: string;
  readonly TWILIO_VERIFY_SERVICE_SID?: string;
  readonly WHATSAPP_PHONE_NUMBER?: string;
}

/** Decode and redact all Worker authentication configuration before use. */
export const decodeRuntimeConfig = (input: RuntimeConfigInput) =>
  Result.map(
    Schema.decodeUnknownResult(RawRuntimeConfig)(input),
    (raw): RuntimeConfig => ({
      auth: {
        baseURL: raw.BETTER_AUTH_BASE_URL.href,
        dashboard: {
          apiKey: Redacted.make(raw.BETTER_AUTH_API_KEY),
          kind: "enabled",
        },
        secret: Redacted.make(raw.BETTER_AUTH_SECRET),
        trustedOrigins: raw.BETTER_AUTH_TRUSTED_ORIGINS.map((origin) => origin.origin),
      },
      stage: raw.OSFO_STAGE,
      whatsApp: { phoneNumber: raw.WHATSAPP_PHONE_NUMBER },
      twilioVerify: {
        accountSid: Redacted.make(raw.TWILIO_ACCOUNT_SID),
        authToken: Redacted.make(raw.TWILIO_AUTH_TOKEN),
        serviceSid: raw.TWILIO_VERIFY_SERVICE_SID,
      },
    }),
  );
