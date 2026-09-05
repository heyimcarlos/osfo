import { Effect, Predicate, Schema } from "effect";

import { UserId } from "../../domain";
import type { UserAccessFact } from "../../domain/user-suspension";

export class AccountResetUnavailable extends Schema.TaggedError<AccountResetUnavailable>()(
  "AccountResetUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Require the exact suspended owner before permanently fencing a facet for reset. */
export const requireResetAuthority = (
  requestedUserId: UserId,
  ownerUserId: UserId,
  user: UserAccessFact,
) =>
  requestedUserId === ownerUserId &&
  user.userId === requestedUserId &&
  Predicate.isTagged(user, "SuspendedUser")
    ? Effect.void
    : Effect.fail(
        new AccountResetUnavailable({
          cause: "reset authority mismatch",
          message: "Account reset requires the exact suspended Agent owner",
        }),
      );

const resetOwnerKey = "osfo_account_reset_owner_v1";

/** A reset survives eviction and restoration of login access until the facet is deleted. */
export const make = (storage: {
  // oxlint-disable-next-line osfo/no-unknown-returns -- The storage boundary decodes the persisted value immediately below.
  readonly get: (key: string) => unknown;
  readonly put: (key: string, value: UserId) => void;
}) => {
  const read = Effect.try({
    try: () => storage.get(resetOwnerKey),
    catch: unavailable,
  }).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Schema.decodeUnknownEffect(UserId)(value).pipe(Effect.mapError(unavailable)),
    ),
  );
  return {
    isFenced: read.pipe(Effect.map((owner) => owner !== undefined)),
    persist: Effect.fn("AccountResetFence.persist")(function* (userId: UserId) {
      const retained = yield* read;
      if (retained !== undefined && retained !== userId) {
        return yield* unavailable("Retained reset belongs to a different User");
      }
      yield* Effect.try({
        try: () => storage.put(resetOwnerKey, userId),
        catch: unavailable,
      });
      return undefined;
    }),
    restore: <E, R>(close: Effect.Effect<void, E, R>) =>
      read.pipe(Effect.flatMap((owner) => (owner === undefined ? Effect.void : close))),
  };
};

const unavailable = (cause: unknown) =>
  new AccountResetUnavailable({ cause, message: "The durable account reset fence is unavailable" });

export * as AccountResetFence from "./account-reset-fence";
