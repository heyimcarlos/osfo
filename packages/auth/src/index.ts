import type { Database } from "@osfo/db";
import * as authSchema from "@osfo/db/schema/auth";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber, type PhoneNumberOptions } from "better-auth/plugins/phone-number";

/** Runtime dependencies and trusted configuration for one Better Auth instance. */
export interface AuthOptions {
  readonly baseURL: string;
  readonly database: Database;
  readonly secret: string;
  readonly sendOTP: PhoneNumberOptions["sendOTP"];
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly verifyOTP: NonNullable<PhoneNumberOptions["verifyOTP"]>;
}

/** Create Better Auth for one request-scoped PostgreSQL connection. */
export const createAuth = (options: AuthOptions): ReturnType<typeof betterAuth> =>
  betterAuth(makeOptions(options));

/** Better Auth instance created for one request-scoped database. */
export type Auth = ReturnType<typeof createAuth>;

/** Session shape produced by the Osfo Better Auth policy. */
export type Session = Auth["$Infer"]["Session"];

const makeOptions = (options: AuthOptions): BetterAuthOptions => ({
  account: { modelName: "accounts" },
  baseURL: options.baseURL,
  database: drizzleAdapter(options.database, {
    provider: "pg",
    schema: authSchema,
    transaction: true,
  }),
  rateLimit: {
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
    phoneNumber({
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

const isE164PhoneNumber = (value: string) => /^\+[1-9]\d{7,14}$/.test(value);

const temporaryEmail = (value: string) => `${value.slice(1)}@phone-user.osfo.invalid`;
