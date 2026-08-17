import { createAuth } from "@osfo/auth";
import { Effect, type Layer, Redacted } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { handleAuthRequest } from "./cors";
import * as AccountAccess from "./composition/account-access";
import * as Db from "./db";
import { UserId } from "./domain";
import { TwilioVerify } from "./integrations/twilio/verify";

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
    const canAccess = yield* AccountAccess.make;
    const auth = yield* make(options.config, canAccess);

    return yield* HttpEffect.fromWebHandler((request) =>
      handleAuthRequest(request, auth.handler, options.config.trustedOrigins),
    );
  });

  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The auth route owns this request-scoped resource boundary.
  return HttpRouter.add("*", "/auth/*", handler.pipe(Effect.provide(options.dependencies)));
};

/** Build Better Auth from the current request-scoped Worker dependencies. */
export const make = (config: AuthRouteConfig, canAccess: AccountAccess.Check) =>
  Effect.gen(function* () {
    const database = yield* Db.database;
    const twilio = yield* TwilioVerify;
    const context = yield* Effect.context();
    const runPromise = Effect.runPromiseWith(context);
    return createAuth({
      baseURL: config.baseURL,
      canCreateSession: (userId) => runPromise(canAccess(UserId.make(userId))),
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
