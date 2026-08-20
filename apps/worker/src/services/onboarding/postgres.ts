import { agents } from "@osfo/db/schema/agents";
import { users } from "@osfo/db/schema/auth";
import { channelBindings, registrationInvitations } from "@osfo/db/schema/onboarding";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import { database, decodeOptionalRow, type Database } from "../../db";
import { AgentId } from "../../domain";
import { ChannelBindingPostgres } from "../../integrations/postgres/channel-binding";
import { Onboarding } from "../onboarding";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Drizzle transactions and domain tags require these forms. */

const InvitationRecord = Onboarding.StoredInvitation;

const OnboardingUserRecord = Schema.Struct({
  helpAreas: Schema.Array(Onboarding.HelpArea),
  locale: Onboarding.OnboardingLocale,
  phoneNumber: Schema.NullOr(Schema.String),
  phoneNumberVerified: Schema.NullOr(Schema.Boolean),
  preferredName: Schema.NullOr(Schema.String),
  registrationCompletedAt: Schema.NullOr(Schema.Date),
});

const WelcomeRouteRecord = Schema.Struct({
  agentId: AgentId,
  helpAreas: Schema.Array(Onboarding.HelpArea),
  locale: Onboarding.OnboardingLocale,
  preferredName: Schema.NullOr(Schema.String),
});

const UserPhoneRecord = Schema.Struct({ phoneNumber: Schema.NullOr(Schema.String) });

