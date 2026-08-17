import { agents } from "@osfo/db/schema/agents";
import { channelBindings, providerEventReceipts } from "@osfo/db/schema/onboarding";
import { and, eq, isNull } from "drizzle-orm";
import { DateTime, Effect, Layer, Schema } from "effect";

import { database, type Database } from "../../db";
import * as Billing from "../../db/billing";
import { AgentId, ChannelBindingId, UserId } from "../../domain";
import { retainedCatalog } from "../../domain/plan-policy";
import * as Allowances from "../../services/allowances";
import * as MessagingAdmission from "../../services/messaging-admission";

/* oxlint-disable effecttsgo/async-function -- Drizzle transaction callbacks require Promise control flow. */

const BoundRouteRecord = Schema.Struct({
  agentId: AgentId,
  channelBindingId: ChannelBindingId,
  userId: UserId,
});

/** PostgreSQL binding resolution and accepted-message consumption. */
export const make = Effect.gen(function* () {
  const db = yield* database;
  const billing = Billing.make(db);
  const allowances = Allowances.make({
    billing,
    catalog: retainedCatalog,
    now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
  });

  const begin: MessagingAdmission.PersistencePort["begin"] = (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      const result = yield* Effect.tryPromise({
        try: () => beginTransaction(db, input, now),
        catch: (cause) => unavailable("beginProviderEvent", cause),
      });
      if ("_tag" in result) return result;
      const route = yield* Schema.decodeEffect(BoundRouteRecord)(result).pipe(
        Effect.mapError((cause) => unavailable("decodeBinding", cause)),
      );
      const allowance = yield* billing
        .admit(route.userId, now)
        .pipe(Effect.mapError((cause) => unavailable("readAllowance", cause)));
      return {
        ...route,
        allowance: { _tag: "Metered" as const, ...allowance },
        now,
      };
    });

  return MessagingAdmission.Persistence.of({
    begin,
    complete: (input, now) =>
      Effect.tryPromise({
        try: () =>
          db
            .update(providerEventReceipts)
            .set({ completedAt: now, leaseExpiresAt: null, state: "completed" })
            .where(
              and(
                eq(providerEventReceipts.provider, input.provider),
                eq(providerEventReceipts.eventId, input.eventId),
              ),
            ),
        catch: (cause) => unavailable("completeProviderEvent", cause),
      }).pipe(Effect.asVoid),
    recordAccepted: (allowancePeriodId, submissionId) =>
      allowances
        .record(allowancePeriodId, { sourceId: submissionId, sourceType: "ThinkSubmission" }, [
          { allowanceKind: "acceptedMessages", basis: "known_at_start", quantity: 1n },
        ])
        .pipe(
          Effect.asVoid,
          Effect.mapError((cause) => unavailable("recordAcceptedMessage", cause)),
        ),
  });
});

/** PostgreSQL message-admission Layer with a request-scoped database requirement. */
export const layerWithoutDependencies = Layer.effect(MessagingAdmission.Persistence, make);

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const beginTransaction = async (
  db: Database,
  input: MessagingAdmission.MessageAdmissionInput,
  now: Date,
) =>
  db.transaction(async (transaction) => {
    const existing = await readReceipt(transaction, input);
    if (existing !== undefined) return resumeReceipt(transaction, input, existing, now);

    const [route] = await transaction
      .select({
        agentId: agents.agentId,
        channelBindingId: channelBindings.channelBindingId,
        userId: channelBindings.userId,
      })
      .from(channelBindings)
      .innerJoin(agents, eq(agents.userId, channelBindings.userId))
      .where(
        and(
          eq(channelBindings.provider, input.provider),
          eq(channelBindings.channelIdentity, input.channelIdentity),
          isNull(channelBindings.revokedAt),
        ),
      )
      .limit(1);
    if (route === undefined) return { _tag: "Unbound" } as const;
    const inserted = await transaction
      .insert(providerEventReceipts)
      .values({
        agentId: route.agentId,
        channelBindingId: route.channelBindingId,
        eventId: input.eventId,
        leaseExpiresAt: leaseExpiry(now),
        provider: input.provider,
        purpose: "admission",
        userId: route.userId,
      })
      .onConflictDoNothing()
      .returning({ eventId: providerEventReceipts.eventId });
    if (inserted.length > 0) return route;
    const raced = await readReceipt(transaction, input);
    if (raced === undefined) return { _tag: "InProgress" } as const;
    return resumeReceipt(transaction, input, raced, now);
  });

const readReceipt = (transaction: Transaction, input: MessagingAdmission.MessageAdmissionInput) =>
  transaction
    .select({
      agentId: providerEventReceipts.agentId,
      channelBindingId: providerEventReceipts.channelBindingId,
      completedAt: providerEventReceipts.completedAt,
      leaseExpiresAt: providerEventReceipts.leaseExpiresAt,
      purpose: providerEventReceipts.purpose,
      state: providerEventReceipts.state,
      userId: providerEventReceipts.userId,
    })
    .from(providerEventReceipts)
    .where(
      and(
        eq(providerEventReceipts.provider, input.provider),
        eq(providerEventReceipts.eventId, input.eventId),
      ),
    )
    .for("update")
    .limit(1)
    .then((rows) => rows[0]);

type Receipt = NonNullable<Awaited<ReturnType<typeof readReceipt>>>;

const resumeReceipt = async (
  transaction: Transaction,
  input: MessagingAdmission.MessageAdmissionInput,
  receipt: Receipt,
  now: Date,
) => {
  if (receipt.state === "completed") return { _tag: "Duplicate" } as const;
  if (receipt.state === "outbound_attempted") return { _tag: "Duplicate" } as const;
  if (receipt.purpose === "onboarding") {
    return receipt.leaseExpiresAt !== null && receipt.leaseExpiresAt.getTime() > now.getTime()
      ? ({ _tag: "InProgress" } as const)
      : ({ _tag: "Unbound" } as const);
  }
  if (
    receipt.leaseExpiresAt === null ||
    receipt.agentId === null ||
    receipt.channelBindingId === null ||
    receipt.userId === null
  ) {
    return { _tag: "InProgress" } as const;
  }
  if (receipt.leaseExpiresAt.getTime() > now.getTime()) {
    return { _tag: "InProgress" } as const;
  }
  await transaction
    .update(providerEventReceipts)
    .set({ leaseExpiresAt: leaseExpiry(now) })
    .where(
      and(
        eq(providerEventReceipts.provider, input.provider),
        eq(providerEventReceipts.eventId, input.eventId),
      ),
    );
  return {
    agentId: receipt.agentId,
    channelBindingId: receipt.channelBindingId,
    userId: receipt.userId,
  };
};

const leaseExpiry = (now: Date) =>
  DateTime.toDateUtc(DateTime.add(DateTime.makeUnsafe(now), { minutes: 1 }));

const unavailable = (operation: string, cause: unknown) =>
  new MessagingAdmission.MessagingAdmissionUnavailable({
    cause,
    message: "Messaging admission is temporarily unavailable",
    operation,
  });
