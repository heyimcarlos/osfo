import { createAuth } from "@osfo/auth";
import { APIError } from "better-auth/api";
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { handleAuthRequest } from "./cors";
import * as AccountAccess from "./composition/account-access";
import * as Db from "./db";
import { UserId } from "./domain";
import { TwilioVerify } from "./integrations/twilio/verify";

/** Trusted Better Auth configuration parsed from Worker bindings. */
export interface AuthRouteConfig {
  readonly baseURL: string;
  readonly credentialAuthentication: "disabled" | "enabled";
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
  const makeRequestAuth = Effect.gen(function* () {
    const canAccess = yield* AccountAccess.make;
    return yield* make(options.config, canAccess);
  });

  const handler = Effect.gen(function* () {
    const auth = yield* makeRequestAuth;

    return yield* HttpEffect.fromWebHandler((request) =>
      handleAuthRequest(request, auth.handler, options.config.trustedOrigins),
    );
  });

  const setLoginCredentials = Effect.gen(function* () {
    const auth = yield* makeRequestAuth;
    return yield* HttpEffect.fromWebHandler((request) =>
      handleAuthRequest(
        request,
        (trustedRequest) => setLoginCredentialsRequest(auth, trustedRequest),
        options.config.trustedOrigins,
      ),
    );
  });

  const notFound = HttpServerResponse.jsonUnsafe({ error: "Not found" }, { status: 404 });

  return Layer.mergeAll(
    HttpRouter.add("POST", "/auth/set-login-credentials", setLoginCredentials),
    HttpRouter.add("POST", "/auth/change-email", notFound),
    HttpRouter.add("POST", "/auth/sign-in/phone-number", notFound),
    HttpRouter.add("POST", "/auth/phone-number/request-password-reset", notFound),
    HttpRouter.add("POST", "/auth/phone-number/reset-password", notFound),
    HttpRouter.add("*", "/auth/*", handler),
  ).pipe(HttpRouter.provideRequest(options.dependencies));
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
      credentialAuthentication: config.credentialAuthentication,
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

const SetLoginCredentialsRequest = Schema.Struct({
  email: Schema.String.check(
    Schema.makeFilter(
      (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) || "must be an email address",
    ),
  ),
  newPassword: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(128)),
});

// oxlint-disable-next-line effecttsgo/async-function -- Better Auth owns this Promise route boundary.
const setLoginCredentialsRequest = async (
  auth: Awaited<ReturnType<typeof createAuth>>,
  request: Request,
): Promise<Response> => {
  const body = await request.json().catch(() => undefined);
  const input = Option.getOrUndefined(Schema.decodeUnknownOption(SetLoginCredentialsRequest)(body));
  if (input === undefined) {
    return Response.json(
      { error: "Enter a valid email and a password between 8 and 128 characters." },
      { status: 400 },
    );
  }

  try {
    const linkedAccounts = await auth.api.listUserAccounts({ headers: request.headers });
    if (linkedAccounts.some((account) => account.providerId === "credential")) {
      return Response.json(
        { error: "A password is already configured for this account." },
        { status: 409 },
      );
    }
    await auth.api.changeEmail({
      body: { newEmail: input.email },
      headers: request.headers,
    });
    const currentSession = await auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    if (currentSession?.user.email !== input.email.toLowerCase()) {
      return Response.json(
        { error: "That email cannot be used for this account." },
        { status: 409 },
      );
    }
    await auth.api.setPassword({
      body: { newPassword: input.newPassword },
      headers: request.headers,
    });
    return Response.json({ status: "credentials-set" });
  } catch (error) {
    if (error instanceof APIError) {
      const alreadySet = error.body?.code === "PASSWORD_ALREADY_SET";
      return Response.json(
        {
          error: alreadySet
            ? "A password is already configured for this account."
            : "Sign in again by SMS before you set a password.",
        },
        { status: alreadySet ? 409 : error.statusCode },
      );
    }
    return Response.json(
      { error: "The password could not be configured right now." },
      { status: 503 },
    );
  }
};
