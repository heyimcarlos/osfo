/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { UserId } from "../domain";
import { AccountDeletion } from "../services/account-deletion";
import {
  integrationAuthorityDeletionNotDelivered,
  integrationDeletionPort,
} from "./account-deletion";

it.effect("proves no integration targets only while the capability is not delivered", () =>
  Effect.gen(function* () {
    const port = integrationDeletionPort(integrationAuthorityDeletionNotDelivered);
    expect(yield* port.pending(UserId.make("user-1"))).toEqual([]);
  }),
);

it.effect("keeps account deletion pending when integration delivery has no adapter", () =>
  Effect.gen(function* () {
    const port = integrationDeletionPort({ _tag: "Delivered", adapter: null });
    const result = yield* port.pending(UserId.make("user-1")).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AccountDeletion.AccountDeletionUnavailable);
    }
  }),
);

it.effect("delegates delivered discovery and provider-confirmed revocation", () => {
  const userId = UserId.make("user-1");
  const target = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
    userId,
  };
  const remaining = [target];
  const port = integrationDeletionPort({
    _tag: "Delivered",
    adapter: {
      pending: (owner) => Effect.succeed(remaining.filter((item) => item.userId === owner)),
      revoke: (item) => Effect.sync(() => remaining.splice(remaining.indexOf(item), 1)),
    },
  });
  return Effect.gen(function* () {
    expect(yield* port.pending(userId)).toEqual([target]);
    yield* port.revoke(target);
    expect(yield* port.pending(userId)).toEqual([]);
  });
});
