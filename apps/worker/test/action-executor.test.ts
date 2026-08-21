import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import type { Authorities } from "./account-authority-fixture";
import {
  adminActorId,
  reason,
  userId,
  withAccountAuthorityFixture,
} from "./account-authority-fixture";
import { AllowancePeriodId, ChannelLinkId, PlanPolicyVersion } from "../src/domain";
import { ActionId } from "../src/domain/action-execution";
import { AuthSessionId } from "../src/domain/auth-session";
import { ChannelAddress, ChannelAuthorId, ChannelId } from "../src/domain/channel-link";
import { AuthorizationOperation } from "../src/domain/authorization-operation";
import { retainedCatalog } from "../src/domain/plan-policy";
import { ActionExecutor } from "../src/services/action-executor";
import { Authorization, AuthorizationContext } from "../src/services/authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Tests assert tagged public outcomes. */

const channelAddress = ChannelAddress.make({
  authorId: ChannelAuthorId.make("protected-author"),
  channelId: ChannelId.make("protected-channel"),
});

describe("protected-effect executor", () => {
  for (const testCase of [
    { denial: "authorityRevoked", mutation: "revoke-session" },
    { denial: "userSuspended", mutation: "suspend-user" },
    { denial: "authorityRevoked", mutation: "request-deletion" },
  ] as const) {
    it.effect(`denies provider contact when ${testCase.mutation} happens after admission`, () =>
      withAccountAuthorityFixture(({ authorities }) =>
        Effect.gen(function* () {
          const authSessionId = AuthSessionId.make("auth-session-1");
          const actionId = ActionId.make(`protected-${testCase.mutation}`);
          const authorization = Authorization.make(retainedCatalog);
          const operation = AuthorizationOperation.make({ actionId, kind: "gmail.send" });
          const admitted = authorization.admit(
            yield* currentAuthorizationContext(authorities, authSessionId, actionId),
            operation,
          );
          let providerContacts = 0;

          yield* mutateAuthority(authorities, testCase.mutation, authSessionId);
          const result = yield* ActionExecutor.make(
            authorization,
            protectedEffectOwners(authorities),
          ).executeThinkApprovedAction(
            { requestVendorUsdMicros: 0n },
            { _tag: "AuthSession", authSessionId, userId },
            operation,
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

  it.effect("denies provider contact when the AuthSession expires after admission", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const authSessionId = AuthSessionId.make("auth-session-1");
        const actionId = ActionId.make("protected-session-expiry");
        const authorization = Authorization.make(retainedCatalog);
        const operation = AuthorizationOperation.make({ actionId, kind: "gmail.send" });
        const admitted = authorization.admit(
          yield* currentAuthorizationContext(authorities, authSessionId, actionId),
          operation,
        );
        let providerContacts = 0;

        yield* TestClock.setTime(parseDate("2026-09-02T00:00:00.000Z").getTime());
        const result = yield* ActionExecutor.make(
          authorization,
          protectedEffectOwners(authorities),
        ).executeThinkApprovedAction(
          { requestVendorUsdMicros: 0n },
          { _tag: "AuthSession", authSessionId, userId },
          operation,
          (providerActionId) =>
            Effect.sync(() => {
              providerContacts += 1;
              return {
                _tag: "Applied" as const,
                actionId: providerActionId,
                evidence: "The provider accepted the action",
                providerOperationId: "provider-operation-expired-session",
              };
            }),
        );

        expect(admitted._tag).toBe("Admitted");
        expect(result).toMatchObject({ _tag: "Denied", reason: "authenticationRequired" });
        expect(providerContacts).toBe(0);
      }),
    ),
  );

  it.effect("rechecks the current Channel Link before provider contact", () =>
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const channelLinkId = ChannelLinkId.make("channel-link-protected");
        const actionId = ActionId.make("protected-channel-link");
        const authority = {
          _tag: "ChannelLink" as const,
          address: channelAddress,
          channelLinkId,
          userId,
        };
        const authorization = Authorization.make(retainedCatalog);
        const operation = AuthorizationOperation.make({ actionId, kind: "gmail.send" });
        const admitted = authorization.admit(
          AuthorizationContext.make({
            ...stableAuthorizationContext(),
            approval: { actionId, operation: operation.kind, userId },
            authority,
            deletionAccess: { _tag: "DeletionAccessAvailable" },
            now: parseDate("2026-08-16T12:00:00.000Z"),
            originatingAuthority: { _tag: "ChannelLink", channelLinkId },
            user: { _tag: "ActiveUser", userId },
          }),
          operation,
        );
        let providerContacts = 0;
        const result = yield* ActionExecutor.make(authorization, {
          ...protectedEffectOwners(authorities),
          channelLinks: {
            inspect: () =>
              Effect.succeed({
                _tag: "RevokedChannelLink" as const,
                address: channelAddress,
                channelLinkId,
                userId,
              }),
          },
        }).executeThinkApprovedAction(
          { requestVendorUsdMicros: 0n },
          { _tag: "ChannelLink", address: channelAddress, channelLinkId, userId },
          operation,
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
    withAccountAuthorityFixture(({ authorities }) =>
      Effect.gen(function* () {
        const authSessionId = AuthSessionId.make("auth-session-1");
        const actionId = ActionId.make("protected-live-resources");
        const authorization = Authorization.make(retainedCatalog);
        const operation = AuthorizationOperation.make({ actionId, kind: "support.gmSummon" });
        const authority = yield* authorities.authSessions.inspect(userId, authSessionId);
        const admitted = authorization.admit(
          AuthorizationContext.make({
            ...stableAuthorizationContext(),
            approval: { actionId, operation: operation.kind, userId },
            authority,
            deletionAccess: { _tag: "DeletionAccessAvailable" },
            now: parseDate("2026-08-16T12:00:00.000Z"),
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
      now: parseDate("2026-08-16T12:00:00.000Z"),
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
    endsAt: parseDate("2026-09-01T00:00:00.000Z"),
    plan: "adventurer",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: parseDate("2026-08-01T00:00:00.000Z"),
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
  channelLinks: {
    inspect: (address, _userId, channelLinkId) =>
      Effect.succeed({ _tag: "ChannelLink" as const, address, channelLinkId, userId }),
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
  resourceOwnership: { inspect: () => Effect.succeed(userId) },
  subscriptions: {
    inspect: () =>
      Effect.succeed({
        plan: "adventurer",
        planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      }),
  },
});

const parseDate = Schema.decodeSync(Schema.DateFromString);
