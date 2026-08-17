import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AuthSessionId } from "../src/domain/auth-session";
import { userId, withAccountAuthorityFixture } from "./account-authority-fixture";

describe("AuthSession authority", () => {
  it.effect("revokes one owned AuthSession through the @osfo/auth authority", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const authSessionId = AuthSessionId.make("auth-session-1");
        const revoked = yield* authorities.authSessions.revoke({ authSessionId, userId });
        const repeated = yield* authorities.authSessions.revoke({ authSessionId, userId });
        const fact = yield* authorities.authSessions.inspect(userId, authSessionId);

        expect(revoked).toEqual({ _tag: "AuthSessionRevoked", authSessionId });
        expect(repeated).toEqual({ _tag: "AuthSessionAlreadyRevoked", authSessionId });
        expect(fact).toEqual({ _tag: "RevokedAuthSession", authSessionId, userId });
      }),
    ),
  );
});
