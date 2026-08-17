import { describe, expect, it } from "@effect/vitest";
import { accounts, users } from "@osfo/db/schema/auth";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { DateTime, Deferred, Effect, Fiber, Redacted, Schema } from "effect";

import { AllowancePeriodId, PlanPolicyVersion, UserId } from "../src/domain";
import { ActionId } from "../src/domain/action-execution";
import {
  GmailConnectionId,
  GmailConnectionGrant,
  GmailDraftInput,
  GmailMessageId,
  GmailReadInput,
  GmailSendInput,
  GmailSearchInput,
  type GmailConnection,
} from "../src/domain/gmail";
import { retainedCatalog } from "../src/domain/plan-policy";
import {
  make as makeAuthorization,
  type AuthorizationContext,
} from "../src/services/authorization";
import { make as makeGmail } from "../src/services/gmail";
import { gmailSendActionName, presentGmailSendAction } from "../src/agents/osfo/gmail-send-action";
import {
  ActionPresentationId,
  type PendingThinkAction,
} from "../src/agents/osfo/think-action-approvals";
import * as GmailDb from "../src/db/gmail";

describe("Gmail Integration Connection", () => {
  it.effect(
    "keeps connection ownership exact, permits revocation, and becomes dormant after downgrade",
    () =>
      Effect.gen(function* () {
        const connections = makeConnections();
        const gmail = makeGmail({
          allowances: makeUsage(),
          attempts: makeSendAttempts(),
          authorization: makeAuthorization(retainedCatalog),
          connections,
          provider: {
            read: () => Effect.die("read is not used in this assertion"),
            reconcileSend: () => Effect.die("reconcile is not used in this assertion"),
            search: () => Effect.die("search is not used in this assertion"),
            send: () => Effect.die("send is not used in this assertion"),
          },
        });
        const owner = UserId.make("gmail-owner");
        const otherUser = UserId.make("gmail-other-user");
        const connectionId = GmailConnectionId.make(`gmail:${owner}`);

        const connected = yield* gmail.completeOAuth(context(owner, "adventurer"));
        expect(connected).toMatchObject({ _tag: "Connected", connectionId, userId: owner });

        const wrongOwner = yield* gmail.revoke(context(otherUser, "adventurer"), connectionId);
        expect(wrongOwner).toEqual({ _tag: "Denied", reason: "ownershipRequired", resetAt: null });

        const dormant = yield* gmail.inspect(context(owner, "free"));
        expect(dormant).toMatchObject({ _tag: "Dormant", connectionId, userId: owner });
        expect(connections.read(connectionId)).toMatchObject({ _tag: "Connected" });

        const revoked = yield* gmail.revoke(context(owner, "free"), connectionId);
        expect(revoked).toMatchObject({ _tag: "Revoked", connectionId, userId: owner });
        expect(connections.read(connectionId)).toMatchObject({ _tag: "Revoked" });
      }),
  );

  it.effect("checks search and examined-message limits and records only observed outcomes", () =>
    Effect.gen(function* () {
      const connections = makeConnections();
      const usage = makeUsage();
      const providerCalls: Array<string> = [];
      const owner = UserId.make("gmail-search-owner");
      const connectionId = GmailConnectionId.make("gmail-connection-search");
      yield* connections.connect(
        owner,
        GmailConnectionGrant.make({
          connectionId,
          credentialReference: "gmail-credential-search",
          grantedAt: now,
          providerAccountId: "search@gmail.example",
        }),
      );
      const gmail = makeGmail({
        allowances: usage,
        attempts: makeSendAttempts(),
        authorization: makeAuthorization(retainedCatalog),
        connections,
        provider: {
          read: () => Effect.die("read is not used in this assertion"),
          reconcileSend: () => Effect.die("reconcile is not used in this assertion"),
          search: () => {
            providerCalls.push("search");
            return Effect.succeed({
              messages: [
                {
                  from: "one@example.com",
                  messageId: GmailMessageId.make("message-one"),
                  subject: "One",
                },
                {
                  from: "two@example.com",
                  messageId: GmailMessageId.make("message-two"),
                  subject: "Two",
                },
              ],
              vendorUsdMicros: 7n,
            });
          },
          send: () => Effect.die("send is not used in this assertion"),
        },
      });
      const search = GmailSearchInput.make({
        maximumMessages: 10,
        query: "from:example.com",
        toolCallId: "tool-search-1",
      });

      const exhaustedSearch = yield* gmail.search(
        withUsage(context(owner, "adventurer"), "gmailSearches", 50n),
        search,
      );
      expect(exhaustedSearch).toMatchObject({ _tag: "Denied", reason: "allowanceExhausted" });

      const exhaustedExamined = yield* gmail.search(
        withUsage(context(owner, "adventurer"), "gmailMessagesExamined", 500n),
        search,
      );
      expect(exhaustedExamined).toMatchObject({ _tag: "Denied", reason: "allowanceExhausted" });
      expect(providerCalls).toEqual([]);

      const found = yield* gmail.search(context(owner, "adventurer"), search);
      expect(found).toMatchObject({
        _tag: "SearchCompleted",
        messages: [{ subject: "One" }, { subject: "Two" }],
      });
      expect(providerCalls).toEqual(["search"]);
      expect(usage.records).toEqual([
        {
          allowancePeriodId: AllowancePeriodId.make("allowance-period-gmail"),
          items: [
            { allowanceKind: "gmailSearches", basis: "observed", quantity: 1n },
            { allowanceKind: "gmailMessagesExamined", basis: "observed", quantity: 2n },
            { allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 7n },
          ],
          source: { sourceId: "tool-search-1", sourceType: "gmailSearch" },
        },
      ]);
    }),
  );

  it.effect("reads one selected message and creates drafts without a Gmail write", () =>
    Effect.gen(function* () {
      const connections = makeConnections();
      const usage = makeUsage();
      const owner = UserId.make("gmail-read-owner");
      yield* connections.connect(
        owner,
        GmailConnectionGrant.make({
          connectionId: GmailConnectionId.make("gmail-connection-read"),
          credentialReference: "gmail-credential-read",
          grantedAt: now,
          providerAccountId: "read@gmail.example",
        }),
      );
      const providerCalls: Array<string> = [];
      const gmail = makeGmail({
        allowances: usage,
        attempts: makeSendAttempts(),
        authorization: makeAuthorization(retainedCatalog),
        connections,
        provider: {
          read: (_connection, input) => {
            providerCalls.push(`read:${input.messageId}`);
            return Effect.succeed({
              body: "Message body",
              from: "sender@example.com",
              messageId: input.messageId,
              subject: "Read me",
              vendorUsdMicros: 3n,
            });
          },
          reconcileSend: () => Effect.die("reconcile is not used in this assertion"),
          search: () => Effect.die("search is not used in this assertion"),
          send: () => Effect.die("send is not used in this assertion"),
        },
      });
      const messageId = GmailMessageId.make("message-read");

      const read = yield* gmail.read(
        context(owner, "adventurer"),
        GmailReadInput.make({ messageId, toolCallId: "tool-read-1" }),
      );
      expect(read).toMatchObject({ _tag: "MessageRead", body: "Message body", messageId });

      const draft = yield* gmail.draft(
        context(owner, "adventurer"),
        GmailDraftInput.make({
          body: "Local reply",
          recipient: "sender@example.com",
          selectedResourceId: messageId,
          subject: "Re: Read me",
          toolCallId: "tool-draft-1",
        }),
      );
      expect(draft).toMatchObject({ _tag: "DraftCreatedLocally", body: "Local reply" });
      expect(providerCalls).toEqual(["read:message-read"]);
      expect(usage.records).toEqual([
        {
          allowancePeriodId: AllowancePeriodId.make("allowance-period-gmail"),
          items: [
            { allowanceKind: "gmailMessagesExamined", basis: "observed", quantity: 1n },
            { allowanceKind: "vendorUsdMicros", basis: "observed", quantity: 3n },
          ],
          source: { sourceId: "tool-read-1", sourceType: "gmailRead" },
        },
      ]);
    }),
  );

  it.effect(
    "rechecks exact send authority and records conservative use after ambiguity without blind retry",
    () =>
      Effect.gen(function* () {
        const connections = makeConnections();
        const usage = makeUsage();
        const attempts = makeSendAttempts();
        const owner = UserId.make("gmail-send-owner");
        const connectionId = GmailConnectionId.make("gmail-connection-send");
        yield* connections.connect(
          owner,
          GmailConnectionGrant.make({
            connectionId,
            credentialReference: "gmail-credential-send",
            grantedAt: now,
            providerAccountId: "send@gmail.example",
          }),
        );
        const providerCalls: Array<string> = [];
        const gmail = makeGmail({
          allowances: usage,
          attempts,
          authorization: makeAuthorization(retainedCatalog),
          connections,
          provider: {
            read: () => Effect.die("read is not used in this assertion"),
            reconcileSend: () => {
              providerCalls.push("reconcile");
              return Effect.succeed({
                _tag: "Ambiguous" as const,
                evidence: "The sent mailbox did not provide a conclusive result",
                vendorUsdMicros: 11n,
              });
            },
            search: () => Effect.die("search is not used in this assertion"),
            send: (_connection, input) => {
              providerCalls.push(`send:${input.recipient}`);
              return Effect.succeed({
                _tag: "Ambiguous" as const,
                evidence: "The Gmail response was lost after request bytes left",
                vendorUsdMicros: 11n,
              });
            },
          },
        });
        const input = GmailSendInput.make({
          actionId: ActionId.make("gmail-action-ambiguous"),
          body: "Exact body",
          recipient: "recipient@example.com",
          scheduledFor: null,
          selectedResourceId: GmailMessageId.make("message-reply-resource"),
          subject: "Exact subject",
        });

        const lostSubscription = yield* gmail.sendApproved(
          context(owner, "free"),
          input,
          gmailAllowancePeriod,
        );
        expect(lostSubscription).toMatchObject({ _tag: "Denied", reason: "missingEntitlement" });
        expect(providerCalls).toEqual([]);

        const ambiguous = yield* gmail.sendApproved(
          context(owner, "adventurer"),
          input,
          gmailAllowancePeriod,
        );
        expect(ambiguous).toMatchObject({ _tag: "Ambiguous", actionId: "gmail-action-ambiguous" });
        expect(providerCalls).toEqual(["send:recipient@example.com", "reconcile"]);
        expect(attempts.read("gmail-action-ambiguous")).toEqual({
          actionId: "gmail-action-ambiguous",
          connectionId,
          outcome: "ambiguous",
          startedAt: now,
        });
        expect(Object.keys(attempts.read("gmail-action-ambiguous") ?? {})).toEqual([
          "actionId",
          "connectionId",
          "outcome",
          "startedAt",
        ]);
        expect(usage.records.at(-1)).toEqual({
          allowancePeriodId: AllowancePeriodId.make("allowance-period-gmail"),
          items: [
            { allowanceKind: "gmailSends", basis: "conservative", quantity: 1n },
            { allowanceKind: "vendorUsdMicros", basis: "conservative", quantity: 11n },
          ],
          source: { sourceId: "gmail-action-ambiguous", sourceType: "gmailSend" },
        });

        const repeated = yield* gmail.sendApproved(
          context(owner, "adventurer"),
          input,
          gmailAllowancePeriod,
        );
        expect(repeated).toMatchObject({ _tag: "Ambiguous", actionId: "gmail-action-ambiguous" });
        expect(providerCalls).toEqual(["send:recipient@example.com", "reconcile"]);
      }),
  );

  it.effect("blocks the protected send when the Gmail connection is revoked before contact", () =>
    Effect.gen(function* () {
      const connections = makeConnections();
      const usage = makeUsage();
      const attempts = makeSendAttempts();
      const owner = UserId.make("gmail-revoked-send-owner");
      const connection = yield* connections.connect(
        owner,
        GmailConnectionGrant.make({
          connectionId: GmailConnectionId.make("gmail-connection-revoked-send"),
          credentialReference: "gmail-credential-revoked-send",
          grantedAt: now,
          providerAccountId: "revoked@gmail.example",
        }),
      );
      yield* connections.revoke(connection, now);
      const providerCalls: Array<string> = [];
      const gmail = makeGmail({
        allowances: usage,
        attempts,
        authorization: makeAuthorization(retainedCatalog),
        connections,
        provider: {
          read: () => Effect.die("read is not used in this assertion"),
          reconcileSend: () => Effect.die("reconcile is not used in this assertion"),
          search: () => Effect.die("search is not used in this assertion"),
          send: () => {
            providerCalls.push("send");
            return Effect.die("send must not run after revocation");
          },
        },
      });
      const denied = yield* gmail.sendApproved(
        context(owner, "adventurer"),
        GmailSendInput.make({
          actionId: ActionId.make("gmail-action-revoked"),
          body: "Body",
          recipient: "recipient@example.com",
          scheduledFor: null,
          selectedResourceId: null,
          subject: "Subject",
        }),
        gmailAllowancePeriod,
      );

      expect(denied).toMatchObject({ _tag: "Denied", reason: "integrationConnectionRequired" });
      expect(providerCalls).toEqual([]);
      expect(attempts.read("gmail-action-revoked")).toBeUndefined();
    }),
  );

  it.effect("does not contact Gmail twice while the first send attempt is active", () =>
    Effect.gen(function* () {
      const connections = makeConnections();
      const owner = UserId.make("gmail-concurrent-send-owner");
      yield* connections.connect(
        owner,
        GmailConnectionGrant.make({
          connectionId: GmailConnectionId.make("gmail-connection-concurrent-send"),
          credentialReference: "gmail-credential-concurrent-send",
          grantedAt: now,
          providerAccountId: "concurrent@gmail.example",
        }),
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let providerContacts = 0;
      const gmail = makeGmail({
        allowances: makeUsage(),
        attempts: makeSendAttempts(),
        authorization: makeAuthorization(retainedCatalog),
        connections,
        provider: {
          read: () => Effect.die("read is not used in this assertion"),
          reconcileSend: () => Effect.die("reconcile must not run while send is active"),
          search: () => Effect.die("search is not used in this assertion"),
          send: () =>
            Effect.gen(function* () {
              providerContacts += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return {
                _tag: "Applied" as const,
                evidence: "Gmail accepted the message",
                providerMessageId: GmailMessageId.make("gmail-provider-message-concurrent"),
                vendorUsdMicros: 0n,
              };
            }),
        },
      });
      const input = GmailSendInput.make({
        actionId: ActionId.make("gmail-action-concurrent"),
        body: "Exact body",
        recipient: "recipient@example.com",
        scheduledFor: null,
        selectedResourceId: null,
        subject: "Exact subject",
      });

      const first = yield* Effect.forkChild(
        gmail.sendApproved(context(owner, "adventurer"), input, gmailAllowancePeriod),
      );
      yield* Deferred.await(entered);
      const duplicate = yield* gmail.sendApproved(
        context(owner, "adventurer"),
        input,
        gmailAllowancePeriod,
      );
      yield* Deferred.succeed(release, undefined);
      const applied = yield* Fiber.join(first);

      expect(duplicate).toMatchObject({ _tag: "Ambiguous", actionId: input.actionId });
      expect(applied).toMatchObject({ _tag: "Applied", actionId: input.actionId });
      expect(providerContacts).toBe(1);
    }),
  );

  it.effect(
    "binds Approval presentation to exact recipient, content, schedule, and Gmail resource",
    () =>
      Effect.gen(function* () {
        const first = yield* presentGmailSendAction(
          pendingSend("approval-first", "action-first", "Original body"),
        );
        const changed = yield* presentGmailSendAction(
          pendingSend("approval-changed", "action-changed", "Changed body"),
        );

        expect(first).toMatchObject({
          actionDefinitionVersion: "osfo-gmail-send-v1",
          actionId: "action-first",
          operation: "gmail.send",
          presentationId: "approval-first",
        });
        expect(first.fields).toEqual([
          { label: "Recipient", name: "recipient", value: "recipient@example.com" },
          { label: "Subject", name: "subject", value: "Exact subject" },
          { label: "Content", name: "body", value: "Original body" },
          { label: "Schedule", name: "scheduledFor", value: "Send now" },
          { label: "Gmail resource", name: "selectedResourceId", value: "message-selected" },
        ]);
        expect(changed.actionId).not.toBe(first.actionId);
        expect(changed.fields).not.toEqual(first.fields);
      }),
  );

  it.effect(
    "keeps on-demand send immediate and leaves future schedules to the Scheduled Email Workflow",
    () =>
      Effect.gen(function* () {
        const rejected = yield* Effect.flip(
          Schema.decodeUnknownEffect(GmailSendInput)({
            actionId: "gmail-action-future-schedule",
            body: "Exact body",
            recipient: "recipient@example.com",
            scheduledFor: "2026-08-18T12:00:00.000Z",
            selectedResourceId: null,
            subject: "Exact subject",
          }),
        );

        expect(rejected).toBeDefined();
      }),
  );

  it.effect(
    "persists connection authority and only Gmail provider recovery evidence for sends",
    () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            const userId = UserId.make("gmail-persistence-user");
            yield* Effect.promise(() =>
              fixture.database.insert(users).values({
                email: "gmail-persistence@example.test",
                id: userId,
                name: "Gmail persistence user",
              }),
            );
            yield* Effect.promise(() =>
              fixture.database.insert(accounts).values({
                accessToken: "gmail-access-token",
                accessTokenExpiresAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("1960-08-17T12:00:00.000Z"),
                ),
                accountId: "persistence@gmail.example",
                id: "gmail-credential-persistence",
                providerId: "google",
                scope:
                  "https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send",
                userId,
              }),
            );
            const otherUserId = UserId.make("gmail-persistence-other-user");
            yield* Effect.promise(() =>
              fixture.database.insert(users).values({
                email: "gmail-persistence-other@example.test",
                id: otherUserId,
                name: "Other Gmail persistence user",
              }),
            );
            yield* Effect.promise(() =>
              fixture.database.insert(accounts).values({
                accessToken: "other-gmail-access-token",
                accessTokenExpiresAt: DateTime.toDateUtc(
                  DateTime.makeUnsafe("2027-08-17T12:00:00.000Z"),
                ),
                accountId: "other@gmail.example",
                id: "other-gmail-credential-persistence",
                providerId: "google",
                scope:
                  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
                userId: otherUserId,
              }),
            );
            let tokenRefreshes = 0;
            const gmailDb = GmailDb.make(fixture.database, () => {
              tokenRefreshes += 1;
              return Effect.succeed(Redacted.make("refreshed-gmail-access-token"));
            });
            const connectionId = GmailConnectionId.make("gmail:gmail-credential-persistence");
            const connected = yield* gmailDb.connections.completeOAuth(userId, now);
            const repeatedConnection = yield* gmailDb.connections.completeOAuth(userId, now);
            const actionId = ActionId.make("gmail-persistence-action");
            const firstAttempt = yield* gmailDb.attempts.begin(actionId, connectionId, now);
            const repeatedAttempt = yield* gmailDb.attempts.begin(actionId, connectionId, now);
            const recoveryAt = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T12:05:00.000Z"));
            const recoveryClaims = yield* Effect.all(
              [
                gmailDb.attempts.begin(actionId, connectionId, recoveryAt),
                gmailDb.attempts.begin(actionId, connectionId, recoveryAt),
              ],
              { concurrency: "unbounded" },
            );
            yield* gmailDb.attempts.complete(actionId, "ambiguous");
            const storedConnection = yield* gmailDb.connections.findByUser(userId);
            const accessToken = yield* gmailDb.credentials.resolveAccessToken(connected, "read");
            const mismatchedToken = yield* Effect.flip(
              gmailDb.credentials.resolveAccessToken(
                { ...connected, providerAccountId: "other@gmail.example" },
                "read",
              ),
            );
            const columns = yield* Effect.promise(() =>
              fixture.client
                .query<{ readonly column_name: string }>(
                  "select column_name from information_schema.columns where table_name = 'gmail_send_attempts' order by column_name",
                )
                .then((result) => result.rows.map((row) => row.column_name)),
            );

            expect(connected).toMatchObject({ _tag: "Connected", connectionId, userId });
            expect(repeatedConnection).toEqual(connected);
            expect(mismatchedToken).toMatchObject({ _tag: "GmailProviderUnavailable" });
            expect(storedConnection).toEqual(connected);
            expect(Redacted.value(accessToken)).toBe("refreshed-gmail-access-token");
            expect(tokenRefreshes).toBe(1);
            expect(firstAttempt).toMatchObject({ _tag: "AttemptStarted" });
            expect(repeatedAttempt).toMatchObject({ _tag: "ActiveAttempt" });
            expect(new Set(recoveryClaims.map(({ _tag }) => _tag))).toEqual(
              new Set(["ActiveAttempt", "RecoveryStarted"]),
            );
            expect(columns).toEqual(["action_id", "connection_id", "outcome", "started_at"]);
          }),
        closeTestDatabase,
      ),
  );
});

