import type { Database } from "@osfo/db";
import { sessions } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Effect, Predicate, Schema } from "effect";

import { ChannelBindingId, Plan, PlanPolicyVersion, type UserId } from "../../domain";
import { AuthSessionId } from "../../domain/auth-session";
import type { OriginatingAuthority as InputOriginatingAuthority } from "../../domain/authority";
import { GmailPersistenceUnavailable } from "../../domain/gmail";
import { OriginatingAuthority, type AuthorizationContext } from "../../services/authorization";
import * as Billing from "../billing";

const CurrentSubscription = Schema.Struct({ plan: Plan, planPolicyVersion: PlanPolicyVersion });

/** Load initial current authority and allowance facts for one Gmail operation. */
export const loadInitial = (
  database: Database,
  userId: UserId,
  origin: InputOriginatingAuthority,
  now: Date,
) =>
  Effect.gen(function* () {
    const admission = yield* Billing.make(database).admit(userId, now);
    const authority = yield* loadAuthority(database, userId, origin, now);
    return {
      allowance: {
        _tag: "Metered" as const,
        allowancePeriodId: admission.allowancePeriodId,
        endsAt: admission.endsAt,
        plan: admission.plan,
        planPolicyVersion: admission.planPolicyVersion,
        startsAt: admission.startsAt,
        usage: admission.usage,
      },
      authority,
      now,
      originatingAuthority: authorizationOrigin(origin),
      plan: admission.plan,
      planPolicyVersion: admission.planPolicyVersion,
      userId,
    };
  });

/** Load current authority for approved work without admitting a new allowance period. */
export const loadResumed = (
  database: Database,
  userId: UserId,
  origin: InputOriginatingAuthority,
  now: Date,
) =>
  Effect.gen(function* () {
    const authority = yield* loadAuthority(database, userId, origin, now);
    const subscription = yield* loadSubscription(database, userId);
    return {
      allowance: { _tag: "Unavailable" as const },
      authority,
      now,
      originatingAuthority: authorizationOrigin(origin),
      plan: subscription.plan,
      planPolicyVersion: subscription.planPolicyVersion,
      userId,
    };
  });

/** Reload protected-effect facts without requiring a new active allowance period. */
export const reload = (
  database: Database,
  previous: {
    readonly allowance: AuthorizationContext["allowance"];
    readonly originatingAuthority: AuthorizationContext["originatingAuthority"];
    readonly userId: UserId;
  },
  now: Date,
) =>
  Effect.gen(function* () {
    const authority = yield* loadAuthority(
      database,
      previous.userId,
      inputOrigin(previous.originatingAuthority),
      now,
    );
    const subscription = yield* loadSubscription(database, previous.userId);
    return {
      allowance: previous.allowance,
      authority,
      now,
      originatingAuthority: previous.originatingAuthority,
      plan: subscription.plan,
      planPolicyVersion: subscription.planPolicyVersion,
      userId: previous.userId,
    };
  });

const loadSubscription = (database: Database, userId: UserId) =>
  query(() =>
    database
      .select({
        plan: billingSubscriptions.plan,
        planPolicyVersion: billingSubscriptions.planPolicyVersion,
      })
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.userId, userId))
      .limit(1)
      .execute(),
  ).pipe(
    Effect.flatMap(([row]) =>
      row === undefined
        ? Effect.fail(
            new GmailPersistenceUnavailable({
              cause: userId,
              message: "The current Gmail subscription authority is unavailable",
              operation: "recheck",
            }),
          )
        : Schema.decodeEffect(CurrentSubscription)(row).pipe(
            Effect.mapError(
              (cause) =>
                new GmailPersistenceUnavailable({
                  cause,
                  message: "PostgreSQL returned invalid Gmail subscription authority",
                  operation: "recheck",
                }),
            ),
          ),
    ),
  );

const loadAuthority = (
  database: Database,
  userId: UserId,
  origin: InputOriginatingAuthority,
  now: Date,
) => {
  if (Predicate.isTagged(origin, "DurableTrigger")) return Effect.succeed(null);
  if (Predicate.isTagged(origin, "ChannelBinding")) {
    return query(() =>
      database
        .select({ channelBindingId: channelBindings.channelBindingId })
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.channelBindingId, origin.channelBindingId),
            eq(channelBindings.userId, userId),
            isNull(channelBindings.revokedAt),
          ),
        )
        .limit(1)
        .execute(),
    ).pipe(
      Effect.map(([current]) =>
        current === undefined
          ? null
          : ({
              _tag: "ChannelBinding",
              channelBindingId: ChannelBindingId.make(origin.channelBindingId),
              userId,
            } as const),
      ),
    );
  }
  return query(() =>
    database
      .select({ authSessionId: sessions.id, expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, origin.authSessionId),
          eq(sessions.userId, userId),
          gt(sessions.expiresAt, now),
        ),
      )
      .limit(1)
      .execute(),
  ).pipe(
    Effect.map(([current]) =>
      current === undefined
        ? null
        : ({
            _tag: "AuthSession",
            authSessionId: AuthSessionId.make(origin.authSessionId),
            expiresAt: current.expiresAt,
            userId,
          } as const),
    ),
  );
};

const query = <A>(execute: () => Promise<ReadonlyArray<A>>) =>
  Effect.tryPromise({
    try: execute,
    catch: (cause) =>
      new GmailPersistenceUnavailable({
        cause,
        message: "The current Gmail authority could not be loaded",
        operation: "recheck",
      }),
  });

const authorizationOrigin = (origin: InputOriginatingAuthority) =>
  origin._tag === "AuthSession"
    ? OriginatingAuthority.make({
        _tag: "AuthSession",
        authSessionId: AuthSessionId.make(origin.authSessionId),
      })
    : origin._tag === "ChannelBinding"
      ? OriginatingAuthority.make({
          _tag: "ChannelBinding",
          channelBindingId: ChannelBindingId.make(origin.channelBindingId),
        })
      : OriginatingAuthority.make(origin);

const inputOrigin = (
  origin: AuthorizationContext["originatingAuthority"],
): InputOriginatingAuthority =>
  origin._tag === "AuthSession"
    ? { _tag: "AuthSession", authSessionId: origin.authSessionId }
    : origin._tag === "ChannelBinding"
      ? { _tag: "ChannelBinding", channelBindingId: origin.channelBindingId }
      : origin;
