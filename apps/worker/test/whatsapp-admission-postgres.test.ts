import { expect, layer } from "@effect/vitest";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { DateTime, Deferred, Effect, Fiber, Schema } from "effect";

import { layerFromDatabase } from "../src/db";
import * as Billing from "../src/db/billing";
import {
  AllowancePeriodId,
  AcceptanceReceiptId,
  ChannelBindingId,
  ChannelIdentity,
  ProviderMessageId,
  SessionId,
  ThinkSubmissionId,
  UserMessageId,
  UserId,
} from "../src/domain";
import { retainedCatalog } from "../src/domain/plan-policy";
import {
  makeChannelBindingAuthority,
  readCurrentBinding,
} from "../src/integrations/postgres/onboarding";
import { make } from "../src/integrations/postgres/whatsapp-admission";
import * as Allowances from "../src/services/allowances";
import { AuthorizationContext } from "../src/services/authorization";
import * as WhatsAppAgentAdmission from "../src/services/whatsapp-agent-admission";
import { AcceptanceReceipt } from "../src/services/whatsapp-acceptance-receipt";
import {
  type AgentAcceptanceInput,
  InboundWhatsAppMessage,
  make as makeAdmission,
  WhatsAppMessageText,
} from "../src/services/whatsapp-admission";

const fixture = Effect.runSync(makeTestDatabase);
await Effect.runPromise(applyMigrations(fixture.client));

