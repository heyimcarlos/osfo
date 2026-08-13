import { env } from "cloudflare:test";
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  createIdentity,
  makeDirectoryStoreLayer,
  readDenialFacts,
  readErasureReceipt,
  recordDenialFact,
  recordErasureReceipt,
  resolveAgent,
} from "../src/directory/directory-store";
import {
  AgentId,
  AllowancePeriodId,
  DenialFactId,
  DenialKind,
  DeletionManifestDigest,
  DeniedResourceId,
  DirectoryCommandId,
  DirectoryTimestamp,
  ErasedResourceId,
  ErasureReceiptId,
  ErasureScope,
  KnowledgeSpaceId,
  PlanPolicyVersion,
  SubscriptionId,
  ThreadId,
  UserId,
} from "../src/directory/directory-model";

const directoryStoreLayer = makeDirectoryStoreLayer({
  directory: env.DIRECTORY_DB,
  erasureReceipts: env.ERASURE_RECEIPTS_DB,
});

layer(directoryStoreLayer)("DirectoryStore", (it) => {
  it.effect("atomically creates stable identity and Agent routing facts", () =>
    Effect.gen(function* () {
      const created = yield* createIdentity({
        agentId: AgentId.make("agent-001"),
        allowancePeriodId: AllowancePeriodId.make("allowance-period-001"),
        allowancePeriodStartsAt: DirectoryTimestamp.make("2026-08-01T00:00:00.000Z"),
        allowancePeriodEndsAt: DirectoryTimestamp.make("2026-09-01T00:00:00.000Z"),
        commandId: DirectoryCommandId.make("command-create-identity-001"),
        knowledgeSpaceId: KnowledgeSpaceId.make("knowledge-space-001"),
        occurredAt: DirectoryTimestamp.make("2026-08-12T15:00:00.000Z"),
        planPolicyVersion: PlanPolicyVersion.make("launch-2026-08-12"),
        subscriptionId: SubscriptionId.make("subscription-001"),
        threadId: ThreadId.make("thread-001"),
        userId: UserId.make("user-001"),
      });
      const route = yield* resolveAgent(UserId.make("user-001"));

      expect(created).toEqual({
        agentId: "agent-001",
        allowancePeriodId: "allowance-period-001",
        knowledgeSpaceId: "knowledge-space-001",
        plan: "free",
        subscriptionId: "subscription-001",
        threadId: "thread-001",
        userId: "user-001",
      });
      expect(route).toEqual({
        agentId: "agent-001",
        knowledgeSpaceId: "knowledge-space-001",
        threadId: "thread-001",
        userId: "user-001",
      });
    }),
  );

  it.effect("returns one identity when the same command arrives concurrently", () =>
    Effect.gen(function* () {
      const input = {
        agentId: AgentId.make("agent-duplicate"),
        allowancePeriodId: AllowancePeriodId.make("allowance-period-duplicate"),
        allowancePeriodStartsAt: DirectoryTimestamp.make("2026-08-01T00:00:00.000Z"),
        allowancePeriodEndsAt: DirectoryTimestamp.make("2026-09-01T00:00:00.000Z"),
        commandId: DirectoryCommandId.make("command-create-identity-duplicate"),
        knowledgeSpaceId: KnowledgeSpaceId.make("knowledge-space-duplicate"),
        occurredAt: DirectoryTimestamp.make("2026-08-12T15:01:00.000Z"),
        planPolicyVersion: PlanPolicyVersion.make("launch-2026-08-12"),
        subscriptionId: SubscriptionId.make("subscription-duplicate"),
        threadId: ThreadId.make("thread-duplicate"),
        userId: UserId.make("user-duplicate"),
      };

      const [first, duplicate] = yield* Effect.all([createIdentity(input), createIdentity(input)], {
        concurrency: "unbounded",
      });
      const conflict = yield* Effect.flip(
        createIdentity({
          ...input,
          planPolicyVersion: PlanPolicyVersion.make("conflicting-policy-version"),
        }),
      );

      expect(duplicate).toEqual(first);
      expect(conflict).toMatchObject({
        _tag: "DirectoryCommandConflict",
        commandId: "command-create-identity-duplicate",
      });
    }),
  );

  it.effect("rolls back every identity fact when one route conflicts", () =>
    Effect.gen(function* () {
      const first = {
        agentId: AgentId.make("agent-route-conflict"),
        allowancePeriodId: AllowancePeriodId.make("allowance-period-route-owner"),
        allowancePeriodStartsAt: DirectoryTimestamp.make("2026-08-01T00:00:00.000Z"),
        allowancePeriodEndsAt: DirectoryTimestamp.make("2026-09-01T00:00:00.000Z"),
        commandId: DirectoryCommandId.make("command-route-owner"),
        knowledgeSpaceId: KnowledgeSpaceId.make("knowledge-space-route-owner"),
        occurredAt: DirectoryTimestamp.make("2026-08-12T15:01:30.000Z"),
        planPolicyVersion: PlanPolicyVersion.make("launch-2026-08-12"),
        subscriptionId: SubscriptionId.make("subscription-route-owner"),
        threadId: ThreadId.make("thread-route-owner"),
        userId: UserId.make("user-route-owner"),
      };
      const second = {
        ...first,
        allowancePeriodId: AllowancePeriodId.make("allowance-period-route-conflict"),
        commandId: DirectoryCommandId.make("command-route-conflict"),
        knowledgeSpaceId: KnowledgeSpaceId.make("knowledge-space-route-conflict"),
        subscriptionId: SubscriptionId.make("subscription-route-conflict"),
        threadId: ThreadId.make("thread-route-conflict"),
        userId: UserId.make("user-route-conflict"),
      };

      yield* createIdentity(first);
      const failedCreate = yield* Effect.flip(createIdentity(second));
      const missingRoute = yield* Effect.flip(resolveAgent(second.userId));
      const retried = yield* createIdentity({
        ...second,
        agentId: AgentId.make("agent-route-retry"),
      });

      expect(failedCreate).toMatchObject({
        _tag: "DirectoryWriteRejected",
        commandId: "command-route-conflict",
      });
      expect(missingRoute).toMatchObject({
        _tag: "DirectoryEntryNotFound",
        userId: "user-route-conflict",
      });
      expect(retried.userId).toBe("user-route-conflict");
    }),
  );

  it.effect("records content-free denial facts for authorization", () =>
    Effect.gen(function* () {
      yield* createIdentity({
        agentId: AgentId.make("agent-denial"),
        allowancePeriodId: AllowancePeriodId.make("allowance-period-denial"),
        allowancePeriodStartsAt: DirectoryTimestamp.make("2026-08-01T00:00:00.000Z"),
        allowancePeriodEndsAt: DirectoryTimestamp.make("2026-09-01T00:00:00.000Z"),
        commandId: DirectoryCommandId.make("command-create-identity-denial"),
        knowledgeSpaceId: KnowledgeSpaceId.make("knowledge-space-denial"),
        occurredAt: DirectoryTimestamp.make("2026-08-12T15:02:00.000Z"),
        planPolicyVersion: PlanPolicyVersion.make("launch-2026-08-12"),
        subscriptionId: SubscriptionId.make("subscription-denial"),
        threadId: ThreadId.make("thread-denial"),
        userId: UserId.make("user-denial"),
      });
      const denialInput = {
        commandId: DirectoryCommandId.make("command-denial-001"),
        denialFactId: DenialFactId.make("denial-001"),
        kind: DenialKind.make("user_suspension"),
        occurredAt: DirectoryTimestamp.make("2026-08-12T15:03:00.000Z"),
        resourceId: DeniedResourceId.make("user-denial"),
        userId: UserId.make("user-denial"),
      };
      const [recorded, duplicate] = yield* Effect.all(
        [recordDenialFact(denialInput), recordDenialFact(denialInput)],
        { concurrency: "unbounded" },
      );
      const facts = yield* readDenialFacts(UserId.make("user-denial"));

      expect(recorded).toEqual({
        denialFactId: "denial-001",
        kind: "user_suspension",
        occurredAt: "2026-08-12T15:03:00.000Z",
        resourceId: "user-denial",
        userId: "user-denial",
      });
      expect(duplicate).toEqual(recorded);
      expect(facts).toEqual([recorded]);
    }),
  );
});

layer(
  makeDirectoryStoreLayer({
    directory: env.ERASURE_RECEIPTS_DB,
    erasureReceipts: env.ERASURE_RECEIPTS_DB,
  }),
)("Erasure Receipt ledger", (it) => {
  it.effect("reads Erasure Receipts without directory database availability", () =>
    Effect.gen(function* () {
      const receiptInput = {
        commandId: DirectoryCommandId.make("command-erasure-001"),
        manifestDigest: DeletionManifestDigest.make(`sha256:${"a".repeat(64)}`),
        receiptId: ErasureReceiptId.make("erasure-receipt-001"),
        recordedAt: DirectoryTimestamp.make("2026-08-12T15:04:00.000Z"),
        resourceId: ErasedResourceId.make("user-erasure-001"),
        scope: ErasureScope.make("account_deletion"),
      };
      const [recorded, duplicate] = yield* Effect.all(
        [recordErasureReceipt(receiptInput), recordErasureReceipt(receiptInput)],
        { concurrency: "unbounded" },
      );
      const receipt = yield* readErasureReceipt(ErasureReceiptId.make("erasure-receipt-001"));

      expect(receipt).toEqual(recorded);
      expect(duplicate).toEqual(recorded);
    }),
  );
});
