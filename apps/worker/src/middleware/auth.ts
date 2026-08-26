import { AccountDeletionAuth, AccountDeletionCaller, AccountDeletionRequest } from "@osfo/api";
import {
  Auth,
  AuthenticationUnavailable,
  CurrentUser,
  Unauthorized,
} from "@osfo/api/middleware/auth";
import { getSessionCookie } from "better-auth/cookies";
import { Crypto, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import { WorkerAuth } from "../auth";
import { AccountAccess } from "../composition/account-access";
import { AccountAuthorities } from "../composition/account-authorities";
import { replayApproval } from "../composition/account-deletion-request";
import { Db } from "../db";
import { UserId } from "../domain";
import { TwilioVerify } from "../integrations/twilio/verify";
import { DeletionCase } from "../services/deletion-case";

/* oxlint-disable eslint/no-underscore-dangle -- Domain callers and outcomes use the _tag discriminator. */

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

/** Authorize the destructive endpoint through a current session or one exact retained replay. */
export const accountDeletionLayer = (config: WorkerAuth.AuthRouteConfig) =>
  Layer.effect(
    AccountDeletionAuth,
    Effect.gen(function* () {
      const db = yield* Db.Service;
      const twilio = yield* TwilioVerify.Service;
      const crypto = yield* Crypto.Crypto;
      return AccountDeletionAuth.of((effect, _options) =>
        Effect.provideServiceEffect(
          effect,
          AccountDeletionCaller,
          accountDeletionCaller(config).pipe(
            Effect.provideService(Db.Service, db),
            Effect.provideService(TwilioVerify.Service, twilio),
            Effect.provideService(Crypto.Crypto, crypto),
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

const accountDeletionCaller = (config: WorkerAuth.AuthRouteConfig) =>
  currentUser(config).pipe(
    Effect.map((user) => AccountDeletionCaller.of({ _tag: "CurrentUser", ...user })),
    Effect.catchTag("Unauthorized", () => retainedDeletionReplay),
  );

const retainedDeletionReplay = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const source = request.source;
  if (!(source instanceof Request)) return yield* new Unauthorized({});
  const replaySessionCookie = getSessionCookie(source.headers);
  if (replaySessionCookie === null) return yield* new Unauthorized({});
  const payload = yield* Effect.tryPromise({
    try: () => source.clone().json(),
    catch: () => new Unauthorized({}),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AccountDeletionRequest)),
    Effect.mapError(() => new Unauthorized({})),
  );
  const approval = replayApproval(payload);
  if (Option.isNone(approval)) return yield* new Unauthorized({});
  const crypto = yield* Crypto.Crypto;
  const replaySessionCookieHash = yield* DeletionCase.hashReplaySessionCookie(
    crypto,
    Redacted.make(replaySessionCookie),
  ).pipe(
    Effect.mapError(
      () =>
        new AuthenticationUnavailable({
          message: "Authentication is temporarily unavailable",
        }),
    ),
  );
  const authorities = yield* AccountAuthorities.make;
  const authenticated = yield* authorities.deletionCases
    .authenticateSelfReplay({ ...approval.value, replaySessionCookieHash })
    .pipe(
      Effect.mapError(
        () =>
          new AuthenticationUnavailable({
            message: "Authentication is temporarily unavailable",
          }),
      ),
    );
  if (authenticated._tag === "Denied") return yield* new Unauthorized({});
  return AccountDeletionCaller.of({ _tag: "RetainedReplay", userId: authenticated.userId });
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