const pendingSend = (
  executionId: string,
  toolCallId: string,
  body: string,
): PendingThinkAction => ({
  descriptor: {
    action: gmailSendActionName,
    input: {
      body,
      recipient: "recipient@example.com",
      scheduledFor: null,
      selectedResourceId: "message-selected",
      subject: "Exact subject",
    },
    kind: "durable-pause",
    permissions: ["gmail:send"],
    requestId: `request-${toolCallId}`,
    risk: "high",
    summary: "Send the exact Gmail message",
    toolCallId,
  },
  executionId: ActionPresentationId.make(executionId),
  source: "action",
});

const now = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T12:00:00.000Z"));
const gmailAllowancePeriod = AllowancePeriodId.make("allowance-period-gmail");

const context = (userId: UserId, plan: "free" | "adventurer"): AuthorizationContext => ({
  allowance:
    plan === "adventurer"
      ? {
          _tag: "Metered",
          allowancePeriodId: AllowancePeriodId.make("allowance-period-gmail"),
          endsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-17T12:00:00.000Z")),
          plan,
          planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
          startsAt: now,
          usage: [],
        }
      : { _tag: "Unavailable" },
  approval: null,
  authority: {
    _tag: "AuthSession",
    authSessionId: `session-${userId}`,
    expiresAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T12:01:00.000Z")),
    userId,
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  liveFacts: {
    activeGmSummonsInSession: 0n,
    activeReminders: 0n,
    concurrentWorkflows: 0n,
    retainedFileBytes: 0n,
  },
  now,
  originatingAuthority: { _tag: "AuthSession", authSessionId: `session-${userId}` },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: userId,
  subscription: { plan, planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
  user: { _tag: "ActiveUser", userId },
});

const makeConnections = () => {
  const records = new Map<GmailConnectionId, GmailConnection>();
  return {
    completeOAuth: (userId: UserId, grantedAt: Date) => {
      const connectionId = GmailConnectionId.make(`gmail:${userId}`);
      const connection = {
        _tag: "Connected" as const,
        connectionId,
        credentialReference: `credential:${userId}`,
        grantedAt,
        providerAccountId: `${userId}@gmail.example`,
        userId,
      };
      records.set(connectionId, connection);
      return Effect.succeed(connection);
    },
    connect: (userId: UserId, grant: GmailConnectionGrant) => {
      const connection = {
        _tag: "Connected" as const,
        ...grant,
        userId,
      };
      records.set(grant.connectionId, connection);
      return Effect.succeed(connection);
    },
    findById: (connectionId: GmailConnectionId) =>
      Effect.succeed(records.get(connectionId) ?? null),
    findByUser: (userId: UserId) =>
      Effect.succeed([...records.values()].find((record) => record.userId === userId) ?? null),
    read: (connectionId: GmailConnectionId) => records.get(connectionId),
    revoke: (
      connection: Extract<GmailConnection, { readonly _tag: "Connected" }>,
      revokedAt: Date,
    ) => {
      const revoked = { ...connection, _tag: "Revoked" as const, revokedAt };
      records.set(connection.connectionId, revoked);
      return Effect.succeed(revoked);
    },
  };
};

const makeUsage = () => {
  const records: Array<{
    readonly allowancePeriodId: AllowancePeriodId;
    readonly items: ReadonlyArray<{
      readonly allowanceKind: string;
      readonly basis: string;
      readonly quantity: bigint;
    }>;
    readonly source: { readonly sourceId: string; readonly sourceType: string };
  }> = [];
  return {
    record: (
      allowancePeriodId: AllowancePeriodId,
      source: { readonly sourceId: string; readonly sourceType: string },
      items: ReadonlyArray<{
        readonly allowanceKind: string;
        readonly basis: string;
        readonly quantity: bigint;
      }>,
    ) => {
      records.push({ allowancePeriodId, items, source });
      return Effect.succeed({ _tag: "Recorded" as const });
    },
    records,
  };
};

const makeSendAttempts = () => {
  type Attempt = {
    readonly actionId: ActionId;
    readonly connectionId: GmailConnectionId;
    readonly outcome: "pending" | "applied" | "notApplied" | "ambiguous";
    readonly startedAt: Date;
  };
  const attempts = new Map<string, Attempt>();
  return {
    begin: (actionId: ActionId, connectionId: GmailConnectionId, nowAt: Date) => {
      const existing = attempts.get(actionId);
      if (existing !== undefined) {
        if (existing.outcome !== "pending") {
          return Effect.succeed({ _tag: "ExistingAttempt" as const, attempt: existing });
        }
        if (nowAt.getTime() - existing.startedAt.getTime() < 5 * 60 * 1_000) {
          return Effect.succeed({ _tag: "ActiveAttempt" as const, attempt: existing });
        }
        const claimed = { ...existing, startedAt: nowAt };
        attempts.set(actionId, claimed);
        return Effect.succeed({ _tag: "RecoveryStarted" as const, attempt: claimed });
      }
      const attempt: Attempt = { actionId, connectionId, outcome: "pending", startedAt: nowAt };
      attempts.set(actionId, attempt);
      return Effect.succeed({ _tag: "AttemptStarted" as const, attempt });
    },
    complete: (actionId: ActionId, outcome: Attempt["outcome"]) => {
      const existing = attempts.get(actionId);
      if (existing === undefined) return Effect.die("attempt must exist before completion");
      attempts.set(actionId, { ...existing, outcome });
      return Effect.void;
    },
    read: (actionId: string) => attempts.get(actionId),
  };
};

const withUsage = (
  authorizationContext: AuthorizationContext,
  allowanceKind: "gmailMessagesExamined" | "gmailSearches",
  quantity: bigint,
): AuthorizationContext => ({
  ...authorizationContext,
  allowance: {
    _tag: "Metered",
    allowancePeriodId: AllowancePeriodId.make("allowance-period-gmail"),
    endsAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-09-17T12:00:00.000Z")),
    plan: "adventurer",
    planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
    startsAt: now,
    usage: [{ allowanceKind, quantity }],
  },
});
