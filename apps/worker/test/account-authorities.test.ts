import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { describe, expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { sessions, users } from "@osfo/db/schema/auth";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { eq } from "drizzle-orm";
import { DateTime, Effect, Exit, Layer, Redacted } from "effect";

import * as AccountAuthorities from "../src/composition/account-authorities";
import * as Db from "../src/db";
import { AllowancePeriodId, ChannelBindingId, PlanPolicyVersion, UserId } from "../src/domain";
import { ActionId } from "../src/domain/action-execution";
import { AuthorizationOperation } from "../src/domain/authorization-operation";
import { AdminActorId, AdminReason } from "../src/domain/account-administration";
import { AuthSessionId } from "../src/domain/auth-session";
import { PhoneNumber } from "../src/domain/phone-account";
import * as PhoneAccountAdapter from "../src/integrations/auth/phone-account";
import {
  TwilioVerify,
  phoneAccountVerificationLayerWithoutDependencies,
} from "../src/integrations/twilio/verify";
import * as ActionExecutor from "../src/services/action-executor";
import { make as makeAuthorization, AuthorizationContext } from "../src/services/authorization";
import * as DeletionCase from "../src/services/deletion-case";
import * as PhoneAccount from "../src/services/phone-account";
import { retainedCatalog } from "../src/domain/plan-policy";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Tests own Effect runtimes and real database boundaries. */

const userId = UserId.make("user-authority-1");
const adminActorId = AdminActorId.make("admin-1");
const reason = AdminReason.make("Support reviewed the request");
type TestDatabaseFixture = Effect.Success<typeof makeTestDatabase>;
type Authorities = Effect.Success<typeof AccountAuthorities.make>;

describe("Separate account authorities", () => {
  it.effect("records User Suspension and restoration history without deleting AuthSessions", () =>
    withFixture((authorities) =>
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
        const sessionWhileSuspended = yield* authorities.authSessions.inspect(
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
        expect(sessionWhileSuspended._tag).toBe("AuthSession");
        expect(restored._tag).toBe("UserRestored");
        expect(activeFact._tag).toBe("ActiveUser");
        expect(history.map((event) => event.action)).toEqual(["suspended", "restored"]);
      }),
    ),
  );

  it.effect("revokes one owned AuthSession through the @osfo/auth authority", () =>
    withFixture((authorities) =>
      Effect.gen(function* () {
        const authSessionId = AuthSessionId.make("auth-session-1");
        const revoked = yield* authorities.authSessions.revoke({
          authSessionId,
          userId,
        });
        const repeated = yield* authorities.authSessions.revoke({
          authSessionId,
          userId,
        });
        const fact = yield* authorities.authSessions.inspect(userId, authSessionId);

        expect(revoked).toEqual({ _tag: "AuthSessionRevoked", authSessionId });
        expect(repeated).toEqual({ _tag: "AuthSessionAlreadyRevoked", authSessionId });
        expect(fact).toEqual({ _tag: "RevokedAuthSession", authSessionId, userId });
      }),
    ),
  );

  it.effect("replaces one Phone Account and atomically revokes every AuthSession", () =>
    withFixture((authorities, _fixture, twilio, phoneAccounts) =>
      Effect.gen(function* () {
        const phoneNumber = PhoneNumber.make("+14165550199");
        const started = yield* phoneAccounts.beginReplacement({
          phoneNumber,
          userId,
        });
        const replaced = yield* phoneAccounts.completeReplacement({
          code: Redacted.make(twilio.code),
          phoneNumber,
          userId,
        });
        const firstSession = yield* authorities.authSessions.inspect(
          userId,
          AuthSessionId.make("auth-session-1"),
        );
        const secondSession = yield* authorities.authSessions.inspect(
          userId,
          AuthSessionId.make("auth-session-2"),
        );

        expect(started).toEqual({ _tag: "PhoneReplacementStarted" });
        expect(twilio.sent).toEqual([phoneNumber]);
        expect(replaced).toEqual({ _tag: "PhoneAccountReplaced" });
        expect(firstSession._tag).toBe("RevokedAuthSession");
        expect(secondSession._tag).toBe("RevokedAuthSession");
      }),
    ),
  );

  it.effect("requires manual support for a Phone Account collision and rejected code", () =>
    withFixture((_authorities, fixture, _twilio, phoneAccounts) =>
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
        const collision = yield* phoneAccounts.beginReplacement({
          phoneNumber: PhoneNumber.make("+14165550188"),
          userId,
        });
        const rejected = yield* phoneAccounts
          .completeReplacement({
            code: Redacted.make("000000"),
            phoneNumber: PhoneNumber.make("+14165550177"),
            userId,
          })
          .pipe(Effect.exit);

        expect(collision._tag).toBe("ManualSupportRequired");
        expect(Exit.isFailure(rejected)).toBe(true);
        expect(String(rejected)).not.toContain("internal@phone-user.osfo.invalid");
      }),
    ),
  );

  it.effect("creates one Deletion Case after revoking every AuthSession", () =>
    withFixture((authorities) =>
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
        const deletionAccess = yield* authorities.deletionCases.inspect(userId);
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
        expect(deletionAccess._tag).toBe("DeletionAccessRevoked");
        expect(session._tag).toBe("RevokedAuthSession");
      }),
    ),
  );

  it.effect("serializes concurrent Deletion Case requests", () =>
    withFixture((authorities) =>
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

  it.effect("serializes concurrent User Suspension transitions", () =>
    withFixture((authorities) =>
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

  it.effect("serializes concurrent opposing User Suspension transitions", () =>
    withFixture((authorities) =>
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

  it.effect("returns manual support for concurrent Phone Account replacement collisions", () =>
    withFixture((_authorities, fixture, twilio, phoneAccounts) =>
      Effect.gen(function* () {
        const otherUserId = UserId.make("user-authority-2");
        const replacement = PhoneNumber.make("+14165550155");
        yield* Effect.promise(() =>
          fixture.database.insert(users).values({
            email: "other@phone-user.osfo.invalid",
            id: otherUserId,
            name: "Other Osfo User",
            phoneNumber: "+14165550111",
            phoneNumberVerified: true,
          }),
        );
        const results = yield* Effect.all(
          [
            phoneAccounts.completeReplacement({
              code: Redacted.make(twilio.code),
              phoneNumber: replacement,
              userId,
            }),
            phoneAccounts.completeReplacement({
              code: Redacted.make(twilio.code),
              phoneNumber: replacement,
              userId: otherUserId,
            }),
          ],
          { concurrency: "unbounded" },
        );

        expect(results.map((result) => result._tag).toSorted()).toEqual([
          "ManualSupportRequired",
          "PhoneAccountReplaced",
        ]);
      }),
    ),
  );

  it.effect("returns typed missing-User outcomes from application authorities", () =>
    withFixture((authorities) =>
      Effect.gen(function* () {
        const missingUserId = UserId.make("missing-user");
        const suspension = yield* authorities.userSuspensions.suspend({
          adminActorId,
          reason,
          userId: missingUserId,
        });
        const deletion = yield* authorities.deletionCases.request({
          adminActorId,
          reason,
          userId: missingUserId,
        });

        expect(suspension).toEqual({ _tag: "UserMissing" });
        expect(deletion).toEqual({ _tag: "UserMissing" });
      }),
    ),
  );

  it.effect("checks the Deletion Case fence inside Phone Account replacement", () =>
    withFixture((_authorities, fixture, _twilio, _phoneAccounts, phoneStore) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fixture.database.insert(deletionCases).values({
            deletionCaseId: "deletion-fence-1",
            reason,
            requestedByAdminId: adminActorId,
            userId,
          }),
        );
        const result = yield* phoneStore.replaceAndRevokeSessions(
          userId,
          PhoneNumber.make("+14165550166"),
        );

        expect(result).toBe("deletion-requested");
      }),
    ),
  );

  it.effect("routes account recovery to manual support", () =>
    withFixture((_authorities, _fixture, _twilio, phoneAccounts) =>
      Effect.gen(function* () {
        const result = yield* phoneAccounts.requestRecovery;
        expect(result).toEqual({
          _tag: "ManualSupportRequired",
          message: "Account recovery requires manual support.",
        });
      }),
    ),
  );

  for (const testCase of [
    { denial: "authorityRevoked", mutation: "revoke-session" },
    { denial: "userSuspended", mutation: "suspend-user" },
    { denial: "authorityRevoked", mutation: "request-deletion" },
  ] as const) {
    it.effect(`denies provider contact when ${testCase.mutation} happens after admission`, () =>
      withFixture((authorities) =>
        Effect.gen(function* () {
          const authSessionId = AuthSessionId.make("auth-session-1");
          const actionId = ActionId.make(`protected-${testCase.mutation}`);
          const authorization = makeAuthorization(retainedCatalog);
          const operation = { actionId, kind: "gmail.send" } as const;
          const initialContext = yield* currentAuthorizationContext(
            authorities,
            authSessionId,
            actionId,
          );
          const admitted = authorization.admit(initialContext, operation);
          let providerContacts = 0;

          yield* mutateAuthority(authorities, testCase.mutation, authSessionId);
          const executor = ActionExecutor.make(authorization, protectedEffectOwners(authorities));
          const result = yield* executor.executeThinkApprovedAction(
            { requestVendorUsdMicros: 0n },
            { _tag: "AuthSession", authSessionId, userId },
            AuthorizationOperation.make({
              actionId,
              kind: "gmail.send",
            }),
            (providerActionId) =>
              Effect.sync(() => {
                providerContacts += 1;
                return {
                  _tag: "Applied" as const,
                  actionId: providerActionId,
                  evidence: "The provider accepted the action",
                  providerOperationId: "provider-operation-1",
                };
              }),
          );

          expect(admitted._tag).toBe("Admitted");
          expect(result).toMatchObject({ _tag: "Denied", reason: testCase.denial });
          expect(providerContacts).toBe(0);
        }),
      ),
    );
  }

  it.effect("rechecks the current Channel Binding before provider contact", () =>
    withFixture((authorities, fixture) =>
      Effect.gen(function* () {
        const channelBindingId = ChannelBindingId.make("channel-binding-protected");
        const actionId = ActionId.make("protected-channel-binding");
        yield* Effect.promise(() =>
          fixture.database.insert(channelBindings).values({
            channelBindingId,
            channelIdentity: "+14165550100",
            provider: "whatsapp",
            userId,
          }),
        );
        const authority = yield* authorities.channelBindings.inspect(userId, channelBindingId);
        const authorization = makeAuthorization(retainedCatalog);
        const admitted = authorization.admit(
          AuthorizationContext.make({
            ...stableAuthorizationContext(),
            approval: { actionId, operation: "gmail.send", userId },
            authority,
            deletionAccess: { _tag: "DeletionAccessAvailable" },
            now: testDate("2026-08-16T12:00:00.000Z"),
            originatingAuthority: { _tag: "ChannelBinding", channelBindingId },
            user: { _tag: "ActiveUser", userId },
          }),
          { actionId, kind: "gmail.send" },
        );
        yield* Effect.promise(() =>
          fixture.database
            .update(channelBindings)
            .set({ revokedAt: testDate("2026-08-16T12:01:00.000Z") })
            .where(eq(channelBindings.channelBindingId, channelBindingId)),
        );
        let providerContacts = 0;
        const result = yield* ActionExecutor.make(
          authorization,
          protectedEffectOwners(authorities),
        ).executeThinkApprovedAction(
          { requestVendorUsdMicros: 0n },
          { _tag: "ChannelBinding", channelBindingId, userId },
          AuthorizationOperation.make({
            actionId,
            kind: "gmail.send",
          }),
          () =>
            Effect.sync(() => {
              providerContacts += 1;
              return {
                _tag: "Applied" as const,
                actionId,
                evidence: "The provider accepted the action",
                providerOperationId: "provider-operation-channel",
              };
            }),
        );

        expect(admitted._tag).toBe("Admitted");
        expect(result).toMatchObject({ _tag: "Denied", reason: "authorityRevoked" });
        expect(providerContacts).toBe(0);
      }),
    ),
  );

  it.effect("rechecks current live resources before provider contact", () =>
    withFixture((authorities) =>
      Effect.gen(function* () {
        const authSessionId = AuthSessionId.make("auth-session-1");
        const actionId = ActionId.make("protected-live-resources");
        const authority = yield* authorities.authSessions.inspect(userId, authSessionId);
        const authorization = makeAuthorization(retainedCatalog);
        const operation = AuthorizationOperation.make({ actionId, kind: "support.gmSummon" });
        const admitted = authorization.admit(
          AuthorizationContext.make({
            ...stableAuthorizationContext(),
            approval: { actionId, operation: operation.kind, userId },
            authority,
            deletionAccess: { _tag: "DeletionAccessAvailable" },
            now: testDate("2026-08-16T12:00:00.000Z"),
            originatingAuthority: { _tag: "AuthSession", authSessionId },
            user: { _tag: "ActiveUser", userId },
          }),
          operation,
        );
        let providerContacts = 0;
        const owners: ActionExecutor.AuthorityOwners = {
          ...protectedEffectOwners(authorities),
          liveResources: {
            inspect: () =>
              Effect.succeed({
                activeGmSummonsInSession: 1n,
                activeReminders: 0n,
                concurrentWorkflows: 0n,
                retainedFileBytes: 0n,
              }),
          },
        };
        const result = yield* ActionExecutor.make(authorization, owners).executeThinkApprovedAction(
          { requestVendorUsdMicros: 0n },
          { _tag: "AuthSession", authSessionId, userId },
          operation,
          () =>
            Effect.sync(() => {
              providerContacts += 1;
              return {
                _tag: "Applied" as const,
                actionId,
                evidence: "The provider accepted the summon",
                providerOperationId: "provider-operation-live-resource",
              };
            }),
        );

        expect(admitted._tag).toBe("Admitted");
        expect(result).toMatchObject({ _tag: "Denied", reason: "liveResourceLimitReached" });
        expect(providerContacts).toBe(0);
      }),
    ),
  );
});

const withFixture = <A, E>(
  use: (
    authorities: Authorities,
    fixture: TestDatabaseFixture,
    twilio: ReturnType<typeof makeTwilio>,
    phoneAccounts: PhoneAccount.Interface,
    phoneStore: PhoneAccount.StorePort,
  ) => Effect.Effect<A, E>,
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
        const authorities = yield* AccountAuthorities.make.pipe(Effect.provide(base));
        const phoneStore = yield* PhoneAccountAdapter.make.pipe(Effect.provide(base));
        const verification = yield* PhoneAccount.Verification.pipe(
          Effect.provide(
            phoneAccountVerificationLayerWithoutDependencies.pipe(Layer.provide(base)),
          ),
        );
        const phoneAccounts = yield* PhoneAccount.make.pipe(
          Effect.provideService(PhoneAccount.Store, phoneStore),
          Effect.provideService(PhoneAccount.Verification, verification),
          Effect.provideService(DeletionCase.Service, authorities.deletionCases),
        );
        return yield* use(authorities, fixture, twilio, phoneAccounts, phoneStore);
      }),
    closeTestDatabase,
  );