/** Construct the private PostgreSQL implementation of Onboarding. */
export const make = Effect.gen(function* () {
  const db = yield* database;

  const findByDigest: Onboarding.Persistence["findByDigest"] = (digest) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({
            bindingOutcome: registrationInvitations.binding_outcome,
            channelBindingId: registrationInvitations.channel_binding_id,
            channelIdentity: registrationInvitations.channel_identity,
            consumptionDigest: registrationInvitations.consumption_digest,
            expiresAt: registrationInvitations.expires_at,
            expiryReason: registrationInvitations.expiry_reason,
            invitationId: registrationInvitations.invitation_id,
            invitedPhoneNumber: registrationInvitations.invited_phone_number,
            kind: registrationInvitations.kind,
            locale: registrationInvitations.locale,
            provider: registrationInvitations.provider,
            state: registrationInvitations.state,
            userId: registrationInvitations.user_id,
          })
          .from(registrationInvitations)
          .where(eq(registrationInvitations.token_digest, digest))
          .limit(1),
      catch: (cause) => unavailable("findByDigest", cause),
    }).pipe(
      Effect.flatMap((rows) =>
        decodeOptionalRow(InvitationRecord, rows[0], "inspectRegistrationInvitation"),
      ),
      Effect.mapError((cause) => unavailable("findByDigest", cause)),
      Effect.map((record) => record ?? null),
    );

  const findLiveChannel: Onboarding.Persistence["findLiveChannel"] = (provider, channelIdentity) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({ invitationId: registrationInvitations.invitation_id })
          .from(registrationInvitations)
          .where(
            and(
              eq(registrationInvitations.provider, provider),
              eq(registrationInvitations.channel_identity, channelIdentity),
              eq(registrationInvitations.state, "live"),
            ),
          )
          .limit(1),
      catch: (cause) => unavailable("findLiveChannel", cause),
    }).pipe(
      Effect.flatMap((rows) =>
        decodeOptionalRow(
          Schema.Struct({ invitationId: Onboarding.StoredInvitation.fields.invitationId }),
          rows[0],
          "issueRegistrationInvitation",
        ),
      ),
      Effect.mapError((cause) => unavailable("findLiveChannel", cause)),
      Effect.map((record) => record?.invitationId ?? null),
    );

  const readUser: Onboarding.Persistence["readUser"] = (userId) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({
            helpAreas: users.helpAreas,
            locale: users.locale,
            phoneNumber: users.phoneNumber,
            phoneNumberVerified: users.phoneNumberVerified,
            preferredName: users.preferredName,
            registrationCompletedAt: users.registrationCompletedAt,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1),
      catch: (cause) => unavailable("readUser", cause),
    }).pipe(
      Effect.flatMap((rows) =>
        decodeOptionalRow(OnboardingUserRecord, rows[0], "completeOnboarding"),
      ),
      Effect.mapError((cause) => unavailable("readUser", cause)),
      Effect.map((record) =>
        record === undefined
          ? null
          : {
              phoneNumber: record.phoneNumber,
              phoneNumberVerified: record.phoneNumberVerified === true,
              profile: {
                helpAreas: record.helpAreas,
                locale: record.locale,
                preferredName: record.preferredName,
              },
              registrationCompletedAt: record.registrationCompletedAt,
            },
      ),
    );

  const readWelcomeRoute: Onboarding.Persistence["readWelcomeRoute"] = (userId) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({
            agentId: agents.agent_id,
            helpAreas: users.helpAreas,
            locale: users.locale,
            preferredName: users.preferredName,
          })
          .from(agents)
          .innerJoin(users, eq(users.id, agents.user_id))
          .where(eq(agents.user_id, userId))
          .limit(1),
      catch: (cause) => unavailable("readWelcomeRoute", cause),
    }).pipe(
      Effect.flatMap((rows) => decodeOptionalRow(WelcomeRouteRecord, rows[0], "enrollWhatsApp")),
      Effect.mapError((cause) => unavailable("readWelcomeRoute", cause)),
      Effect.map((record) =>
        record === undefined
          ? null
          : {
              agentId: record.agentId,
              profile: {
                helpAreas: record.helpAreas,
                locale: record.locale,
                preferredName: record.preferredName,
              },
            },
      ),
    );

  return {
    complete: (input, decide) =>
      Effect.tryPromise({
        try: () => completeTransaction(db, input, decide),
        catch: (cause) => rejected("complete", input.userId, cause),
      }),
    createWebEnrollment: (input) =>
      Effect.tryPromise({
        try: () => createWebEnrollmentTransaction(db, input),
        catch: (cause) => rejected("createWebEnrollment", input.invitationId, cause),
      }),
    enroll: (input, decide) =>
      Effect.tryPromise({
        try: () => enrollTransaction(db, input, decide),
        catch: (cause) => rejected("enroll", input.invitationId, cause),
      }),
    expireByDigest: (digest, now) =>
      Effect.tryPromise({
        try: () => expireByDigest(db, digest, now),
        catch: (cause) => unavailable("expireByDigest", cause),
      }).pipe(Effect.asVoid),
    expireLive: (now) =>
      Effect.tryPromise({
        try: () => expireLive(db, now),
        catch: (cause) => unavailable("expireLive", cause),
      }),
    findByDigest,
    findLiveChannel,
    insertChannelInvitation: (input) =>
      Effect.tryPromise({
        try: () => insertChannelInvitationTransaction(db, input),
        catch: (cause) => rejected("insertChannelInvitation", input.invitationId, cause),
      }),
    readCurrentBinding: (query) =>
      Effect.tryPromise({
        try: () =>
          ChannelBindingPostgres.readCurrentBinding(
            db,
            query.provider,
            query.userId,
            query.channelBindingId,
          ),
        catch: (cause) => unavailable("readCurrentBinding", cause),
      }).pipe(
        Effect.map((binding) =>
          binding === null
            ? null
            : Onboarding.StoredChannelBinding.make({
                channelBindingId: binding.channelBindingId,
                channelIdentity: binding.channelIdentity,
                provider: binding.provider,
                userId: binding.userId,
              }),
        ),
      ),
    readUser,
    readWelcomeRoute,
  } satisfies Onboarding.Persistence;
});

/** Onboarding service Layer backed by PostgreSQL and explicit graph dependencies. */
export const layer = Layer.effect(Onboarding.Service, Effect.flatMap(make, Onboarding.make));

const unavailable = (operation: string, cause: unknown) =>
  new Onboarding.OnboardingPersistenceUnavailable({ cause, operation });

const rejected = (operation: string, operationId: string, cause: unknown) =>
  new Onboarding.OnboardingPersistenceRejected({ cause, operation, operationId });

const insertChannelInvitationTransaction = async (
  db: Database,
  input: Onboarding.ChannelInvitationPersistenceInput,
) =>
  db.transaction(async (transaction) => {
    const channel =
      input.channel._tag === "TelegramFirst"
        ? {
            channelIdentity: input.channel.channelIdentity,
            invitedPhoneNumber: null,
            kind: "telegram_first" as const,
            provider: "telegram" as const,
          }
        : {
            channelIdentity: input.channel.channelIdentity,
            invitedPhoneNumber: input.channel.invitedPhoneNumber,
            kind: "whatsapp_first" as const,
            provider: "whatsapp" as const,
          };
    const invitation = await transaction
      .insert(registrationInvitations)
      .values({
        channel_identity: channel.channelIdentity,
        created_at: input.createdAt,
        expires_at: input.expiresAt,
        invitation_id: input.invitationId,
        invited_phone_number: channel.invitedPhoneNumber,
        kind: channel.kind,
        locale: input.locale,
        provider: channel.provider,
        provider_event_id: input.providerEventId,
        token_digest: input.tokenDigest,
      })
      .onConflictDoNothing()
      .returning({ invitationId: registrationInvitations.invitation_id });
    if (invitation.length > 0) return true;
    return false;
  });

