import {
  Auth,
  AuthenticationUnavailable,
  CurrentUser,
  Unauthorized,
} from "@osfo/api/middleware/auth";
import { Effect, Layer, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import { WorkerAuth } from "../auth";
import { AccountAccess } from "../composition/account-access";
import { Db } from "../db";
import { UserId } from "../domain";
import { TwilioVerify } from "../integrations/twilio/verify";

/** Authenticate protected product endpoints through Better Auth. */
export const layer = (config: WorkerAuth.AuthRouteConfig) =>
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const db = yield* Db.Service;
      const twilio = yield* TwilioVerify.Service;

      return Auth.of((effect, _options) =>
        Effect.provideServiceEffect(
          effect,
          CurrentUser,
          currentUser(config).pipe(
            Effect.provideService(Db.Service, db),
            Effect.provideService(TwilioVerify.Service, twilio),
          ),
        ),
      );
    }),
  );

/** Read the current valid Better Auth User and Session for a protected HTTP effect. */
export const currentUser = (config: WorkerAuth.AuthRouteConfig) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const canAccess = yield* AccountAccess.make;
    const auth = yield* WorkerAuth.make(config, canAccess);
    const session = yield* Effect.tryPromise({
      try: () => auth.api.getSession({ headers: new Headers(request.headers) }),
      catch: () =>
        new AuthenticationUnavailable({
          message: "Authentication is temporarily unavailable",
        }),
    });
    if (session === null) return yield* new Unauthorized({});
    const hasAccess = yield* canAccess(UserId.make(session.user.id)).pipe(
      Effect.mapError(
        () =>
          new AuthenticationUnavailable({
            message: "Authentication is temporarily unavailable",
          }),
      ),
    );
    if (!hasAccess) return yield* new Unauthorized({});
    return CurrentUser.of({
      authSessionExpiresAt: session.session.expiresAt,
      authSessionId: session.session.id,
      userId: session.user.id,
    });
  });

/** Expected denial when no current session can authorize a document download. */
export class DocumentDownloadUnauthorized extends Schema.TaggedError<DocumentDownloadUnauthorized>()(
  "DocumentDownloadUnauthorized",
  {},
) {}

/** Expected outage while loading current authorization for a document download. */
export class DocumentDownloadAuthorizationUnavailable extends Schema.TaggedError<DocumentDownloadAuthorizationUnavailable>()(
  "DocumentDownloadAuthorizationUnavailable",
  {},
) {}

/** Project current HTTP authorization facts into document-download-specific typed outcomes. */
export const currentDownloadUser = (config: WorkerAuth.AuthRouteConfig) =>
  currentUser(config).pipe(
    Effect.catchTags({
      AuthenticationUnavailable: () => new DocumentDownloadAuthorizationUnavailable({}),
      Unauthorized: () => new DocumentDownloadUnauthorized({}),
    }),
  );

export * as AuthMiddleware from "./auth";
