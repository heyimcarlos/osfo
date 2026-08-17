import { createAuth } from "@osfo/auth";
import { Effect, type Layer, Redacted } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { handleAuthRequest } from "./cors";
import * as Db from "./db";
import { TwilioVerify } from "./integrations/twilio/verify";
import * as DeletionCasePostgres from "./integrations/postgres/deletion-case";
import * as UserSuspensionPostgres from "./integrations/postgres/user-suspension";
import { UserId } from "./domain";
import * as AccountAccess from "./services/account-access";

/** Trusted Better Auth configuration parsed from Worker bindings. */
export interface AuthRouteConfig {
  readonly baseURL: string;
  readonly dashboard:
    | { readonly kind: "disabled" }
    | { readonly apiKey: Redacted.Redacted; readonly kind: "enabled" };
  readonly secret: Redacted.Redacted;
  readonly trustedOrigins: ReadonlyArray<string>;
}

/** Request-scoped dependencies used only when an authentication route matches. */
export type AuthDependencies = Layer.Layer<Db.Db | TwilioVerify>;

/** Authentication route construction options. */
export interface Options {
  readonly config: AuthRouteConfig;
  readonly dependencies: AuthDependencies;
}

/** Better Auth routes backed by request-scoped Postgres and Twilio Verify. */
export const layer = (options: Options) => {
  const handler = Effect.gen(function* () {
    const auth = yield* make(options.config);

    return yield* HttpEffect.fromWebHandler((request) =>
      handleAuthRequest(request, auth.handler, options.config.trustedOrigins),
    );
  });

  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The auth route owns this request-scoped resource boundary.
  return HttpRouter.add("*", "/auth/*", handler.pipe(Effect.provide(options.dependencies)));
};

/** Build Better Auth from the current request-scoped Worker dependencies. */
export const make = (config: AuthRouteConfig) =>
  Effect.gen(function* () {
    const database = yield* Db.database;
    const deletionCases = yield* DeletionCasePostgres.make;
    const userSuspensions = yield* UserSuspensionPostgres.make;
    const twilio = yield* TwilioVerify;
    const context = yield* Effect.context();
    const runPromise = Effect.runPromiseWith(context);

    return createAuth({
      baseURL: config.baseURL,
      canCreateSession: (userId) =>
        runPromise(AccountAccess.canAccess(userSuspensions, deletionCases, UserId.make(userId))),
      database,
      dashboard:
        config.dashboard.kind === "enabled"
          ? {
              apiKey: Redacted.value(config.dashboard.apiKey),
              kind: "enabled",
            }
          : { kind: "disabled" },
      secret: Redacted.value(config.secret),
      sendOTP: ({ phoneNumber }) => runPromise(twilio.sendCode(phoneNumber)),
      trustedOrigins: config.trustedOrigins,
      verifyOTP: ({ code, phoneNumber }) =>
        runPromise(twilio.verifyCode(phoneNumber, Redacted.make(code))),
    });
  });