const completeTransaction = async (
  db: Database,
  input: Onboarding.CompletePersistenceInput,
  decide: (
    context: Onboarding.CompletePersistenceContext,
  ) => Onboarding.CompletePersistenceDecision,
): Promise<Onboarding.CompletePersistenceResult> =>
  db.transaction(async (transaction) => {
    const applyProfile = async () => {
      if (!input.applyProfile) return;
      const update =
        input.acceptedProfile.preferredName === null
          ? {
              helpAreas: input.acceptedProfile.helpAreas,
              locale: input.acceptedProfile.locale,
              preferredName: null,
            }
          : {
              helpAreas: input.acceptedProfile.helpAreas,
              locale: input.acceptedProfile.locale,
              name: input.acceptedProfile.preferredName,
              preferredName: input.acceptedProfile.preferredName,
            };
      await transaction.update(users).set(update).where(eq(users.id, input.userId));
    };

    const invitation =
      input.invitationId === null
        ? null
        : await readLockedInvitation(transaction, input.invitationId);
    const [user] = await transaction
      .select({ phoneNumber: users.phoneNumber })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    const userPhone =
      user === undefined ? null : Schema.decodeSync(UserPhoneRecord)(user).phoneNumber;
    const activeBindings =
      invitation?.channelIdentity === null || invitation?.channelIdentity === undefined
        ? []
        : await readActiveBindings(
            transaction,
            invitation.channelIdentity,
            invitation.provider,
            input.userId,
          );
    const decision = decide({
      activeBindings,
      invitation,
      userPhoneNumber: userPhone,
    });
    if (decision._tag === "Reject") return decision.reason;
    const channel = decision.channel;
    if (channel._tag === "BindingCreated") {
      if (invitation?.channelIdentity === null || invitation?.channelIdentity === undefined) {
        return "invitation-invalid";
      }
      await transaction.insert(channelBindings).values({
        channel_binding_id: channel.channelBindingId,
        channel_identity: invitation.channelIdentity,
        created_at: input.now,
        provider: invitation.provider,
        user_id: input.userId,
      });
    }
    await applyProfile();
    if (input.invitationId === null) return channel;
    await transaction
      .update(registrationInvitations)
      .set({
        binding_outcome:
          channel._tag === "BindingCreated"
            ? "created"
            : channel._tag === "BindingExisting"
              ? "existing"
              : "refused",
        channel_binding_id:
          channel._tag === "BindingCreated" || channel._tag === "BindingExisting"
            ? channel.channelBindingId
            : null,
        channel_identity: null,
        consumed_at: input.now,
        consumption_digest: input.requestDigest,
        invited_phone_number: null,
        state: "consumed",
        user_id: input.userId,
      })
      .where(eq(registrationInvitations.invitation_id, input.invitationId));
    return channel;
  });

const enrollTransaction = async (
  db: Database,
  input: Onboarding.EnrollPersistenceInput,
  decide: (
    context: Onboarding.EnrollmentPersistenceContext,
  ) => Onboarding.EnrollmentPersistenceDecision,
): Promise<Onboarding.EnrollmentPersistenceResult> =>
  db.transaction(async (transaction) => {
    const invitation = await readLockedInvitation(transaction, input.invitationId);
    const activeBindings = await readActiveBindings(
      transaction,
      input.channelIdentity,
      input.provider,
      input.userId,
    );
    const decision = decide({ activeBindings, invitation });
    if (decision._tag === "Reject") return decision.reason;
    const channel = decision.channel;
    if (channel._tag === "BindingCreated") {
      await transaction.insert(channelBindings).values({
        channel_binding_id: channel.channelBindingId,
        channel_identity: input.channelIdentity,
        created_at: input.now,
        provider: input.provider,
        user_id: input.userId,
      });
    }
    await transaction
      .update(registrationInvitations)
      .set({
        binding_outcome: channel._tag === "BindingExisting" ? "existing" : "created",
        channel_binding_id: channel.channelBindingId,
        consumed_at: input.now,
        consumption_digest: input.enrollmentDigest,
        state: "consumed",
      })
      .where(eq(registrationInvitations.invitation_id, input.invitationId));
    return channel;
  });

