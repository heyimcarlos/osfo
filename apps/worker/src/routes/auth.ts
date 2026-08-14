import { createAuth } from "@osfo/auth";
import { Effect, type Layer, Redacted } from "effect";
import { HttpEffect, HttpRouter } from "effect/unstable/http";

import * as Db from "../db";
import { TwilioVerify } from "../integrations/twilio/verify";

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
      handleWithCors(request, auth.handler, options.config.trustedOrigins),
    );
  });

  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The auth route owns this request-scoped resource boundary.
  return HttpRouter.add("*", "/auth/*", handler.pipe(Effect.provide(options.dependencies)));
};

const dashboardOrigins = new Set(["https://better-auth.com", "https://dash.better-auth.com"]);
const allowedMethods = "GET, POST, PATCH, DELETE, OPTIONS";
const allowedHeaders = [
  "Content-Type",
  "Authorization",
  "X-Visitor-Id",
  "X-PoW-Solution",
  "X-Request-Id",
  "User-Agent",
].join(", ");
const exposedHeaders = "X-PoW-Challenge, X-PoW-Reason";

const handleWithCors = (
  request: Request,
  handler: (request: Request) => Promise<Response>,
  trustedOrigins: ReadonlyArray<string>,
): Promise<Response> => {
  const origin = request.headers.get("origin");
  const allowedOrigin =
    origin !== null && (trustedOrigins.includes(origin) || dashboardOrigins.has(origin))
      ? origin
      : undefined;

  if (request.method === "OPTIONS") {
    return Promise.resolve(withCorsHeaders(new Response(null, { status: 204 }), allowedOrigin));
  }

  return handler(request).then((response) => withCorsHeaders(response, allowedOrigin));
};

const withCorsHeaders = (response: Response, allowedOrigin: string | undefined): Response => {
  if (allowedOrigin === undefined) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-allow-headers", allowedHeaders);
  headers.set("access-control-allow-methods", allowedMethods);
  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("access-control-expose-headers", exposedHeaders);
  headers.append("vary", "Origin");

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
