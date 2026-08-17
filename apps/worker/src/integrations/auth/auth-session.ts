import { createAuthSessionAuthority } from "@osfo/auth";
import { Effect, Layer, Schema } from "effect";

import * as Db from "../../db";
import { AuthSessionAuthorityFact } from "../../domain/auth-session";
import * as AuthSession from "../../services/auth-session";

/** Build the AuthSession Store adapter from the request-scoped @osfo/auth capability. */
export const make = Effect.gen(function* () {
  const database = yield* Db.database;
  const authority = createAuthSessionAuthority(database);
  return AuthSession.Store.of({
    inspect: (userId, authSessionId) =>
      Effect.tryPromise({
        try: () => authority.inspect(userId, authSessionId),
        catch: (cause) => unavailable("inspect", cause),
      }).pipe(
        Effect.flatMap((record) =>
          Schema.decodeEffect(AuthSessionAuthorityFact)(
            record === null
              ? { _tag: "RevokedAuthSession", authSessionId, userId }
              : { _tag: "AuthSession", authSessionId, expiresAt: record.expiresAt, userId },
          ).pipe(Effect.mapError((cause) => unavailable("inspect", cause))),
        ),
      ),
    revoke: (userId, authSessionId) =>
      Effect.tryPromise({
        try: () => authority.revoke(userId, authSessionId),
        catch: (cause) => unavailable("revoke", cause),
      }),
    revokeAll: (userId) =>
      Effect.tryPromise({
        try: () => authority.revokeAll(userId),
        catch: (cause) => unavailable("revokeAll", cause),
      }),
  });
});

/** AuthSession Store Layer backed by @osfo/auth. */
export const layerWithoutDependencies = Layer.effect(AuthSession.Store, make);

const unavailable = (operation: string, cause: unknown) =>
  new AuthSession.AuthSessionUnavailable({
    cause,
    message: `The AuthSession authority could not complete ${operation}`,
    operation,
  });
