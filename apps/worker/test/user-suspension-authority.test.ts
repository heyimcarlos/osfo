import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../src/domain";
import { AuthSessionId } from "../src/domain/auth-session";
import {
  adminActorId,
  reason,
  userId,
  withAccountAuthorityFixture,
} from "./account-authority-fixture";

/* oxlint-disable eslint/no-underscore-dangle -- Tests assert tagged public outcomes. */

describe("User Suspension authority", () => {
  it.effect("records suspension and restoration history without deleting AuthSessions", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const suspended = yield* authorities.userSuspensions.suspend({
          adminActorId,
          reason,
          userId,
        });
        const repeated = yield* authorities.userSuspensions.suspend({
          adminActorId,
          reason,
          userId,
        });
        const suspendedFact = yield* authorities.userSuspensions.inspect(userId);
        const session = yield* authorities.authSessions.inspect(
          userId,
          AuthSessionId.make("auth-session-1"),
        );
        const restored = yield* authorities.userSuspensions.restore({
          adminActorId,
          reason,
          userId,
        });
        const activeFact = yield* authorities.userSuspensions.inspect(userId);
        const history = yield* authorities.userSuspensions.history(userId);

        expect(suspended._tag).toBe("UserSuspended");
        expect(repeated).toEqual({ _tag: "AlreadySuspended" });
        expect(suspendedFact._tag).toBe("SuspendedUser");
        expect(session._tag).toBe("AuthSession");
        expect(restored._tag).toBe("UserRestored");
        expect(activeFact._tag).toBe("ActiveUser");
        expect(history.map((event) => event.action)).toEqual(["suspended", "restored"]);
      }),
    ),
  );

  it.effect("serializes concurrent matching transitions", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [
            authorities.userSuspensions.suspend({ adminActorId, reason, userId }),
            authorities.userSuspensions.suspend({ adminActorId, reason, userId }),
          ],
          { concurrency: "unbounded" },
        );
        const history = yield* authorities.userSuspensions.history(userId);

        expect(new Set(results.map((result) => result._tag))).toEqual(
          new Set(["AlreadySuspended", "UserSuspended"]),
        );
        expect(history).toHaveLength(1);
      }),
    ),
  );

  it.effect("serializes concurrent opposing transitions in database order", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        yield* authorities.userSuspensions.suspend({ adminActorId, reason, userId });
        yield* Effect.all(
          [
            authorities.userSuspensions.restore({ adminActorId, reason, userId }),
            authorities.userSuspensions.suspend({ adminActorId, reason, userId }),
          ],
          { concurrency: "unbounded" },
        );
        const [fact, history] = yield* Effect.all([
          authorities.userSuspensions.inspect(userId),
          authorities.userSuspensions.history(userId),
        ]);
        const latest = history.at(-1);

        expect(latest).toBeDefined();
        expect(fact._tag).toBe(latest?.action === "suspended" ? "SuspendedUser" : "ActiveUser");
        for (const [index, event] of history.entries()) {
          const previous = history[index - 1];
          if (previous !== undefined) {
            expect(event.occurredAt.getTime()).toBeGreaterThan(previous.occurredAt.getTime());
          }
        }
      }),
    ),
  );

  it.effect("returns a typed missing-User outcome", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const result = yield* authorities.userSuspensions.suspend({
          adminActorId,
          reason,
          userId: UserId.make("missing-user"),
        });

        expect(result).toEqual({ _tag: "UserMissing" });
      }),
    ),
  );
});
