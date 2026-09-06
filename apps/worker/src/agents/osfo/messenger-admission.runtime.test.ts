/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect-owned native Durable Object callback. */
/* oxlint-disable effecttsgo/async-function -- This test uses native SQLite through the Durable Object callback. */
import { expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Schema } from "effect";

import { DbTimestamp } from "../../db";
import { ChannelLinkId, ThinkSubmissionId, UserId } from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { makeAgentDb } from "./db/client";
import { applyAgentMigrations } from "./db/migrate";
import { makeMessengerAdmissionStore } from "./messenger-admission";

it.effect(
  "retains one immutable receipt and its original admission across store reconstruction",
  () =>
    Effect.promise(async () => {
      const stub = env.OSFO_DIRECTORY.getByName("messenger-receipt-immutability");
      await runInDurableObject(stub, async (_host, state) => {
        await Effect.runPromise(applyAgentMigrations(state.storage));
        const db = makeAgentDb(state.storage);
        const original = makeMessengerAdmissionStore(db);
        const metadata = turnMetadata();
        const receipt = {
          acceptedAt: DbTimestamp.make("2026-08-27T12:00:00.000Z"),
          allowancePeriodId: metadata.allowancePeriodId,
          channelLinkId: ChannelLinkId.make("runtime-channel-link"),
          inputDigest: "a".repeat(64),
          kind: "submission" as const,
          provider: "whatsapp" as const,
          providerMessageId: "wamid.immutable",
          routeId: metadata.routeId,
          sessionId: metadata.sessionId,
          submissionId: metadata.submissionId,
          threadId: "whatsapp:123:456",
          turnMetadata: metadata,
          userId: metadata.authorityIdentity.userId,
          userMessageId: metadata.submissionId,
        };
        expect(await Effect.runPromise(original.record(receipt, receipt.inputDigest))).toEqual(
          receipt,
        );
        const reopened = makeMessengerAdmissionStore(makeAgentDb(state.storage));
        expect(
          await Effect.runPromise(reopened.read(receipt.submissionId, receipt.inputDigest)),
        ).toEqual(receipt);
        expect(await Effect.runPromise(reopened.record(receipt, receipt.inputDigest))).toEqual(
          receipt,
        );
        expect(
          await Effect.runPromise(
            reopened.read(receipt.submissionId, "b".repeat(64)).pipe(Effect.flip),
          ),
        ).toMatchObject({ _tag: "MessengerAdmissionUnavailable" });
        expect(
          await Effect.runPromise(
            reopened
              .record(
                { ...receipt, acceptedAt: DbTimestamp.make("2026-08-28T12:00:00.000Z") },
                receipt.inputDigest,
              )
              .pipe(Effect.flip),
          ),
        ).toMatchObject({ _tag: "MessengerAdmissionUnavailable" });
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT count(*) AS count FROM osfo_messenger_acceptance_receipts",
            )
            .one().count,
        ).toBe(1);
      });
    }),
);

const turnMetadata = (): ManagedTurnMetadata =>
  Schema.decodeSync(ManagedTurnMetadata)({
    _tag: "OsfoManagedTurn",
    allowancePeriodId: "runtime-period",
    authorityIdentity: {
      _tag: "AuthSession",
      authSessionId: "reminder-runtime-auth-session",
      userId: UserId.make("runtime-user"),
    },
    capabilityCatalogVersion: "governed-capabilities-v1",
    conservativeVendorUsdMicros: 100,
    coreMemoryAuthorization: {
      authority: {
        _tag: "AuthSession",
        authSessionId: "reminder-runtime-auth-session",
        expiresAt: "2026-08-27T13:00:00.000Z",
        userId: "runtime-user",
      },
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: "2026-08-27T12:00:00.000Z",
      originatingAuthority: {
        _tag: "AuthSession",
        authSessionId: "reminder-runtime-auth-session",
      },
      resourceOwnerUserId: "runtime-user",
      subscription: { plan: "free", planPolicyVersion: "launch-v1" },
      user: { _tag: "ActiveUser", userId: "runtime-user" },
    },
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    maxSteps: 5,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "reminder-runtime-auth-session",
    },
    plan: "free",
    planPolicyVersion: "launch-v1",
    route: "@cf/test/model",
    routeId: "reminder-runtime-route",
    sessionId: "reminder-runtime-session",
    submissionId: ThinkSubmissionId.make("reminder-runtime-submission"),
    targetInputTokens: 18_000,
  });
