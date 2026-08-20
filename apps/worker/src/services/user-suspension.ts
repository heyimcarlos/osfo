import { Context, Crypto, Effect, Layer, Schema } from "effect";

import type { DbUnavailable } from "../db";
import type { UserId } from "../domain";
import type { AdminActorId, AdminReason } from "../domain/account-administration";
import { type UserAccessFact, UserSuspensionEventId } from "../domain/user-suspension";

/** Expected failure when a secure User Suspension identity cannot be generated. */
export class UserSuspensionIdentityUnavailable extends Schema.TaggedError<UserSuspensionIdentityUnavailable>()(
  "UserSuspensionIdentityUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Administrative User Suspension command. */
export interface Command {
  readonly adminActorId: AdminActorId;
  readonly reason: AdminReason;
  readonly userId: UserId;
}

/** One retained User Suspension or restoration event. */
export interface HistoryEvent {
  readonly action: "restored" | "suspended";
  readonly adminActorId: AdminActorId;
  readonly eventId: UserSuspensionEventId;
  readonly occurredAt: Date;
  readonly reason: AdminReason;
}

/** Persistence result for one User Suspension transition. */
export type TransitionResult = "changed" | "missing-user" | "unchanged";

/** User Suspension persistence interface. */
export interface PersistencePort {
  readonly history: (userId: UserId) => Effect.Effect<ReadonlyArray<HistoryEvent>, DbUnavailable>;
  readonly inspect: (userId: UserId) => Effect.Effect<UserAccessFact, DbUnavailable>;
  readonly transition: (
    command: Command,
    eventId: UserSuspensionEventId,
    action: "restored" | "suspended",
  ) => Effect.Effect<TransitionResult, DbUnavailable>;
}

/** User Suspension persistence capability supplied by Postgres. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/UserSuspension/Persistence",
) {}

/** Public User Suspension authority. */
export interface Interface {
  readonly history: PersistencePort["history"];
  readonly inspect: PersistencePort["inspect"];
  readonly restore: (
    command: Command,
  ) => Effect.Effect<
    | { readonly _tag: "AlreadyActive" }
    | { readonly _tag: "UserMissing" }
    | { readonly _tag: "UserRestored"; readonly eventId: UserSuspensionEventId },
    DbUnavailable | UserSuspensionIdentityUnavailable
  >;
  readonly suspend: (
    command: Command,
  ) => Effect.Effect<
    | { readonly _tag: "AlreadySuspended" }
    | { readonly _tag: "UserMissing" }
    | { readonly _tag: "UserSuspended"; readonly eventId: UserSuspensionEventId },
    DbUnavailable | UserSuspensionIdentityUnavailable
  >;
}

/** Trusted User Suspension authority. */
export class Service extends Context.Service<Service, Interface>()("@osfo/UserSuspension") {}

/** Construct User Suspension authority from its Postgres persistence interface. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const persistence = yield* Persistence;
  const secureId = Effect.mapError(
    crypto.randomUUIDv7,
    (cause) =>
      new UserSuspensionIdentityUnavailable({
        cause,
        message: "A secure User Suspension identity could not be generated",
      }),
  );
  return Service.of({
    history: persistence.history,
    inspect: persistence.inspect,
    restore: (command) =>
      Effect.gen(function* () {
        const eventId = UserSuspensionEventId.make(yield* secureId);
        const result = yield* persistence.transition(command, eventId, "restored");
        if (result === "missing-user") return { _tag: "UserMissing" } as const;
        return result === "changed"
          ? ({ _tag: "UserRestored", eventId } as const)
          : ({ _tag: "AlreadyActive" } as const);
      }),
    suspend: (command) =>
      Effect.gen(function* () {
        const eventId = UserSuspensionEventId.make(yield* secureId);
        const result = yield* persistence.transition(command, eventId, "suspended");
        if (result === "missing-user") return { _tag: "UserMissing" } as const;
        return result === "changed"
          ? ({ _tag: "UserSuspended", eventId } as const)
          : ({ _tag: "AlreadySuspended" } as const);
      }),
  });
});

/** User Suspension Layer that preserves its dependencies. */
export const layerWithoutDependencies = Layer.effect(Service, make);

export * as UserSuspension from "./user-suspension";