layer(layerFromDatabase(fixture.database))("WhatsApp admission PostgreSQL", (it) => {
  it.effect(
    "records one receipt use for concurrent delivery before and after first acceptance",
    () =>
      Effect.gen(function* () {
        const database = fixture.database;
        const seeded = yield* Effect.promise(() =>
          seedBoundUser(database, "concurrent", "14165550131"),
        );
        const input = routeMessage("14165550131", "wamid.concurrent");
        const arrivals = yield* Deferred.make<void>();
        const receipts = new Map<string, AcceptanceReceipt>();
        let waiting = 0;
        const admission = yield* makeRealAdmission(database, (acceptance) =>
          Effect.gen(function* () {
            waiting += 1;
            if (waiting === 2) yield* Deferred.succeed(arrivals, undefined);
            yield* Deferred.await(arrivals);
            const existing = receipts.get(acceptance.submissionId);
            if (existing !== undefined) return existing;
            const receipt = receiptFromAcceptance(acceptance);
            receipts.set(acceptance.submissionId, receipt);
            return receipt;
          }),
        );

        const concurrent = yield* Effect.all([admission.admit(input), admission.admit(input)], {
          concurrency: "unbounded",
        });
        const replay = yield* admission.admit(input);
        const usage = yield* Effect.promise(() =>
          database
            .select()
            .from(allowanceUsage)
            .where(eq(allowanceUsage.allowancePeriodId, seeded.allowancePeriodId)),
        );
        const accepted = yield* Schema.decodeUnknownEffect(
          Schema.TaggedStruct("MessageAccepted", { receipt: AcceptanceReceipt }),
        )(concurrent[0]);

        expect(concurrent[1]).toEqual(concurrent[0]);
        expect(replay).toEqual(concurrent[0]);
        expect(receipts.size).toBe(1);
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({
          allowanceKind: "acceptedMessages",
          basis: "known_at_start",
          quantity: 1n,
          sourceId: accepted.receipt.receiptId,
          sourceType: "acceptanceReceipt",
        });
      }),
  );

  it.effect("writes no acceptedMessages use for a proven Agent rejection", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      const seeded = yield* Effect.promise(() =>
        seedBoundUser(database, "rejected", "14165550132"),
      );
      const admission = yield* makeRealAdmission(database, () =>
        Effect.succeed({
          _tag: "ManagedConversationDenied" as const,
          reason: "allowanceExhausted",
        }),
      );

      const outcome = yield* admission.admit(routeMessage("14165550132", "wamid.rejected"));
      const usage = yield* Effect.promise(() =>
        database
          .select()
          .from(allowanceUsage)
          .where(eq(allowanceUsage.allowancePeriodId, seeded.allowancePeriodId)),
      );

      expect(outcome).toEqual({ _tag: "MessageDenied", reason: "allowanceExhausted" });
      expect(usage).toEqual([]);
    }),
  );

  it.effect("records recovered acceptance against the originally admitted allowance period", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      const seeded = yield* Effect.promise(() =>
        seedBoundUser(database, "original-period", "14165550133"),
      );
      const routed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const admission = yield* makeRealAdmission(database, (acceptance) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(routed, undefined);
          yield* Deferred.await(release);
          return receiptFromAcceptance(acceptance);
        }),
      );
      const fiber = yield* Effect.forkChild(
        admission.admit(routeMessage("14165550133", "wamid.original-period")),
      );
      yield* Deferred.await(routed);
      yield* Effect.promise(() =>
        database.insert(allowancePeriods).values({
          allowancePeriodId: "period-original-period-later",
          billingSubscriptionId: "subscription-original-period",
          endsAt: date("2026-10-01T00:00:00.000Z"),
          plan: "free",
          planPolicyVersion: "launch-v1",
          startsAt: date("2026-09-01T00:00:00.000Z"),
          userId: seeded.userId,
        }),
      );
      yield* Deferred.succeed(release, undefined);
      const outcome = yield* Fiber.join(fiber);
      const usage = yield* Effect.promise(() =>
        database
          .select()
          .from(allowanceUsage)
          .where(eq(allowanceUsage.sourceType, "acceptanceReceipt")),
      );
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ receipt: AcceptanceReceipt }),
      )(outcome).pipe(Effect.map((accepted) => accepted.receipt));
      const recorded = usage.filter((row) => row.sourceId === receipt.receiptId);

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.allowancePeriodId).toBe(seeded.allowancePeriodId);
      expect(recorded[0]?.allowancePeriodId).not.toBe("period-original-period-later");
    }),
  );

  it.effect("denies a binding revoked after routing before any new Think submission", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      yield* Effect.promise(() => seedBoundUser(database, "revocation-race", "14165550134"));
      const persistence = yield* make({
        now: Effect.succeed(date("2026-08-16T12:00:00.000Z")),
      });
      const message = routeMessage("14165550134", "wamid.revocation-race");
      const routed = yield* persistence.route({ ...message, contentDigest: "race-digest" });
      const bound = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          agentId: Schema.String,
          authorization: Schema.Unknown,
          channelBindingId: ChannelBindingId,
        }),
      )(routed);
      const authorization = yield* Schema.decodeUnknownEffect(AuthorizationContext)(
        bound.authorization,
      );
      yield* Effect.promise(() =>
        database
          .update(channelBindings)
          .set({ revokedAt: date("2026-08-16T12:00:01.000Z") })
          .where(eq(channelBindings.channelBindingId, bound.channelBindingId)),
      );
      const submissions = new Map<string, WhatsAppAgentAdmission.SubmissionInput>();
      const authority = makeChannelBindingAuthority(database);

      const denied = yield* WhatsAppAgentAdmission.accept({
        dependencies: {
          authority: {
            readCurrentBinding: (query) =>
              authority.readCurrentBinding(query).pipe(
                Effect.mapError(
                  (cause) =>
                    new WhatsAppAgentAdmission.WhatsAppAuthorityUnavailable({
                      cause,
                      message: "Current binding could not be read",
                    }),
                ),
              ),
          },
          store: {
            inspect: () => Effect.die("receipt store must not be read after authority denial"),
            readAcceptanceReceipt: () => Effect.succeed(null),
            recordAcceptanceReceipt: () =>
              Effect.die("receipt must not be written after authority denial"),
          },
          think: {
            inspect: () => Effect.succeed(null),
            submit: (submission) =>
              Effect.sync(() => {
                submissions.set(submission.submissionId, submission);
                return { submissionId: submission.submissionId };
              }),
          },
        },
        input: {
          authorization,
          channelBindingId: bound.channelBindingId,
          message: message.message,
          providerMessageId: message.providerMessageId,
          receiptId: AcceptanceReceiptId.make("receipt-revocation-race"),
          submissionId: ThinkSubmissionId.make("submission-revocation-race"),
          userMessageId: UserMessageId.make("message-revocation-race"),
        },
      });

      expect(denied).toEqual({
        _tag: "ManagedConversationDenied",
        reason: "authorityRevoked",
        resetAt: null,
      });
      expect(submissions.size).toBe(0);
    }),
  );

  it.effect("keeps the first binding after revocation and replacement", () =>
    Effect.gen(function* () {
      const admission = yield* make({ now: Effect.succeed(date("2026-08-16T12:00:00.000Z")) });
      const database = fixture.database;
      yield* Effect.promise(() => seedBoundUser(database, "old", "14165550123"));
      const first = yield* admission.route(routeInput());
      yield* Effect.promise(() =>
        database
          .update(channelBindings)
          .set({ revokedAt: date("2026-08-16T12:05:00.000Z") })
          .where(eq(channelBindings.channelBindingId, "binding-old")),
      );
      yield* Effect.promise(() => seedBoundUser(database, "new", "14165550123"));

      const repeated = yield* admission.route(routeInput());
      const oldAuthority = yield* readCurrentBinding({
        channelBindingId: ChannelBindingId.make("binding-old"),
        userId: UserId.make("user-old"),
      });
      const newAuthority = yield* readCurrentBinding({
        channelBindingId: ChannelBindingId.make("binding-new"),
        userId: UserId.make("user-new"),
      });

      expect(first).toMatchObject({ _tag: "Bound", channelBindingId: "binding-old" });
      expect(repeated).toMatchObject({
        _tag: "Bound",
        authorization: { authority: { _tag: "RevokedChannelBinding" } },
        channelBindingId: "binding-old",
      });
      expect(oldAuthority).toBeNull();
      expect(newAuthority).toMatchObject({
        channelBindingId: "binding-new",
        channelIdentity: "14165550123",
        userId: "user-new",
      });
    }),
  );

  it.effect("keeps an unbound first resolution after later enrollment", () =>
    Effect.gen(function* () {
      const admission = yield* make({ now: Effect.succeed(date("2026-08-16T12:00:00.000Z")) });
      const database = fixture.database;
      const input = {
        ...routeInput(),
        channelIdentity: ChannelIdentity.make("14165550124"),
        providerMessageId: ProviderMessageId.make("wamid.unbound"),
      };
      const first = yield* admission.route(input);
      yield* Effect.promise(() => seedBoundUser(database, "later", "14165550124"));

      const repeated = yield* admission.route(input);

      expect(first).toEqual({ _tag: "Unbound" });
      expect(repeated).toEqual({ _tag: "Unbound" });
    }),
  );

  it.effect("rejects changed message facts under one provider event key", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      const seeded = yield* Effect.promise(() =>
        seedBoundUser(database, "changed-facts", "14165550135"),
      );
      const admission = yield* makeRealAdmission(database, (acceptance) =>
        Effect.succeed(receiptFromAcceptance(acceptance)),
      );
      const input = routeMessage("14165550135", "wamid.conflict");
      const accepted = yield* admission.admit(input);

      const conflict = yield* Effect.flip(
        admission.admit({
          ...input,
          message: WhatsAppMessageText.make("Changed"),
        }),
      );
      const receipt = yield* Schema.decodeUnknownEffect(
        Schema.TaggedStruct("MessageAccepted", { receipt: AcceptanceReceipt }),
      )(accepted).pipe(Effect.map((outcome) => outcome.receipt));
      const usage = yield* Effect.promise(() =>
        database
          .select()
          .from(allowanceUsage)
          .where(eq(allowanceUsage.allowancePeriodId, seeded.allowancePeriodId)),
      );

      expect(conflict).toMatchObject({ _tag: "InboundWhatsAppEventConflict" });
      expect(usage).toHaveLength(1);
      expect(usage[0]?.sourceId).toBe(receipt.receiptId);
    }),
  );
});

