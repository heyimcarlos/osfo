/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, effecttsgo/node-builtin-import, effecttsgo/global-fetch-in-effect, effecttsgo/global-date-in-effect, eslint/no-underscore-dangle -- This journey owns the signed provider request and native RPC/PostgreSQL composition. */
import { createHmac } from "node:crypto";
import { BrowserCrypto } from "@effect/platform-browser";
import {
  messengerContextFromEvent,
  parseMessengerReplySnapshot,
} from "@cloudflare/think/messengers";
import { whatsappWakeups } from "@osfo/db/schema/whatsapp-wakeups";
import { userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { allowanceUsage } from "@osfo/db/schema/allowances";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { inject, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Duration, Effect, Layer, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";

import { OsfoAgent, messengerSubmissionId } from "../../src/agents/osfo/agent";
import { MessengerAcceptanceReceipt } from "../../src/agents/osfo/messenger-admission";
import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import { loadConfig } from "../../src/config";
import { Db } from "../../src/db";
import { UserId } from "../../src/domain";
import { ChannelLinks } from "../../src/services/channel-links";
import { spawnApp } from "../support/spawn-app";

it.effect(
  "acknowledges and replays one WhatsApp input with one native submission and allowance entry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
          Effect.promise(client.dispose),
        );
        const otherApp = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
          Effect.promise(client.dispose),
        );
        const owner = yield* Effect.promise(() =>
          app.auth.mintVerifiedUser({
            profile: { helpAreas: [], locale: "en", preferredName: "Messenger Owner" },
          }),
        );
        const otherOwner = yield* Effect.promise(() =>
          otherApp.auth.mintVerifiedUser({
            profile: { helpAreas: [], locale: "en", preferredName: "Other Owner" },
          }),
        );
        const service = yield* ChannelLinks.Service;
        const database = yield* Db.database;
        const address = ChannelLinks.ChannelAddress.make({
          authorId: ChannelLinks.ChannelAuthorId.make("15555550101"),
          channelId: ChannelLinks.ChannelId.make("whatsapp"),
        });
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          object: "whatsapp_business_account",
          entry: [
            {
              id: "test-business",
              changes: [
                {
                  field: "messages",
                  value: {
                    messaging_product: "whatsapp",
                    metadata: { phone_number_id: "123456789", display_phone_number: "15555550100" },
                    contacts: [{ wa_id: "15555550101", profile: { name: "Test" } }],
                    messages: [
                      {
                        from: "15555550101",
                        id: "wamid.durable-acceptance",
                        timestamp: "1700000000",
                        type: "text",
                        text: { body: "Hello, please acknowledge this message." },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });
        const send = (input = body) =>
          app.fetch("/webhooks/whatsapp", {
            method: "POST",
            body: input,
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": `sha256=${createHmac("sha256", "test-only-whatsapp-app-secret").update(input).digest("hex")}`,
            },
          });
        const context = inject("osfoJourney");
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            fetch(`${context.providerOrigin}/_test/whatsapp/reset`, { method: "POST" }),
          ).pipe(Effect.asVoid),
        );
        const readLedger = Effect.tryPromise(() =>
          fetch(`${context.providerOrigin}/_test/whatsapp/ledger`).then((response) =>
            response.json(),
          ),
        );
        const invitation = yield* Effect.promise(() =>
          send(
            body
              .replace("wamid.durable-acceptance", "wamid.invitation")
              .replace("Hello, please acknowledge this message.", "I want to try Osfo"),
          ),
        );
        expect(invitation.status).toBe(200);
        const invitationLedger = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ body: Schema.String })),
        )(yield* readLedger);
        expect(invitationLedger).toHaveLength(1);
        expect(invitationLedger[0]?.body).toContain("/verify/");
        const invite = yield* service.ensure(address);
        if (invite._tag !== "Invited")
          return yield* Effect.die(new Error("Expected a Channel Link Invite"));
        const token = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
          invite.verificationUrl.pathname.split("/").at(-1) ?? "",
        );
        yield* service.accept(Redacted.make(token), UserId.make(owner.userId));
        const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
        const accepted = yield* Effect.promise(() => send());
        expect(accepted.status).toBe(200);
        const submissionId = yield* Effect.promise(() =>
          messengerSubmissionId(
            "whatsapp",
            "whatsapp:123456789:15555550101",
            "wamid.durable-acceptance",
          ),
        );
        const inspected = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const agent = await host.subAgent(OsfoAgent, owner.agentId);
            return agent.inspectSubmission(submissionId);
          }),
        );
        expect(inspected).toMatchObject({ submissionId });
        const replay = yield* Effect.promise(() => send());
        expect(replay.status).toBe(200);
        const recorded = yield* Effect.promise(() =>
          database
            .select()
            .from(allowanceUsage)
            .where(eq(allowanceUsage.source_id, "whatsapp:wamid.durable-acceptance")),
        );
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ allowance_kind: "acceptedMessages", quantity: 1n });
        const completed = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const agent = await host.subAgent(OsfoAgent, owner.agentId);
            return agent.waitForSubmission(submissionId);
          }),
        );
        expect(completed.status).toBe("completed");
        const delivered = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const fiber = (await host.listFibers()).find(
              (candidate) => candidate.name === "think:messenger-reply",
            );
            if (fiber === undefined) throw new Error("Missing accepted reply fiber");
            return host.startFiber("think:messenger-reply", async () => {}, {
              fiberId: fiber.fiberId,
              waitForCompletion: true,
            });
          }),
        );
        expect(delivered).toMatchObject({
          status: "completed",
          snapshot: { stage: "completed", acceptance: { submissionId } },
        });
        expect((yield* Effect.promise(() => send())).status).toBe(200);
        const ledger = yield* readLedger;
        const entries = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ body: Schema.String })),
        )(ledger);
        expect(entries).toHaveLength(2);
        expect(entries[1]?.body).toContain("text");
        const afterReplay = yield* Effect.promise(() =>
          database
            .select()
            .from(allowanceUsage)
            .where(eq(allowanceUsage.source_id, "whatsapp:wamid.durable-acceptance")),
        );
        expect(afterReplay).toEqual(recorded);
        const snapshot = parseMessengerReplySnapshot(delivered.snapshot);
        if (snapshot === null)
          return yield* Effect.die(new Error("Missing native reply checkpoint"));
        const receipt = yield* Schema.decodeUnknownEffect(MessengerAcceptanceReceipt)(
          snapshot.acceptance,
        );
        const messengerContext = messengerContextFromEvent(snapshot.event);
        const follow = async () => directory.followMessengerInput(receipt, messengerContext);
        const originalReply = yield* Schema.decodeUnknownEffect(Schema.String)(
          yield* Effect.promise(follow),
        );
        yield* Effect.promise(() =>
          database.execute(
            sql`ALTER TABLE channel_links RENAME TO channel_links_temporarily_unavailable`,
          ),
        );
        yield* Effect.gen(function* () {
          expect(yield* Effect.promise(follow)).toEqual({ kind: "unavailable" });
        }).pipe(
          Effect.ensuring(
            Effect.promise(() =>
              database.execute(
                sql`ALTER TABLE channel_links_temporarily_unavailable RENAME TO channel_links`,
              ),
            ),
          ),
        );
        expect(yield* Effect.promise(follow)).toBe(originalReply);
        yield* Effect.promise(() =>
          database.insert(userSuspensionEvents).values({
            event_id: "messenger-owner-suspended",
            user_id: owner.userId,
            action: "suspended",
            admin_actor_id: "messenger-test-authority",
            reason: "Verify current authority",
            occurred_at: new Date("2026-08-27T12:00:00.000Z"),
          }),
        );
        expect(yield* Effect.promise(follow)).toBeNull();
        yield* Effect.promise(() =>
          database.insert(userSuspensionEvents).values({
            event_id: "messenger-owner-restored",
            user_id: owner.userId,
            action: "restored",
            admin_actor_id: "messenger-test-authority",
            reason: "Restore test authority",
            occurred_at: new Date("2026-08-27T12:01:00.000Z"),
          }),
        );
        expect(yield* Effect.promise(follow)).toBe(originalReply);
        yield* Effect.promise(() =>
          database.insert(whatsappWakeups).values({
            wakeup_id: "later-wakeup",
            user_id: owner.userId,
            channel_link_id: receipt.channelLinkId,
            fingerprint: "a".repeat(64),
            endpoint_fingerprint: "b".repeat(64),
            source_kind: "reminder",
            source_identity: "later-reminder",
            source_committed_at: new Date("2026-08-27T12:02:00.000Z"),
            locale: "en",
            template_policy_version: "whatsapp-wakeup-v1",
            trace_id: "later-wakeup-trace",
          }),
        );
        const readWakeup = () =>
          database
            .select()
            .from(whatsappWakeups)
            .where(eq(whatsappWakeups.wakeup_id, "later-wakeup"));
        const laterWakeup = yield* Effect.promise(readWakeup);
        expect((yield* Effect.promise(() => send())).status).toBe(200);
        expect(yield* Effect.promise(readWakeup)).toEqual(laterWakeup);
        const changed = yield* Effect.promise(() =>
          send(body.replace("Hello, please acknowledge this message.", "Changed provider input")),
        );
        expect(changed.status).toBe(503);
        expect(yield* Effect.promise(readWakeup)).toEqual(laterWakeup);
        yield* Effect.promise(() =>
          database.delete(whatsappWakeups).where(eq(whatsappWakeups.wakeup_id, "later-wakeup")),
        );
        const unadmittedBody = body.replace(
          "wamid.durable-acceptance",
          "wamid.before-child-receipt",
        );
        const unadmittedSubmissionId = yield* Effect.promise(() =>
          messengerSubmissionId("whatsapp", receipt.threadId, "wamid.before-child-receipt"),
        );
        yield* Effect.promise(() =>
          runInDurableObject(directory, (host) => {
            vi.spyOn(host, "acceptMessengerInput").mockResolvedValue({ kind: "unavailable" });
            vi.spyOn(host, "alarm").mockResolvedValue(undefined);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
        expect((yield* Effect.promise(() => send(unadmittedBody))).status).toBe(503);
        const unadmitted = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const replies = await host.listFibers();
            return replies.find(
              (candidate) =>
                parseMessengerReplySnapshot(candidate.snapshot)?.event.message
                  ?.providerMessageId === "wamid.before-child-receipt",
            );
          }),
        );
        expect(unadmitted).toMatchObject({
          snapshot: {
            stage: "admitting",
            acceptance: {
              agentId: owner.agentId,
              channelLinkId: receipt.channelLinkId,
              userId: owner.userId,
            },
          },
        });
        expect(
          (yield* Effect.promise(() =>
            app.fetch(`/v1/channel-links/${receipt.channelLinkId}`, { method: "DELETE" }),
          )).status,
        ).toBe(200);
        const sameOwnerInvite = yield* service.ensure(address);
        if (sameOwnerInvite._tag !== "Invited")
          return yield* Effect.die(new Error("Expected a replacement Channel Link"));
        const sameOwnerToken = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
          sameOwnerInvite.verificationUrl.pathname.split("/").at(-1) ?? "",
        );
        // Distinct link incarnations must not share the test clock's frozen creation timestamp.
        yield* TestClock.adjust(Duration.millis(1));
        yield* service.accept(Redacted.make(sameOwnerToken), UserId.make(owner.userId));
        const currentLink = yield* service.resolveConversation(address);
        if (currentLink._tag !== "Linked")
          return yield* Effect.die(new Error("Expected the same User's new Channel Link"));
        expect(currentLink.link.channelLinkId).not.toBe(receipt.channelLinkId);
        yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            vi.restoreAllMocks();
            await host.alarm();
          }),
        );
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            expect((await send(unadmittedBody)).status).toBe(200);
          }),
        );
        const deniedAdmission = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const checkpoint = parseMessengerReplySnapshot(unadmitted?.snapshot);
            if (!checkpoint?.userMessage) throw new Error("Missing original provider input");
            const agent = await host.subAgent(OsfoAgent, owner.agentId);
            const outcome = await agent.acceptMessengerInput(
              checkpoint.userMessage,
              messengerContextFromEvent(checkpoint.event),
              checkpoint.acceptance,
            );
            const submission = await agent.inspectSubmission(unadmittedSubmissionId);
            return { outcome, submission };
          }),
        );
        expect(deniedAdmission).toEqual({ outcome: { kind: "suppressed" }, submission: null });
        expect(
          yield* Effect.promise(() =>
            database
              .select()
              .from(allowanceUsage)
              .where(eq(allowanceUsage.source_id, "whatsapp:wamid.before-child-receipt")),
          ),
        ).toHaveLength(0);
        expect(yield* readLedger).toEqual(ledger);
        const interruptedBody = body.replace(
          "wamid.durable-acceptance",
          "wamid.before-directory-ack",
        );
        const interruptedSubmissionId = yield* Effect.promise(() =>
          messengerSubmissionId("whatsapp", receipt.threadId, "wamid.before-directory-ack"),
        );
        yield* Effect.promise(() =>
          runInDurableObject(directory, (host) => {
            const accept = host.acceptMessengerInput.bind(host);
            vi.spyOn(host, "acceptMessengerInput").mockImplementation(async (...input) => {
              const result = await accept(...input);
              return Schema.is(MessengerAcceptanceReceipt)(result)
                ? { kind: "unavailable" as const }
                : result;
            });
            vi.spyOn(host, "alarm").mockResolvedValue(undefined);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
        expect((yield* Effect.promise(() => send(interruptedBody))).status).toBe(503);
        const partial = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const agent = await host.subAgent(OsfoAgent, owner.agentId);
            const submission = await agent.inspectSubmission(interruptedSubmissionId);
            const replies = await host.listFibers();
            const reply = replies.find((candidate) => {
              const checkpoint = parseMessengerReplySnapshot(candidate.snapshot);
              return checkpoint?.event.message?.providerMessageId === "wamid.before-directory-ack";
            });
            return { reply, submission };
          }),
        );
        expect(partial.submission).toMatchObject({ submissionId: interruptedSubmissionId });
        expect(partial.reply).toMatchObject({
          snapshot: { stage: "admitting", acceptance: { kind: "route", agentId: owner.agentId } },
        });
        expect(
          (yield* Effect.promise(() =>
            app.fetch(`/v1/channel-links/${currentLink.link.channelLinkId}`, { method: "DELETE" }),
          )).status,
        ).toBe(200);
        const replacementInvite = yield* service.ensure(address);
        if (replacementInvite._tag !== "Invited")
          return yield* Effect.die(new Error("Expected replacement invitation"));
        const replacementToken = yield* Schema.decodeEffect(ChannelLinks.ChannelLinkInviteToken)(
          replacementInvite.verificationUrl.pathname.split("/").at(-1) ?? "",
        );
        yield* TestClock.adjust(Duration.millis(1));
        yield* service.accept(Redacted.make(replacementToken), UserId.make(otherOwner.userId));
        expect((yield* Effect.promise(() => send(interruptedBody))).status).toBe(503);
        yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            vi.restoreAllMocks();
            await host.alarm();
          }),
        );
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            expect((await send(interruptedBody)).status).toBe(200);
          }),
        );
        const replacementSubmission = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const agent = await host.subAgent(OsfoAgent, otherOwner.agentId);
            return agent.inspectSubmission(interruptedSubmissionId);
          }),
        );
        expect(replacementSubmission).toBeNull();
        const partialAccounting = yield* Effect.promise(() =>
          database
            .select()
            .from(allowanceUsage)
            .where(eq(allowanceUsage.source_id, "whatsapp:wamid.before-directory-ack")),
        );
        expect(partialAccounting).toHaveLength(1);
        expect(partialAccounting[0]?.quantity).toBe(1n);
        expect((yield* Effect.promise(() => send())).status).toBe(200);
        const otherSubmission = yield* Effect.promise(() =>
          runInDurableObject(directory, async (host) => {
            const agent = await host.subAgent(OsfoAgent, otherOwner.agentId);
            return agent.inspectSubmission(submissionId);
          }),
        );
        expect(otherSubmission).toBeNull();
        expect(yield* Effect.promise(follow)).toBeNull();
        expect(
          yield* Effect.promise(() =>
            database
              .select()
              .from(allowanceUsage)
              .where(eq(allowanceUsage.source_id, "whatsapp:wamid.durable-acceptance")),
          ),
        ).toEqual(recorded);
        expect(yield* readLedger).toEqual(ledger);
        return undefined;
      }).pipe(
        Effect.provide(
          ChannelLinks.layerFromConfig(loadConfig(env)).pipe(
            Layer.provideMerge(Layer.merge(Db.layer({ db: env.DB }), BrowserCrypto.layer)),
          ),
        ),
      ),
    ),
);
