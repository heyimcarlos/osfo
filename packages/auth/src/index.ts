import type { Database } from "@osfo/db";
import * as authSchema from "@osfo/db/schema/auth";
import { dash } from "@better-auth/infra";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { phoneNumber, type PhoneNumberOptions } from "better-auth/plugins/phone-number";

/** Runtime dependencies and trusted configuration for one Better Auth instance. */
export interface AuthOptions {
  readonly baseURL: string;
  readonly canCreateSession: (userId: string) => Promise<boolean>;
  readonly database: Database;
  readonly dashboard: DashboardOptions;
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
  account: { modelName: "accounts" },
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
  databaseHooks: {
    session: {
      create: {
        // oxlint-disable-next-line effecttsgo/async-function -- Better Auth owns this Promise hook boundary.
        before: async (session) => {
          if (!(await options.canCreateSession(session.userId))) {
            // Better Auth requires APIError to stop its framework-owned session transaction.
            throw new APIError("FORBIDDEN", {
              message: "Account access requires manual support.",
            });
          }
          return { data: session };
        },
      },
    },
  },
  emailAndPassword: { enabled: false },
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
