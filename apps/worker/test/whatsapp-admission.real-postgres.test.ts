import { describe, expect, it } from "@effect/vitest";
import type { Database } from "@osfo/db";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods, allowanceUsage } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { inboundWhatsAppEvents } from "@osfo/db/schema/messaging";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { eq } from "drizzle-orm";
import { DateTime, Deferred, Effect } from "effect";

import { layerFromDatabase } from "../src/db";
import * as Billing from "../src/db/billing";
import { AllowancePeriodId, ChannelBindingId, UserId } from "../src/domain";
import { retainedCatalog } from "../src/domain/plan-policy";
import { make as makePersistence } from "../src/integrations/postgres/whatsapp-admission";
import * as Allowances from "../src/services/allowances";
import type { ManagedConversationDenied } from "../src/services/managed-conversation";
import type { AcceptanceReceipt } from "../src/services/provider-acceptance-receipt";
import type { AgentAcceptanceInput, AgentRecoveryInput } from "../src/services/whatsapp-admission";
import { WhatsAppMessageText } from "../src/services/whatsapp-admission";
import { withRealPostgresFixture } from "./real-postgres-fixture";
import {
  makeWhatsAppAdmissionFixture,
  providerContentDigest,
  receiptFromAcceptance,
  recoveredReceipt,
  routeMessage,
} from "./whatsapp-admission-fixture";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide -- Native PostgreSQL test entry points own Drizzle Promise and Layer boundaries. */

