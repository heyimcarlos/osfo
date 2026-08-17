import { Context, Effect, Layer, Schema } from "effect";

import { UserId } from "../domain";
import { type AuthSessionAuthorityFact, AuthSessionId } from "../domain/auth-session";

/** Safe failure when the Better Auth AuthSession authority is unavailable. */
export class AuthSessionUnavailable extends Schema.TaggedError<AuthSessionUnavailable>()(
  "AuthSessionUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Expected failure when an AuthSession belongs to another User. */
export class AuthSessionOwnershipMismatch extends Schema.TaggedError<AuthSessionOwnershipMismatch>()(
  "AuthSessionOwnershipMismatch",
  { authSessionId: AuthSessionId, message: Schema.String, userId: UserId },
) {}

/** Administrative AuthSession revocation command. */
export interface RevokeCommand {
  readonly authSessionId: AuthSessionId;
  readonly userId: UserId;
}

/** The selected AuthSession was revoked. */
export interface Revoked {
  readonly _tag: "AuthSessionRevoked";
  readonly authSessionId: AuthSessionId;
}

/** The selected AuthSession was already absent. */
export interface AlreadyRevoked {
  readonly _tag: "AuthSessionAlreadyRevoked";
  readonly authSessionId: AuthSessionId;
}

/** Narrow request-scoped Better Auth capability used by the AuthSession module. */
export interface StorePort {
  readonly inspect: (
    userId: UserId,
    authSessionId: AuthSessionId,
  ) => Effect.Effect<AuthSessionAuthorityFact, AuthSessionUnavailable>;
  readonly revoke: (
    userId: UserId,
    authSessionId: AuthSessionId,
  ) => Effect.Effect<"absent" | "revoked" | "wrong-user", AuthSessionUnavailable>;
  readonly revokeAll: (userId: UserId) => Effect.Effect<void, AuthSessionUnavailable>;
}

/** AuthSession storage capability supplied by the @osfo/auth adapter. */
export class Store extends Context.Service<Store, StorePort>()("@osfo/AuthSession/Store") {}

/** Public AuthSession authority owned by the AuthSession module. */
export interface Interface {
  readonly inspect: StorePort["inspect"];
  readonly revoke: (
    command: RevokeCommand,
  ) => Effect.Effect<
    AlreadyRevoked | Revoked,
    AuthSessionOwnershipMismatch | AuthSessionUnavailable
  >;
  readonly revokeAllForUser: StorePort["revokeAll"];
}

/** Trusted AuthSession authority. */
export class Service extends Context.Service<Service, Interface>()("@osfo/AuthSession") {}

/** Construct AuthSession authority from the request-scoped @osfo/auth capability. */
export const make = Effect.map(Store, (store) =>
  Service.of({
    inspect: store.inspect,
    revoke: (command) =>
      store.revoke(command.userId, command.authSessionId).pipe(
        Effect.flatMap((result) =>
          result === "wrong-user"
            ? Effect.fail(
                new AuthSessionOwnershipMismatch({
                  authSessionId: command.authSessionId,
                  message: "The AuthSession does not belong to the selected User",
                  userId: command.userId,
                }),
              )
            : Effect.succeed(
                result === "revoked"
                  ? ({ _tag: "AuthSessionRevoked", authSessionId: command.authSessionId } as const)
                  : ({
                      _tag: "AuthSessionAlreadyRevoked",
                      authSessionId: command.authSessionId,
                    } as const),
              ),
        ),
      ),
    revokeAllForUser: store.revokeAll,
  }),
);

/** AuthSession Layer that preserves its @osfo/auth Store dependency. */
export const layerWithoutDependencies = Layer.effect(Service, make);