const mutateAuthority = (
  authorities: Authorities,
  mutation: "request-deletion" | "revoke-session" | "suspend-user",
  authSessionId: AuthSessionId,
) => {
  switch (mutation) {
    case "revoke-session":
      return authorities.authSessions.revoke({ authSessionId, userId });
    case "suspend-user":
      return authorities.userSuspensions.suspend({ adminActorId, reason, userId });
    case "request-deletion":
      return authorities.deletionCases.request({ adminActorId, reason, userId });
    default:
      return mutation satisfies never;
  }
};

const currentAuthorizationContext = (
  authorities: Authorities,
  authSessionId: AuthSessionId,
  actionId: ActionId,
) =>
  Effect.gen(function* () {
    const [authority, deletionAccess, user] = yield* Effect.all([
      authorities.authSessions.inspect(userId, authSessionId),
      authorities.deletionCases.inspect(userId),
      authorities.userSuspensions.inspect(userId),
    ]);
    return AuthorizationContext.make({
      ...stableAuthorizationContext(),
      approval: { actionId, operation: "gmail.send", userId },
      authority,
      deletionAccess,
      now: testDate("2026-08-16T12:00:00.000Z"),
      originatingAuthority: { _tag: "AuthSession", authSessionId },
      user,
    });
  });

const stableAuthorizationContext = (): Pick<
  AuthorizationContext,
  | "allowance"
  | "gmailConnection"
  | "liveFacts"
  | "requestVendorUsdMicros"
  | "resourceOwnerUserId"
  | "subscription"
