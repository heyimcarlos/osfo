import {
  Auth,
  AuthenticationUnavailable,
  CurrentUser,
  Unauthorized,
} from "@osfo/api/middleware/auth";
import { Effect, Layer } from "effect";
import { HttpServerRequest } from "effect/unstable/http";

import * as WorkerAuth from "../auth";
import * as AccountAccess from "../composition/account-access";
import * as Db from "../db";
import { UserId } from "../domain";
import { TwilioVerify } from "../integrations/twilio/verify";

/** Authenticate protected product endpoints through Better Auth. */
export const layer = (config: WorkerAuth.AuthRouteConfig) =>
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const twilio = yield* TwilioVerify;

      return Auth.of((effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const auth = yield* WorkerAuth.make(config);
          const session = yield* Effect.tryPromise({
            try: () => auth.api.getSession({ headers: new Headers(request.headers) }),
            catch: () =>
              new AuthenticationUnavailable({
                message: "Authentication is temporarily unavailable",
              }),
          });

          if (session === null) {
            return yield* new Unauthorized({});
          }

          const canAccess = yield* AccountAccess.make;
          const hasAccess = yield* canAccess(UserId.make(session.user.id)).pipe(
            Effect.mapError(
              () =>
                new AuthenticationUnavailable({
                  message: "Authentication is temporarily unavailable",
                }),
            ),
          );
          if (!hasAccess) return yield* new Unauthorized({});

          return yield* Effect.provideService(
            effect,
            CurrentUser,
            CurrentUser.of({ authSessionId: session.session.id, userId: session.user.id }),
          );
        }).pipe(Effect.provideService(Db.Db, db), Effect.provideService(TwilioVerify, twilio)),
      );
    }),
  );
