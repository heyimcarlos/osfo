import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { describe, expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { sessions, users } from "@osfo/db/schema/auth";
import { DateTime, Effect, Exit, Layer, Redacted } from "effect";

import * as Db from "../src/db";
import { UserId } from "../src/domain";
import {
  AdminActorId,
  AuthSessionId,
  LifecycleReason,
  PhoneNumber,
} from "../src/domain/user-lifecycle";
import {
  TwilioVerify,
  userLifecycleLayerWithoutDependencies,
} from "../src/integrations/twilio/verify";
import * as UserLifecyclePostgres from "../src/integrations/postgres/user-lifecycle";
import * as UserLifecycle from "../src/services/user-lifecycle";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Tests own Effect runtimes and database setup boundaries. */

const userId = UserId.make("user-lifecycle-1");
const adminActorId = AdminActorId.make("admin-1");
const reason = LifecycleReason.make("Support reviewed the request");
type TestDatabaseFixture = Effect.Success<typeof makeTestDatabase>;

describe("User lifecycle", () => {
  it.effect("records exact suspension and restoration history without deleting sessions", () =>
    withFixture((_fixture, lifecycle) =>
      Effect.gen(function* () {
        const suspended = yield* lifecycle.suspend({ adminActorId, reason, userId });
        const repeated = yield* lifecycle.suspend({ adminActorId, reason, userId });
        const suspendedFacts = yield* lifecycle.inspectUser(userId);
        const sessionWhileSuspended = yield* lifecycle.inspectAuthSession(
          userId,
          AuthSessionId.make("auth-session-1"),
        );
        const restored = yield* lifecycle.restore({ adminActorId, reason, userId });
        const activeFacts = yield* lifecycle.inspectUser(userId);
        const history = yield* lifecycle.suspensionHistory(userId);

        expect(suspended._tag).toBe("UserSuspended");
        expect(repeated).toEqual({ _tag: "AlreadySuspended" });
        expect(suspendedFacts.user._tag).toBe("SuspendedUser");
        expect(sessionWhileSuspended._tag).toBe("AuthSession");
        expect(restored._tag).toBe("UserRestored");
        expect(activeFacts.user._tag).toBe("ActiveUser");
        expect(history.map((event) => event.action)).toEqual(["suspended", "restored"]);
        expect(history.every((event) => event.adminActorId === adminActorId)).toBe(true);
      }),
    ),
  );

  it.effect("revokes one owned AuthSession and exposes its current revoked fact", () =>
    withFixture((_fixture, lifecycle) =>
      Effect.gen(function* () {
        const authSessionId = AuthSessionId.make("auth-session-1");
        const revoked = yield* lifecycle.revokeAuthSession({
          adminActorId,
          authSessionId,
          reason,
          userId,
        });
        const repeated = yield* lifecycle.revokeAuthSession({
          adminActorId,
          authSessionId,
          reason,
          userId,
        });
        const fact = yield* lifecycle.inspectAuthSession(userId, authSessionId);

        expect(revoked).toEqual({ _tag: "AuthSessionRevoked", authSessionId });
        expect(repeated).toEqual({ _tag: "AuthSessionAlreadyRevoked", authSessionId });
        expect(fact).toEqual({ _tag: "RevokedAuthSession", authSessionId, userId });
      }),
    ),
  );

  it.effect("replaces one verified phone and revokes every existing AuthSession", () =>
    withFixture((_fixture, lifecycle, twilio) =>
      Effect.gen(function* () {
        const phoneNumber = PhoneNumber.make("+14165550199");
        const started = yield* lifecycle.beginPhoneReplacement({
          adminActorId,
          phoneNumber,
          reason,
          userId,
        });
        const replaced = yield* lifecycle.completePhoneReplacement({
          adminActorId,
          code: Redacted.make(twilio.code),
          phoneNumber,
          reason,
          userId,
        });
        const firstSession = yield* lifecycle.inspectAuthSession(
          userId,
          AuthSessionId.make("auth-session-1"),
        );
        const secondSession = yield* lifecycle.inspectAuthSession(
          userId,
          AuthSessionId.make("auth-session-2"),
        );
        const unchanged = yield* lifecycle.completePhoneReplacement({
          adminActorId,
          code: Redacted.make(twilio.code),
          phoneNumber,
          reason,
          userId,
        });

        expect(started).toEqual({ _tag: "PhoneReplacementStarted" });
        expect(twilio.sent).toEqual([phoneNumber]);
        expect(replaced).toEqual({ _tag: "PhoneAccountReplaced" });
        expect(firstSession._tag).toBe("RevokedAuthSession");
        expect(secondSession._tag).toBe("RevokedAuthSession");
        expect(unchanged).toEqual({ _tag: "PhoneAccountUnchanged" });
      }),
    ),
  );

  it.effect("fails closed to manual support for collision and recovery", () =>
    withFixture((fixture, lifecycle) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fixture.database.insert(users).values({
            email: "collision@phone-user.osfo.invalid",
            id: "user-collision",
            name: "Osfo User",
            phoneNumber: "+14165550188",
            phoneNumberVerified: true,
          }),
        );
        const collision = yield* lifecycle.beginPhoneReplacement({
          adminActorId,
          phoneNumber: PhoneNumber.make("+14165550188"),
          reason,
          userId,
        });
        const recovery = yield* lifecycle.requestRecovery;

        expect(collision._tag).toBe("ManualSupportRequired");
        expect(recovery._tag).toBe("ManualSupportRequired");
      }),
    ),
  );

  it.effect("returns a safe typed failure for a rejected replacement code", () =>
    withFixture((_fixture, lifecycle) =>
      Effect.gen(function* () {
        const result = yield* lifecycle
          .completePhoneReplacement({
            adminActorId,
            code: Redacted.make("000000"),
            phoneNumber: PhoneNumber.make("+14165550177"),
            reason,
            userId,
          })
          .pipe(Effect.exit);

        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(String(result.cause)).toContain("PhoneVerificationRejected");
          expect(String(result.cause)).not.toContain("internal@phone-user.osfo.invalid");
        }
      }),
    ),
  );

  it.effect("creates one Deletion Case and immediately revokes all access", () =>
    withFixture((_fixture, lifecycle) =>
      Effect.gen(function* () {
        const requested = yield* lifecycle.requestDeletion({ adminActorId, reason, userId });
        const repeated = yield* lifecycle.requestDeletion({ adminActorId, reason, userId });
        const facts = yield* lifecycle.inspectUser(userId);
        const firstSession = yield* lifecycle.inspectAuthSession(
          userId,
          AuthSessionId.make("auth-session-1"),
        );

        expect(requested._tag).toBe("DeletionRequested");
        expect(repeated).toMatchObject({
          _tag: "DeletionAlreadyRequested",
          deletionCaseId: requested.deletionCaseId,
        });
        expect(facts.deletionAccess._tag).toBe("DeletionAccessRevoked");
        expect(firstSession._tag).toBe("RevokedAuthSession");
      }),
    ),
  );
});