describe("WhatsApp admission with native PostgreSQL", () => {
  it.effect("records one receipt use for concurrent replay", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const seeded = yield* Effect.promise(() =>
            seedBoundUser(database, "concurrent", "14165550201"),
          );
          const arrivals = yield* Deferred.make<void>();
          const receipts = new Map<string, AcceptanceReceipt>();
          const submissions = new Set<string>();
          let freshAcceptances = 0;
          let waiting = 0;
          const admission = yield* makeRealAdmission(
            database,
            (input) =>
              Effect.gen(function* () {
                freshAcceptances += 1;
                waiting += 1;
                if (waiting === 2) yield* Deferred.succeed(arrivals, undefined);
                yield* Deferred.await(arrivals);
                submissions.add(input.submissionId);
                const existing = receipts.get(input.submissionId);
                if (existing !== undefined) return existing;
                const receipt = receiptFromAcceptance(input, seeded.allowancePeriodId);
                receipts.set(input.submissionId, receipt);
                return receipt;
              }),
            {
              recover: (input) => Effect.succeed(receipts.get(input.submissionId) ?? null),
            },
          );
          const message = routeMessage("14165550201", "wamid.native-concurrent");

          const [first, second] = yield* Effect.all(
            [admission.admit(message), admission.admit(message)],
            { concurrency: "unbounded" },
          );
          const freshAcceptancesBeforeReplay = freshAcceptances;
          const replay = yield* admission.admit(message);
          const usage = yield* Effect.promise(() =>
            database
              .select()
              .from(allowanceUsage)
              .where(eq(allowanceUsage.allowancePeriodId, seeded.allowancePeriodId)),
          );

          expect(second).toEqual(first);
          expect(replay).toEqual(first);
          expect(freshAcceptances).toBe(freshAcceptancesBeforeReplay);
          expect(submissions.size).toBe(1);
          expect(receipts.size).toBe(1);
          expect(usage).toHaveLength(1);
          expect(usage[0]).toMatchObject({
            allowanceKind: "acceptedMessages",
            basis: "known_at_start",
            quantity: 1n,
            sourceType: "acceptanceReceipt",
          });
        }),
      ),
    ),
  );

  it.effect("writes zero usage for proven rejection", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.promise(() => seedBoundUser(database, "rejected", "14165550202"));
          const admission = yield* makeRealAdmission(database, () =>
            Effect.succeed({
              _tag: "ManagedConversationDenied" as const,
              reason: "allowanceExhausted",
              resetAt: null,
            }),
          );

          const outcome = yield* admission.admit(
            routeMessage("14165550202", "wamid.native-rejected"),
          );
          const usage = yield* Effect.promise(() => database.select().from(allowanceUsage));

          expect(outcome).toEqual({ _tag: "MessageDenied", reason: "allowanceExhausted" });
          expect(usage).toEqual([]);
        }),
      ),
    ),
  );

  it.effect("conflicts changed provider facts without another usage row", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const seeded = yield* Effect.promise(() =>
            seedBoundUser(database, "conflict", "14165550203"),
          );
          const admission = yield* makeRealAdmission(database, (input) =>
            Effect.succeed(receiptFromAcceptance(input, seeded.allowancePeriodId)),
          );
          const original = routeMessage("14165550203", "wamid.native-conflict");
          yield* admission.admit(original);

          const conflict = yield* Effect.flip(
            admission.admit({ ...original, message: WhatsAppMessageText.make("Changed facts") }),
          );
          const usage = yield* Effect.promise(() => database.select().from(allowanceUsage));

          expect(conflict).toMatchObject({ _tag: "InboundWhatsAppEventConflict" });
          expect(usage).toHaveLength(1);
        }),
      ),
    ),
  );

  it.effect("recovers after period expiry against the original period", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const seeded = yield* Effect.promise(() =>
            seedBoundUser(database, "expired", "14165550204"),
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
            routeMessage("14165550204", "wamid.native-expired"),
          );
          const usage = yield* Effect.promise(() => database.select().from(allowanceUsage));

          expect(outcome).toMatchObject({
            _tag: "MessageAccepted",
            receipt: { allowancePeriodId: seeded.allowancePeriodId },
          });
          expect(freshAcceptances).toBe(0);
          expect(usage).toHaveLength(1);
          expect(usage[0]?.allowancePeriodId).toBe(seeded.allowancePeriodId);
        }),
      ),
    ),
  );

  it.effect("fixes the first binding through revocation and replacement", () =>
    withRealPostgresFixture(({ database }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.promise(() => seedBoundUser(database, "first", "14165550205"));
          const persistence = yield* makePersistence({
            now: Effect.succeed(date("2026-08-16T12:00:00.000Z")),
          }).pipe(Effect.provide(layerFromDatabase(database)));
          const input = {
            ...routeMessage("14165550205", "wamid.native-fixed"),
            contentDigest: providerContentDigest,
          };
          const first = yield* persistence.route(input);
          yield* Effect.promise(async () => {
            await database
              .update(channelBindings)
              .set({ revokedAt: date("2026-08-16T12:01:00.000Z") })
              .where(eq(channelBindings.channelBindingId, "binding-first"));
            await seedBoundUser(database, "replacement", "14165550205");
          });

          const replay = yield* persistence.route(input);
          const [stored] = yield* Effect.promise(() =>
            database
              .select()
              .from(inboundWhatsAppEvents)
              .where(eq(inboundWhatsAppEvents.providerMessageId, input.providerMessageId)),
          );

          expect(first).toMatchObject({ _tag: "Bound", channelBindingId: "binding-first" });
          expect(replay).toMatchObject({ _tag: "Bound", channelBindingId: "binding-first" });
          expect(stored?.resolvedChannelBindingId).toBe("binding-first");
        }),
      ),
    ),
  );
});

const makeRealAdmission = (
  database: Database,
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
    const persistence = yield* makePersistence({ now: Effect.succeed(now) }).pipe(
      Effect.provide(layerFromDatabase(database)),
    );
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

const seedBoundUser = async (database: Database, suffix: string, channelIdentity: string) => {
  const userId = UserId.make(`user-${suffix}`);
  const allowancePeriodId = AllowancePeriodId.make(`period-${suffix}`);
  await database.insert(users).values({
    email: `${userId}@example.test`,
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
    allowancePeriodId,
    billingSubscriptionId: `subscription-${suffix}`,
    endsAt: date("2026-09-01T00:00:00.000Z"),
    plan: "free",
    planPolicyVersion: "launch-v1",
    startsAt: date("2026-08-01T00:00:00.000Z"),
    userId,
  });
  await database.insert(channelBindings).values({
    channelBindingId: ChannelBindingId.make(`binding-${suffix}`),
    channelIdentity,
    provider: "whatsapp",
    userId,
  });
  return { allowancePeriodId };
};

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
