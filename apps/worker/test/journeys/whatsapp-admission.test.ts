/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, effecttsgo/node-builtin-import, effecttsgo/global-fetch-in-effect, eslint/no-underscore-dangle -- This journey owns the signed provider request and native RPC/PostgreSQL composition. */
import { createHmac } from "node:crypto";
import { BrowserCrypto } from "@effect/platform-browser";
import { allowanceUsage } from "@osfo/db/schema/allowances";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { inject } from "vitest";
import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted, Schema } from "effect";

import { OsfoAgent, messengerSubmissionId } from "../../src/agents/osfo/agent";
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
        const owner = yield* Effect.promise(() =>
          app.auth.mintVerifiedUser({
            profile: { helpAreas: [], locale: "en", preferredName: "Messenger Owner" },
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