> => ({
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("period-protected-effect"),
    endsAt: testDate("2026-09-01T00:00:00.000Z"),
    plan: "adventurer",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: testDate("2026-08-01T00:00:00.000Z"),
    usage: [],
  },
  gmailConnection: { _tag: "Connected", userId },
  liveFacts: {
    activeGmSummonsInSession: 0n,
    activeReminders: 0n,
    concurrentWorkflows: 0n,
    retainedFileBytes: 0n,
  },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan: "adventurer", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
});

const protectedEffectOwners = (authorities: Authorities): ActionExecutor.AuthorityOwners => ({
  ...authorities,
  approvals: {
    inspect: (_userId, operation) =>
      Effect.succeed({ actionId: operation.actionId, operation: operation.kind, userId }),
  },
  integrationConnections: {
    inspectGmail: () => Effect.succeed({ _tag: "Connected", userId }),
  },
  liveResources: {
    inspect: () =>
      Effect.succeed({
        activeGmSummonsInSession: 0n,
        activeReminders: 0n,
        concurrentWorkflows: 0n,
        retainedFileBytes: 0n,
      }),
  },
  resourceOwnership: {
    inspect: () => Effect.succeed(userId),
  },
  subscriptions: {
    inspect: () =>
      Effect.succeed({
        plan: "adventurer",
        planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      }),
  },
});

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