const makeRealAdmission = (
  database: typeof fixture.database,
  accept: (
    input: AgentAcceptanceInput,
  ) => Effect.Effect<
    AcceptanceReceipt | { readonly _tag: "ManagedConversationDenied"; readonly reason: string }
  >,
) =>
  Effect.gen(function* () {
    const now = date("2026-08-16T12:00:00.000Z");
    const persistence = yield* make({ now: Effect.succeed(now) });
    const allowances = Allowances.make({
      billing: Billing.make(database),
      catalog: retainedCatalog,
      now: Effect.succeed(now),
    });
    return makeAdmission({
      agent: { accept: (_agentId, input) => accept(input) },
      allowances: {
        recordAcceptedMessage: (receipt) =>
          allowances
            .record(
              receipt.allowancePeriodId,
              { sourceId: receipt.receiptId, sourceType: "acceptanceReceipt" },
              [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
            )
            .pipe(Effect.orDie, Effect.asVoid),
      },
      onboarding: { handle: () => Effect.succeed({ _tag: "OnboardingAccepted" }) },
      persistence: { route: (input) => persistence.route(input) },
    });
  });

const receiptFromAcceptance = (input: AgentAcceptanceInput): AcceptanceReceipt => {
  const allowance = Schema.decodeUnknownSync(
    Schema.Struct({ allowancePeriodId: AllowancePeriodId }),
  )(input.authorization.allowance);
  return Schema.decodeSync(AcceptanceReceipt)({
    _tag: "AcceptanceReceipt",
    acceptedAt: "2026-08-16T12:00:00Z",
    allowancePeriodId: allowance.allowancePeriodId,
    channelBindingId: input.channelBindingId,
    providerMessageId: input.providerMessageId,
    receiptId: input.receiptId,
    sessionId: SessionId.make(`session-${input.submissionId}`),
    thinkSubmissionId: input.submissionId,
    userMessageId: input.userMessageId,
  });
};

const routeMessage = (channelIdentity: string, providerMessageId: string) =>
  Schema.decodeSync(InboundWhatsAppMessage)({
    _tag: "TextMessage",
    channelIdentity,
    message: "Please help",
    phoneNumberId: "123456789",
    providerMessageId,
  });

const routeInput = () => ({
  ...Schema.decodeSync(InboundWhatsAppMessage)({
    _tag: "TextMessage",
    channelIdentity: ChannelIdentity.make("14165550123"),
    message: "Please help",
    phoneNumberId: "123456789",
    providerMessageId: ProviderMessageId.make("wamid.1"),
  }),
  contentDigest: "digest-1",
});

// oxlint-disable-next-line effecttsgo/async-function -- test fixture: Drizzle setup is a contained Promise boundary.
const seedBoundUser = async (
  database: typeof fixture.database,
  suffix: string,
  channelIdentity: string,
) => {
  const userId = `user-${suffix}`;
  await database.insert(users).values({
    email: `${userId}@invalid.example`,
    id: userId,
    name: `User ${suffix}`,
  });
  await database.insert(agents).values({
    agentId: `agent-${suffix}`,
    createdAt: "2026-08-16T12:00:00.000Z",
    userId,
  });
  await database.insert(billingSubscriptions).values({
    billingSubscriptionId: `subscription-${suffix}`,
    plan: "free",
    planPolicyVersion: "launch-v1",
    userId,
  });
  await database.insert(allowancePeriods).values({
    allowancePeriodId: `period-${suffix}`,
    billingSubscriptionId: `subscription-${suffix}`,
    endsAt: date("2026-09-01T00:00:00.000Z"),
    plan: "free",
    planPolicyVersion: "launch-v1",
    startsAt: date("2026-08-01T00:00:00.000Z"),
    userId,
  });
  await database.insert(channelBindings).values({
    channelBindingId: `binding-${suffix}`,
    channelIdentity,
    provider: "whatsapp",
    userId,
  });
  return {
    allowancePeriodId: AllowancePeriodId.make(`period-${suffix}`),
    userId: UserId.make(userId),
  };
};

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
