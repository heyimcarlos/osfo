import { expect, layer } from "@effect/vitest";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { deletionCases, userSuspensionEvents } from "@osfo/db/schema/user-lifecycle";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { DateTime, Deferred, Effect, Fiber, Schema } from "effect";

import { layerFromDatabase } from "../src/db";
import * as Billing from "../src/db/billing";
import {
  AgentId,
  AllowancePeriodId,
  AcceptanceReceiptId,
  ChannelBindingId,
  ChannelIdentity,
  ProviderMessageId,
  ThinkSubmissionId,
  UserMessageId,
  UserId,
} from "../src/domain";
import { retainedCatalog } from "../src/domain/plan-policy";
import * as ChannelBindingPostgres from "../src/integrations/postgres/channel-binding";
import { make } from "../src/integrations/postgres/whatsapp-admission";
import * as Allowances from "../src/services/allowances";
import type { ManagedConversationDenied } from "../src/services/managed-conversation";
import * as WhatsAppAgentAdmission from "../src/services/whatsapp-agent-admission";
import { AcceptanceReceipt } from "../src/services/provider-acceptance-receipt";
import {
  type AgentAcceptanceInput,
  type AgentRecoveryInput,
  InboundWhatsAppMessage,
  WhatsAppMessageText,
} from "../src/services/whatsapp-admission";
import {
  makeWhatsAppAdmissionFixture,
  providerContentDigest,
  receiptFromAcceptance,
  recoveredReceipt,
  routeMessage,
} from "./whatsapp-admission-fixture";

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
        const admission = yield* makeRealAdmission(
          database,
          (acceptance) =>
            Effect.gen(function* () {
              waiting += 1;
              if (waiting === 2) yield* Deferred.succeed(arrivals, undefined);
              yield* Deferred.await(arrivals);
              const existing = receipts.get(acceptance.submissionId);
              if (existing !== undefined) return existing;
              const receipt = receiptFromAcceptance(acceptance, seeded.allowancePeriodId);
              receipts.set(acceptance.submissionId, receipt);
              return receipt;
            }),
          {
            recover: (recovery) => Effect.succeed(receipts.get(recovery.submissionId) ?? null),
          },
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
          resetAt: null,
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

  it.effect("denies a User suspended after initial admission before new Think submission", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      yield* Effect.promise(() => seedBoundUser(database, "suspended", "14165550137"));

      const denied = yield* admitThroughAgent(routeMessage("14165550137", "wamid.suspended"), {
        afterInitialAdmission: Effect.promise(() =>
          database.insert(userSuspensionEvents).values({
            action: "suspended",
            adminActorId: "admin-whatsapp-suspended",
            eventId: "suspension-whatsapp-suspended",
            reason: "Current authority test",
            userId: "user-suspended",
          }),
        ).pipe(Effect.asVoid),
      });

      expect(denied.outcome).toEqual({
        _tag: "ManagedConversationDenied",
        reason: "userSuspended",
        resetAt: null,
      });
      expect(denied.submissions).toBe(0);
    }),
  );

  it.effect("denies deletion requested after initial admission before new Think submission", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      yield* Effect.promise(() => seedBoundUser(database, "deleting", "14165550138"));

      const denied = yield* admitThroughAgent(routeMessage("14165550138", "wamid.deleting"), {
        afterInitialAdmission: Effect.promise(() =>
          database.insert(deletionCases).values({
            deletionCaseId: "deletion-whatsapp-deleting",
            reason: "Current authority test",
            requestedByAdminId: "admin-whatsapp-deleting",
            userId: "user-deleting",
          }),
        ).pipe(Effect.asVoid),
      });

      expect(denied.outcome).toEqual({
        _tag: "ManagedConversationDenied",
        reason: "deletionAccessRevoked",
        resetAt: null,
      });
      expect(denied.submissions).toBe(0);
    }),
  );

  it.effect("denies a plan change after initial admission before new Think submission", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      yield* Effect.promise(() => seedBoundUser(database, "plan-race", "14165550139"));

      const denied = yield* admitThroughAgent(routeMessage("14165550139", "wamid.plan-race"), {
        afterInitialAdmission: Effect.promise(() =>
          database
            .update(billingSubscriptions)
            .set({ planPolicyVersion: "retired-v0" })
            .where(eq(billingSubscriptions.userId, "user-plan-race")),
        ).pipe(Effect.asVoid),
      });

      expect(denied.outcome).toEqual({
        _tag: "ManagedConversationDenied",
        reason: "policyUnavailable",
        resetAt: null,
      });
      expect(denied.submissions).toBe(0);
    }),
  );

  it.effect("denies allowance exhaustion after initial admission before new Think submission", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      const seeded = yield* Effect.promise(() =>
        seedBoundUser(database, "allowance-race", "14165550140"),
      );

      const denied = yield* admitThroughAgent(routeMessage("14165550140", "wamid.allowance-race"), {
        afterInitialAdmission: Effect.promise(() =>
          database.insert(allowanceUsage).values({
            allowanceKind: "acceptedMessages",
            allowancePeriodId: seeded.allowancePeriodId,
            basis: "known_at_start",
            quantity: 30n,
            sourceId: "receipt-existing-limit",
            sourceType: "acceptanceReceipt",
            userId: seeded.userId,
          }),
        ).pipe(Effect.asVoid),
      });

      expect(denied.outcome).toEqual({
        _tag: "ManagedConversationDenied",
        reason: "allowanceExhausted",
        resetAt: date("2026-09-01T00:00:00.000Z"),
      });
      expect(denied.submissions).toBe(0);
    }),
  );

  it.effect("does not submit when the allowance period expires after initial admission", () =>
    Effect.gen(function* () {
      const database = fixture.database;
      const seeded = yield* Effect.promise(() =>
        seedBoundUser(database, "period-race", "14165550141"),
      );
      let submissions = 0;

      const failure = yield* Effect.flip(
        admitThroughAgent(routeMessage("14165550141", "wamid.period-race"), {
          afterInitialAdmission: Effect.promise(() =>
            database
              .update(allowancePeriods)
              .set({ endsAt: date("2026-08-10T00:00:00.000Z") })
              .where(eq(allowancePeriods.allowancePeriodId, seeded.allowancePeriodId)),
          ).pipe(Effect.asVoid),
          onSubmit: () => {
            submissions += 1;
          },
        }),
      );

      expect(failure).toMatchObject({ _tag: "WhatsAppAuthorizationUnavailable" });
      expect(submissions).toBe(0);
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
          return receiptFromAcceptance(acceptance, seeded.allowancePeriodId);
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

  it.effect(
    "recovers an accepted message after its original period expires without current admission",
    () =>
      Effect.gen(function* () {
        const database = fixture.database;
        const seeded = yield* Effect.promise(() =>
          seedBoundUser(database, "expired-recovery", "14165550136"),
        );
        let freshAcceptances = 0;
        const admission = yield* makeRealAdmission(
          database,
          () =>
            Effect.sync(() => {
              freshAcceptances += 1;
              return {
                _tag: "ManagedConversationDenied" as const,
                reason: "allowanceExhausted" as const,
                resetAt: null,
              };
            }),
          {
            now: date("2026-09-02T12:00:00.000Z"),
            recover: (input) =>
              Effect.succeed(
                recoveredReceipt(input, seeded.allowancePeriodId, "2026-08-31T23:59:00Z"),
              ),
          },
        );

        const outcome = yield* admission.admit(
          routeMessage("14165550136", "wamid.expired-recovery"),
        );
        const usage = yield* Effect.promise(() =>
          database
            .select()
            .from(allowanceUsage)
            .where(eq(allowanceUsage.allowancePeriodId, seeded.allowancePeriodId)),
        );

        expect(outcome).toMatchObject({
          _tag: "MessageAccepted",
          receipt: { allowancePeriodId: seeded.allowancePeriodId },
        });
        expect(freshAcceptances).toBe(0);
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({
          allowanceKind: "acceptedMessages",
          quantity: 1n,
          sourceType: "acceptanceReceipt",
        });
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
      const routed = yield* persistence.route({ ...message, contentDigest: providerContentDigest });
      const bound = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          agentId: AgentId,
          channelBindingId: ChannelBindingId,
        }),
      )(routed);
      yield* persistence.admit({ ...bound, _tag: "Bound" });
      yield* Effect.promise(() =>
        database
          .update(channelBindings)
          .set({ revokedAt: date("2026-08-16T12:00:01.000Z") })
          .where(eq(channelBindings.channelBindingId, bound.channelBindingId)),
      );
      const submissions = new Map<string, WhatsAppAgentAdmission.WhatsAppSubmissionIntent>();

      const denied = yield* WhatsAppAgentAdmission.accept({
        dependencies: {
          authorization: {
            inspect: () =>
              persistence.admit({ ...bound, _tag: "Bound" }).pipe(
                Effect.mapError(
                  (cause) =>
                    new WhatsAppAgentAdmission.WhatsAppAuthorizationUnavailable({
                      cause,
                      message: "Current binding could not be read",
                    }),
                ),
              ),
          },
          session: {
            recover: () => Effect.die("Session command must not recover after authority denial"),
            replace: () => Effect.die("Session must not change after authority denial"),
          },
          store: {
            inspect: Effect.die("receipt store must not be read after authority denial"),
            readAcceptanceReceipt: () => Effect.succeed(null),
            readSessionCommandReceipt: () => Effect.succeed(null),
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
      const repeatedBound = yield* Schema.decodeUnknownEffect(
        Schema.TaggedStruct("Bound", {
          agentId: AgentId,
          channelBindingId: ChannelBindingId,
        }),
      )(repeated);
      const repeatedAuthorization = yield* admission.admit(repeatedBound);
      const authority = yield* ChannelBindingPostgres.make;
      const oldAuthority = yield* authority.inspect(
        UserId.make("user-old"),
        ChannelBindingId.make("binding-old"),
      );
      const newAuthority = yield* authority.inspect(
        UserId.make("user-new"),
        ChannelBindingId.make("binding-new"),
      );

      expect(first).toMatchObject({ _tag: "Bound", channelBindingId: "binding-old" });
      expect(repeated).toMatchObject({
        _tag: "Bound",
        channelBindingId: "binding-old",
      });
      expect(repeatedAuthorization).toMatchObject({
        authority: { _tag: "RevokedChannelBinding" },
      });
      expect(oldAuthority).toMatchObject({ _tag: "RevokedChannelBinding" });
      expect(newAuthority).toMatchObject({
        _tag: "ChannelBinding",
        channelBindingId: "binding-new",
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
        Effect.succeed(receiptFromAcceptance(acceptance, seeded.allowancePeriodId)),
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
  ) => Effect.Effect<AcceptanceReceipt | ManagedConversationDenied>,
  options?: {
    readonly now?: Date;
    readonly recover?: (input: AgentRecoveryInput) => Effect.Effect<AcceptanceReceipt | null>;
  },
) =>
  Effect.gen(function* () {
    const now = options?.now ?? date("2026-08-16T12:00:00.000Z");
    const persistence = yield* make({ now: Effect.succeed(now) });
    const allowances = Allowances.make({
      billing: Billing.make(database),
      catalog: retainedCatalog,
      now: Effect.succeed(now),
    });
    return makeWhatsAppAdmissionFixture<
      | Effect.Error<ReturnType<typeof persistence.admit>>
      | Effect.Error<ReturnType<typeof persistence.route>>
    >({
      accept,
      persistence: {
        admit: (route) => persistence.admit(route).pipe(Effect.asVoid),
        route: (input) => persistence.route(input),
      },
      recordAcceptedMessage: (receipt) =>
        allowances
          .record(
            receipt.allowancePeriodId,
            { sourceId: receipt.receiptId, sourceType: "acceptanceReceipt" },
            [{ allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n }],
          )
          .pipe(Effect.orDie, Effect.asVoid),
      recover: options?.recover,
    });
  });

const admitThroughAgent = (
  message: InboundWhatsAppMessage,
  options?: {
    readonly afterInitialAdmission?: Effect.Effect<void>;
    readonly onSubmit?: () => void;
  },
) =>
  Effect.gen(function* () {
    const persistence = yield* make({
      now: Effect.succeed(date("2026-08-16T12:00:00.000Z")),
    });
    const route = yield* persistence.route({
      ...message,
      contentDigest: providerContentDigest,
    });
    const bound = yield* Schema.decodeUnknownEffect(
      Schema.TaggedStruct("Bound", {
        agentId: AgentId,
        channelBindingId: ChannelBindingId,
      }),
    )(route);
    yield* persistence.admit(bound);
    yield* options?.afterInitialAdmission ?? Effect.void;
    let submissions = 0;
    const outcome = yield* WhatsAppAgentAdmission.accept({
      dependencies: {
        authorization: {
          inspect: () =>
            persistence.admit(bound).pipe(
              Effect.mapError(
                (cause) =>
                  new WhatsAppAgentAdmission.WhatsAppAuthorizationUnavailable({
                    cause,
                    message: "Current binding could not be read",
                  }),
              ),
            ),
        },
        session: {
          recover: () => Effect.die("denied authority must not recover a Session command"),
          replace: () => Effect.die("denied authority must not replace a Session"),
        },
        store: {
          inspect: Effect.die("denied lifecycle authority must not inspect Agent state"),
          readAcceptanceReceipt: () => Effect.succeed(null),
          readSessionCommandReceipt: () => Effect.succeed(null),
          recordAcceptanceReceipt: () =>
            Effect.die("denied lifecycle authority must not record a receipt"),
        },
        think: {
          inspect: () => Effect.succeed(null),
          submit: (submission) =>
            Effect.sync(() => {
              submissions += 1;
              options?.onSubmit?.();
              return { submissionId: submission.submissionId };
            }),
        },
      },
      input: {
        channelBindingId: bound.channelBindingId,
        message: message.message,
        providerMessageId: message.providerMessageId,
        receiptId: AcceptanceReceiptId.make(`receipt-${message.providerMessageId}`),
        submissionId: ThinkSubmissionId.make(`submission-${message.providerMessageId}`),
        userMessageId: UserMessageId.make(`message-${message.providerMessageId}`),
      },
    });
    return { outcome, submissions };
  });

const routeInput = () => ({
  ...Schema.decodeSync(InboundWhatsAppMessage)({
    _tag: "TextMessage",
    channelIdentity: ChannelIdentity.make("14165550123"),
    message: "Please help",
    phoneNumberId: "123456789",
    providerMessageId: ProviderMessageId.make("wamid.1"),
  }),
  contentDigest: providerContentDigest,
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
