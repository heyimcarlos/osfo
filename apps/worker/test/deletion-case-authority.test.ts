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

describe("Deletion Case authority", () => {
  it.effect("creates one Deletion Case after revoking every AuthSession", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const requested = yield* authorities.deletionCases.request({
          adminActorId,
          reason,
          userId,
        });
        const repeated = yield* authorities.deletionCases.request({
          adminActorId,
          reason,
          userId,
        });
        const access = yield* authorities.deletionCases.inspect(userId);
        const session = yield* authorities.authSessions.inspect(
          userId,
          AuthSessionId.make("auth-session-1"),
        );

        expect(requested._tag).toBe("DeletionRequested");
        expect(repeated).toMatchObject({
          _tag: "DeletionAlreadyRequested",
          deletionCaseId:
            requested._tag === "UserMissing" ? "fixture-user-missing" : requested.deletionCaseId,
        });
        expect(access._tag).toBe("DeletionAccessRevoked");
        expect(session._tag).toBe("RevokedAuthSession");
      }),
    ),
  );

  it.effect("serializes concurrent requests", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const results = yield* Effect.all(
          [
            authorities.deletionCases.request({ adminActorId, reason, userId }),
            authorities.deletionCases.request({ adminActorId, reason, userId }),
          ],
          { concurrency: "unbounded" },
        );

        expect(new Set(results.map((result) => result._tag))).toEqual(
          new Set(["DeletionAlreadyRequested", "DeletionRequested"]),
        );
      }),
    ),
  );

  it.effect("returns a typed missing-User outcome", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const result = yield* authorities.deletionCases.request({
          adminActorId,
          reason,
          userId: UserId.make("missing-user"),
        });

        expect(result).toEqual({ _tag: "UserMissing" });
      }),
    ),
  );
});
