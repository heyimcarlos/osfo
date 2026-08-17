import { createAuth, type AuthOptions } from "@osfo/auth";
import { DateTime, Effect, type Layer, Predicate, Redacted } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import { handleAuthRequest } from "./cors";
import * as Db from "./db";
import * as GmailDb from "./db/gmail";
import * as CurrentGmailAuthorization from "./db/gmail/authorization";
import { UserId } from "./domain";
import { retainedCatalog } from "./domain/plan-policy";
import { TwilioVerify } from "./integrations/twilio/verify";
import { make as makeAuthorization } from "./services/authorization";
import * as AuthorizationContextProjection from "./services/authorization-context";
import { makeConnectionControl } from "./services/gmail";

/** Trusted Better Auth configuration parsed from Worker bindings. */
export interface AuthRouteConfig {
  readonly baseURL: string;
  readonly dashboard:
    | { readonly kind: "disabled" }
    | { readonly apiKey: Redacted.Redacted; readonly kind: "enabled" };
  readonly secret: Redacted.Redacted;
  readonly google: {
    readonly clientId: string;
    readonly clientSecret: Redacted.Redacted;
  };
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
    const twilio = yield* TwilioVerify;
    const context = yield* Effect.context();
    const runPromise = Effect.runPromiseWith(context);
    const loadGmailConnectionControl = (
      identity: Parameters<
        Extract<AuthOptions["google"], { readonly kind: "gmailLinking" }>["onAccountLinked"]
      >[0],
    ) =>
      DateTime.now.pipe(
        Effect.map(DateTime.toDateUtc),
        Effect.flatMap((now) => {
          const userId = UserId.make(identity.userId);
          const origin = {
            _tag: "AuthSession" as const,
            authSessionId: identity.authSessionId,
          };
          return CurrentGmailAuthorization.loadInitial(database, userId, origin, now).pipe(
            Effect.map(AuthorizationContextProjection.project),
            Effect.map((authorization) => ({
              authorization,
              gmail: makeConnectionControl({
                authorization: makeAuthorization(retainedCatalog),
                connections: GmailDb.make(database).connections,
              }),
            })),
          );
        }),
      );

    return createAuth({
      baseURL: config.baseURL,
      database,
      dashboard:
        config.dashboard.kind === "enabled"
          ? {
              apiKey: Redacted.value(config.dashboard.apiKey),
              kind: "enabled",
            }
          : { kind: "disabled" },
      secret: Redacted.value(config.secret),
      google: {
        authorizeAccountLink: (identity) =>
          runPromise(
            loadGmailConnectionControl(identity).pipe(
              Effect.map(({ authorization, gmail }) => gmail.authorizeConnect(authorization)),
              Effect.map((result) =>
                Predicate.isTagged(result, "Admitted")
                  ? ("allowed" as const)
                  : ("connectionDenied" as const),
              ),
            ),
          ),
        clientId: config.google.clientId,
        clientSecret: Redacted.value(config.google.clientSecret),
        kind: "gmailLinking",
        onAccountLinked: (identity) =>
          runPromise(
            loadGmailConnectionControl(identity).pipe(
              Effect.flatMap(({ authorization, gmail }) => gmail.completeOAuth(authorization)),
              Effect.map((result) =>
                Predicate.isTagged(result, "Denied") ||
                Predicate.isTagged(result, "ApprovalRequired")
                  ? ("connectionDenied" as const)
                  : ("connected" as const),
              ),
              Effect.catchTag("GmailConnectionConflict", () =>
                Effect.succeed("connectionConflict" as const),
              ),
            ),
          ),
      },
      sendOTP: ({ phoneNumber }) => runPromise(twilio.sendCode(phoneNumber)),
      trustedOrigins: config.trustedOrigins,
      verifyOTP: ({ code, phoneNumber }) => runPromise(twilio.verifyCode(phoneNumber, code)),
    });
  });