const createWebEnrollmentTransaction = async (
  db: Database,
  input: Onboarding.WebEnrollmentPersistenceInput,
) =>
  db.transaction(async (transaction) => {
    await transaction
      .select({ userId: users.id })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update")
      .limit(1);
    const [existing] = await transaction
      .select({
        invitationId: registrationInvitations.invitation_id,
        tokenDigest: registrationInvitations.token_digest,
      })
      .from(registrationInvitations)
      .where(
        and(
          eq(registrationInvitations.kind, "web_enrollment"),
          eq(registrationInvitations.state, "live"),
          eq(registrationInvitations.user_id, input.userId),
        ),
      )
      .limit(1);
    if (existing?.tokenDigest === input.digest) return;
    if (existing !== undefined) {
      await transaction
        .update(registrationInvitations)
        .set({ expiry_reason: "replaced", state: "expired", user_id: null })
        .where(eq(registrationInvitations.invitation_id, existing.invitationId));
    }
    await transaction.insert(registrationInvitations).values({
      created_at: input.now,
      expires_at: input.expiresAt,
      invitation_id: input.invitationId,
      kind: "web_enrollment",
      locale: input.locale,
      provider: input.provider,
      token_digest: input.digest,
      user_id: input.userId,
    });
  });

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const readLockedInvitation = async (
  transaction: Transaction,
  invitationId: Onboarding.StoredInvitation["invitationId"],
): Promise<Onboarding.StoredInvitation | null> => {
  const [row] = await transaction
    .select({
      bindingOutcome: registrationInvitations.binding_outcome,
      channelBindingId: registrationInvitations.channel_binding_id,
      channelIdentity: registrationInvitations.channel_identity,
      consumptionDigest: registrationInvitations.consumption_digest,
      expiresAt: registrationInvitations.expires_at,
      expiryReason: registrationInvitations.expiry_reason,
      invitationId: registrationInvitations.invitation_id,
      invitedPhoneNumber: registrationInvitations.invited_phone_number,
      kind: registrationInvitations.kind,
      locale: registrationInvitations.locale,
      provider: registrationInvitations.provider,
      state: registrationInvitations.state,
      userId: registrationInvitations.user_id,
    })
    .from(registrationInvitations)
    .where(eq(registrationInvitations.invitation_id, invitationId))
    .for("update")
    .limit(1);
  return row === undefined ? null : Schema.decodeUnknownSync(Onboarding.StoredInvitation)(row);
};

const readActiveBindings = async (
  transaction: Transaction,
  channelIdentity: Onboarding.StoredChannelBinding["channelIdentity"],
  provider: Onboarding.ChannelProvider,
  userId: Onboarding.StoredChannelBinding["userId"],
): Promise<ReadonlyArray<Onboarding.StoredChannelBinding>> => {
  const rows = await transaction
    .select({
      channelBindingId: channelBindings.channel_binding_id,
      channelIdentity: channelBindings.channel_identity,
      provider: channelBindings.provider,
      userId: channelBindings.user_id,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.provider, provider),
        isNull(channelBindings.revoked_at),
        or(
          eq(channelBindings.channel_identity, channelIdentity),
          eq(channelBindings.user_id, userId),
        ),
      ),
    )
    .for("update");
  return rows.map((row) => Schema.decodeUnknownSync(Onboarding.StoredChannelBinding)(row));
};

const expireByDigest = (db: Database, digest: string, now: Date) =>
  db
    .update(registrationInvitations)
    .set(expiredInvitation)
    .where(
      and(
        eq(registrationInvitations.token_digest, digest),
        eq(registrationInvitations.state, "live"),
        lt(registrationInvitations.expires_at, now),
      ),
    );

const expireLive = async (db: Database, now: Date) => {
  const expired = await db
    .update(registrationInvitations)
    .set(expiredInvitation)
    .where(
      and(eq(registrationInvitations.state, "live"), lt(registrationInvitations.expires_at, now)),
    )
    .returning({ invitationId: registrationInvitations.invitation_id });
  return expired.length;
};

const expiredInvitation = {
  channelIdentity: null,
  expiryReason: "elapsed" as const,
  invitedPhoneNumber: null,
  state: "expired" as const,
  userId: null,
};

export * as OnboardingPostgres from "./postgres";
