import type { Database } from "@osfo/db";
import * as authSchema from "@osfo/db/schema/auth";
import { dash } from "@better-auth/infra";
import { APIError, betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber, type PhoneNumberOptions } from "better-auth/plugins/phone-number";

/** Runtime dependencies and trusted configuration for one Better Auth instance. */
export interface AuthOptions {
  readonly baseURL: string;
  readonly database: Database;
  readonly dashboard: DashboardOptions;
  readonly google: { readonly clientId: string; readonly clientSecret: string };
  readonly secret: string;
  readonly sendOTP: PhoneNumberOptions["sendOTP"];
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly verifyOTP: NonNullable<PhoneNumberOptions["verifyOTP"]>;
}

/** Better Auth Dashboard policy for one auth instance. */
export type DashboardOptions =
  | { readonly kind: "disabled" }
  | { readonly apiKey: string; readonly kind: "enabled" };

/** Create Better Auth for one request-scoped PostgreSQL connection. */
export const createAuth = (options: AuthOptions): ReturnType<typeof betterAuth> =>
  betterAuth(makeOptions(options));

/** Better Auth instance created for one request-scoped database. */
export type Auth = ReturnType<typeof createAuth>;

/** Session shape produced by the Osfo Better Auth policy. */
export type Session = Auth["$Infer"]["Session"];

const makeOptions = (options: AuthOptions): BetterAuthOptions => ({
  account: {
    accountLinking: {
      allowDifferentEmails: true,
      enabled: true,
      trustedProviders: ["google"],
    },
    modelName: "accounts",
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: "lax",
      secure: options.baseURL.startsWith("https://"),
    },
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
  },
  baseURL: options.baseURL,
  basePath: "/auth",
  database: drizzleAdapter(options.database, {
    provider: "pg",
    schema: authSchema,
    transaction: true,
  }),
  // Temporary test entrypoint. Osfo v1 launch remains phone-only.
  emailAndPassword: { enabled: true },
  hooks: {
    // oxlint-disable-next-line effecttsgo/async-function -- Better Auth middleware requires a Promise-returning callback.
    before: createAuthMiddleware(async (context) => {
      if (context.path === "/sign-in/social" && context.body?.provider === "google") {
        throw new APIError("BAD_REQUEST", {
          message: "Google is available only for authenticated Gmail account linking",
        });
      }
    }),
  },
  rateLimit: {
    customRules: {
      "/phone-number/send-otp": { max: 5, window: 60 * 60 },
      "/phone-number/verify": { max: 5, window: 10 * 60 },
    },
    enabled: true,
    modelName: "rate_limits",
    storage: "database",
  },
  secret: options.secret,
  socialProviders: {
    google: {
      accessType: "offline",
      clientId: options.google.clientId,
      clientSecret: options.google.clientSecret,
      prompt: "select_account consent",
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    },
  },
  session: { modelName: "sessions" },
  trustedOrigins: [...options.trustedOrigins],
  user: {
    additionalFields: {
      registrationCompletedAt: {
        input: false,
        required: false,
        type: "date",
      },
    },
    modelName: "users",
  },
  verification: { modelName: "verifications" },
  plugins: [
    ...dashboardPlugins(options.dashboard),
    phoneNumber({
      allowedAttempts: 5,
      expiresIn: 10 * 60,
      otpLength: 6,
      phoneNumberValidator: isE164PhoneNumber,
      requireVerification: true,
      sendOTP: options.sendOTP,
      signUpOnVerification: {
        getTempEmail: temporaryEmail,
        getTempName: () => "Osfo User",
      },
      verifyOTP: options.verifyOTP,
    }),
  ],
});

const dashboardPlugins = (options: DashboardOptions) =>
  options.kind === "enabled" ? [dash({ apiKey: options.apiKey })] : [];

const isE164PhoneNumber = (value: string) => /^\+[1-9]\d{7,14}$/.test(value);

const temporaryEmail = (value: string) => `${value.slice(1)}@phone-user.osfo.invalid`;
