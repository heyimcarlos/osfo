import { createAuth } from "@osfo/auth";
import { Effect, type Layer, Redacted } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { handleAuthRequest } from "./cors";
import * as Db from "./db";
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
    const database = yield* Db.database;
    const twilio = yield* TwilioVerify;
    const context = yield* Effect.context();
    const runPromise = Effect.runPromiseWith(context);
    const auth = createAuth({
      baseURL: options.config.baseURL,
      database,
      dashboard:
        options.config.dashboard.kind === "enabled"
          ? {
              apiKey: Redacted.value(options.config.dashboard.apiKey),
              kind: "enabled",
            }
          : { kind: "disabled" },
      secret: Redacted.value(options.config.secret),
      sendOTP: ({ phoneNumber }) => runPromise(twilio.sendCode(phoneNumber)),
      trustedOrigins: options.config.trustedOrigins,
      verifyOTP: ({ code, phoneNumber }) => runPromise(twilio.verifyCode(phoneNumber, code)),
    });

    return yield* HttpEffect.fromWebHandler((request) =>
      handleAuthRequest(request, auth.handler, options.config.trustedOrigins),
    );
  });

  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The auth route owns this request-scoped resource boundary.
  return HttpRouter.add("*", "/auth/*", handler.pipe(Effect.provide(options.dependencies)));
};