const withFixture = <A>(
  use: (
    fixture: TestDatabaseFixture,
    lifecycle: UserLifecycle.Interface,
    twilio: ReturnType<typeof makeTwilio>,
  ) => Effect.Effect<A, UserLifecycle.LifecycleError>,
) =>
  Effect.acquireUseRelease(
    makeTestDatabase,
    (fixture) =>
      Effect.gen(function* () {
        yield* applyMigrations(fixture.client);
        yield* seedUser(fixture.database);
        const twilio = makeTwilio();
        const base = Layer.mergeAll(
          BrowserCrypto.layer,
          Db.layerFromDatabase(fixture.database),
          Layer.succeed(TwilioVerify, twilio.service),
        );
        const dependencies = Layer.mergeAll(
          base,
          UserLifecyclePostgres.layerWithoutDependencies.pipe(Layer.provide(base)),
          userLifecycleLayerWithoutDependencies.pipe(Layer.provide(base)),
        );
        const lifecycle = yield* UserLifecycle.Service.pipe(
          Effect.provide(UserLifecycle.layerWithoutDependencies.pipe(Layer.provide(dependencies))),
        );
        return yield* use(fixture, lifecycle, twilio);
      }),
    closeTestDatabase,
  );

const seedUser = (database: TestDatabaseFixture["database"]) =>
  Effect.promise(() =>
    database.transaction(async (transaction) => {
      await transaction.insert(users).values({
        email: "internal@phone-user.osfo.invalid",
        id: userId,
        name: "Osfo User",
        phoneNumber: "+14165550100",
        phoneNumberVerified: true,
      });
      await transaction.insert(sessions).values([
        {
          expiresAt: testDate("2026-09-01T00:00:00.000Z"),
          id: "auth-session-1",
          token: "token-1",
          updatedAt: testDate("2026-08-16T00:00:00.000Z"),
          userId,
        },
        {
          expiresAt: testDate("2026-09-01T00:00:00.000Z"),
          id: "auth-session-2",
          token: "token-2",
          updatedAt: testDate("2026-08-16T00:00:00.000Z"),
          userId,
        },
      ]);
    }),
  );

const makeTwilio = () => {
  const code = "123456";
  const sent: Array<string> = [];
  return {
    code,
    sent,
    service: TwilioVerify.of({
      sendCode: (phoneNumber) =>
        Effect.sync(() => {
          sent.push(phoneNumber);
        }),
      verifyCode: (_phoneNumber, submittedCode) =>
        Effect.succeed(Redacted.value(submittedCode) === code),
    }),
  };
};

const testDate = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
