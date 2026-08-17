import { agents } from "@osfo/db/schema/agents";
import { users } from "@osfo/db/schema/auth";
import { channelBindings, registrationInvitations } from "@osfo/db/schema/onboarding";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import { database, decodeOptionalRow, type Database } from "../../db";
import { AgentId } from "../../domain";
import * as ChannelBindingAuthority from "../../services/channel-binding-authority";
import * as Onboarding from "../../services/onboarding";

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

const StoredWhatsAppBinding = Schema.Struct({
  ...Onboarding.StoredChannelBinding.fields,
  revokedAt: Schema.NullOr(Schema.Date),
});

/** Storage-local Channel Binding facts needed by inbound receipt fixation. */
export type StoredWhatsAppBinding = typeof StoredWhatsAppBinding.Type;

/** Postgres implementation of the onboarding control-plane persistence port. */
export const make = Effect.gen(function* () {
  const db = yield* database;
  const channelBindingAuthority = makeChannelBindingAuthority(db);

  const findByDigest: Onboarding.PersistencePort["findByDigest"] = (digest) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({
            bindingOutcome: registrationInvitations.bindingOutcome,
            channelBindingId: registrationInvitations.channelBindingId,
            channelIdentity: registrationInvitations.channelIdentity,
            consumptionDigest: registrationInvitations.consumptionDigest,
            expiresAt: registrationInvitations.expiresAt,
            expiryReason: registrationInvitations.expiryReason,
            invitationId: registrationInvitations.invitationId,
            invitedPhoneNumber: registrationInvitations.invitedPhoneNumber,
            kind: registrationInvitations.kind,
            locale: registrationInvitations.locale,
            state: registrationInvitations.state,
            userId: registrationInvitations.userId,
          })
          .from(registrationInvitations)
          .where(eq(registrationInvitations.tokenDigest, digest))
          .limit(1),
      catch: (cause) => unavailable("findByDigest", cause),
    }).pipe(
      Effect.flatMap((rows) =>
        decodeOptionalRow(InvitationRecord, rows[0], "inspectRegistrationInvitation"),
      ),
      Effect.mapError((cause) => unavailable("findByDigest", cause)),
      Effect.map((record) => record ?? null),
    );

  const findLiveWhatsApp: Onboarding.PersistencePort["findLiveWhatsApp"] = (channelIdentity) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({ invitationId: registrationInvitations.invitationId })
          .from(registrationInvitations)
          .where(
            and(
              eq(registrationInvitations.provider, "whatsapp"),
              eq(registrationInvitations.channelIdentity, channelIdentity),
              eq(registrationInvitations.state, "live"),
            ),
          )
          .limit(1),
      catch: (cause) => unavailable("findLiveWhatsApp", cause),
    }).pipe(
      Effect.flatMap((rows) =>
        decodeOptionalRow(
          Schema.Struct({ invitationId: Onboarding.StoredInvitation.fields.invitationId }),
          rows[0],
          "issueRegistrationInvitation",
        ),
      ),
      Effect.mapError((cause) => unavailable("findLiveWhatsApp", cause)),
      Effect.map((record) => record?.invitationId ?? null),
    );

  const readUser: Onboarding.PersistencePort["readUser"] = (userId) =>
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

  const readWelcomeRoute: Onboarding.PersistencePort["readWelcomeRoute"] = (userId) =>
    Effect.tryPromise({
      try: () =>
        db
          .select({
            agentId: agents.agentId,
            helpAreas: users.helpAreas,
            locale: users.locale,
            preferredName: users.preferredName,
          })
          .from(agents)
          .innerJoin(users, eq(users.id, agents.userId))
          .where(eq(agents.userId, userId))
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

  return Onboarding.Persistence.of({
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
    findLiveWhatsApp,
    insertWhatsApp: (input) =>
      Effect.tryPromise({
        try: async () => {
          const inserted = await db
            .insert(registrationInvitations)
            .values({
              ...input,
              kind: "whatsapp_first",
              provider: "whatsapp",
            })
            .onConflictDoNothing()
            .returning({ invitationId: registrationInvitations.invitationId });
          return inserted.length > 0;
        },
        catch: (cause) => rejected("insertWhatsApp", input.invitationId, cause),
      }),
    readCurrentBinding: channelBindingAuthority.readCurrentBinding,
    readUser,
    readWelcomeRoute,
  });
});

/** Postgres onboarding adapter Layer that preserves its request-scoped database requirement. */
export const layerWithoutDependencies = Layer.effect(Onboarding.Persistence, make);

/** Construct the single PostgreSQL reader for current Channel Binding authority. */
export const makeChannelBindingAuthority = (
  db: Database,
): ChannelBindingAuthority.Port<Onboarding.OnboardingPersistenceUnavailable> => ({
  readCurrentBinding: (query) =>
    Effect.tryPromise({
      try: () => readCurrentBindingRow(db, query),
      catch: (cause) => unavailable("readCurrentBinding", cause),
    }).pipe(Effect.flatMap(decodeCurrentBinding)),
});

/** Read current Channel Binding authority through its single PostgreSQL owner. */
export const readCurrentBinding = (query: ChannelBindingAuthority.CurrentChannelBindingQuery) =>
  Effect.gen(function* () {
    const db = yield* database;
    return yield* makeChannelBindingAuthority(db).readCurrentBinding(query);
  });

const unavailable = (operation: string, cause: unknown) =>
  new Onboarding.OnboardingPersistenceUnavailable({ cause, operation });

const rejected = (operation: string, operationId: string, cause: unknown) =>
  new Onboarding.OnboardingPersistenceRejected({ cause, operation, operationId });

const readCurrentBindingRow = (
  db: Database,
  query: ChannelBindingAuthority.CurrentChannelBindingQuery,
) =>
  db
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.channelBindingId, query.channelBindingId),
        eq(channelBindings.userId, query.userId),
        eq(channelBindings.provider, "whatsapp"),
        isNull(channelBindings.revokedAt),
      ),
    )
    .limit(1);

const decodeCurrentBinding = (
  rows: Awaited<ReturnType<typeof readCurrentBindingRow>>,
): Effect.Effect<
  ChannelBindingAuthority.CurrentChannelBinding | null,
  Onboarding.OnboardingPersistenceUnavailable
> =>
  rows[0] === undefined
    ? Effect.succeed(null)
    : Schema.decodeEffect(ChannelBindingAuthority.CurrentChannelBinding)(rows[0]).pipe(
        Effect.mapError((cause) => unavailable("readCurrentBinding", cause)),
      );

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
        : await readActiveBindings(transaction, invitation.channelIdentity, input.userId);
    const decision = decide({
      activeBindings,
      invitation,
      userPhoneNumber: userPhone,
    });
    if (decision._tag === "Reject") return decision.reason;
    const channel = decision.channel;
    if (channel !== "web-enrollment" && channel._tag === "BindingCreated") {
      if (invitation?.channelIdentity === null || invitation?.channelIdentity === undefined) {
        return "invitation-invalid";
      }
      await transaction.insert(channelBindings).values({
        channelBindingId: channel.channelBindingId,
        channelIdentity: invitation.channelIdentity,
        createdAt: input.now,
        provider: "whatsapp",
        userId: input.userId,
      });
    }
    await applyProfile();
    if (input.invitationId === null || channel === "web-enrollment") return channel;
    await transaction
      .update(registrationInvitations)
      .set({
        bindingOutcome:
          channel._tag === "BindingCreated"
            ? "created"
            : channel._tag === "BindingExisting"
              ? "existing"
              : "refused",
        channelBindingId:
          channel._tag === "BindingCreated" || channel._tag === "BindingExisting"
            ? channel.channelBindingId
            : null,
        channelIdentity: null,
        consumedAt: input.now,
        consumptionDigest: input.requestDigest,
        invitedPhoneNumber: null,
        state: "consumed",
        userId: input.userId,
      })
      .where(eq(registrationInvitations.invitationId, input.invitationId));
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
      input.userId,
    );
    const decision = decide({ activeBindings, invitation });
    if (decision._tag === "Reject") return decision.reason;
    const channel = decision.channel;
    if (channel._tag === "BindingCreated") {
      await transaction.insert(channelBindings).values({
        channelBindingId: channel.channelBindingId,
        channelIdentity: input.channelIdentity,
        createdAt: input.now,
        provider: "whatsapp",
        userId: input.userId,
      });
    }
    await transaction
      .update(registrationInvitations)
      .set({
        bindingOutcome: channel._tag === "BindingExisting" ? "existing" : "created",
        channelBindingId: channel.channelBindingId,
        consumedAt: input.now,
        consumptionDigest: input.enrollmentDigest,
        state: "consumed",
      })
      .where(eq(registrationInvitations.invitationId, input.invitationId));
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
        invitationId: registrationInvitations.invitationId,
        tokenDigest: registrationInvitations.tokenDigest,
      })
      .from(registrationInvitations)
      .where(
        and(
          eq(registrationInvitations.kind, "web_enrollment"),
          eq(registrationInvitations.state, "live"),
          eq(registrationInvitations.userId, input.userId),
        ),
      )
      .limit(1);
    if (existing?.tokenDigest === input.digest) return;
    if (existing !== undefined) {
      await transaction
        .update(registrationInvitations)
        .set({ expiryReason: "replaced", state: "expired", userId: null })
        .where(eq(registrationInvitations.invitationId, existing.invitationId));
    }
    await transaction.insert(registrationInvitations).values({
      createdAt: input.now,
      expiresAt: input.expiresAt,
      invitationId: input.invitationId,
      kind: "web_enrollment",
      locale: input.locale,
      provider: "whatsapp",
      tokenDigest: input.digest,
      userId: input.userId,
    });
  });

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Resolve one active WhatsApp binding inside the caller-owned PostgreSQL transaction. */
export const readActiveWhatsAppBinding = async (
  transaction: Transaction,
  channelIdentity: Onboarding.StoredChannelBinding["channelIdentity"],
): Promise<StoredWhatsAppBinding | null> => {
  const [row] = await transaction
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      revokedAt: channelBindings.revokedAt,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.provider, "whatsapp"),
        eq(channelBindings.channelIdentity, channelIdentity),
        isNull(channelBindings.revokedAt),
      ),
    )
    .limit(1);
  return row === undefined ? null : Schema.decodeSync(StoredWhatsAppBinding)(row);
};

/** Read one fixed WhatsApp binding through the storage module that owns its predicate. */
export const readWhatsAppBinding = async (
  db: Pick<Transaction, "select">,
  channelBindingId: Onboarding.StoredChannelBinding["channelBindingId"],
): Promise<StoredWhatsAppBinding | null> => {
  const [row] = await db
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      revokedAt: channelBindings.revokedAt,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.channelBindingId, channelBindingId),
        eq(channelBindings.provider, "whatsapp"),
      ),
    )
    .limit(1);
  return row === undefined ? null : Schema.decodeSync(StoredWhatsAppBinding)(row);
};

const readLockedInvitation = async (
  transaction: Transaction,
  invitationId: Onboarding.StoredInvitation["invitationId"],
): Promise<Onboarding.StoredInvitation | null> => {
  const [row] = await transaction
    .select({
      bindingOutcome: registrationInvitations.bindingOutcome,
      channelBindingId: registrationInvitations.channelBindingId,
      channelIdentity: registrationInvitations.channelIdentity,
      consumptionDigest: registrationInvitations.consumptionDigest,
      expiresAt: registrationInvitations.expiresAt,
      expiryReason: registrationInvitations.expiryReason,
      invitationId: registrationInvitations.invitationId,
      invitedPhoneNumber: registrationInvitations.invitedPhoneNumber,
      kind: registrationInvitations.kind,
      locale: registrationInvitations.locale,
      state: registrationInvitations.state,
      userId: registrationInvitations.userId,
    })
    .from(registrationInvitations)
    .where(eq(registrationInvitations.invitationId, invitationId))
    .for("update")
    .limit(1);
  return row === undefined ? null : Schema.decodeUnknownSync(Onboarding.StoredInvitation)(row);
};

const readActiveBindings = async (
  transaction: Transaction,
  channelIdentity: Onboarding.StoredChannelBinding["channelIdentity"],
  userId: Onboarding.StoredChannelBinding["userId"],
): Promise<ReadonlyArray<Onboarding.StoredChannelBinding>> => {
  const rows = await transaction
    .select({
      channelBindingId: channelBindings.channelBindingId,
      channelIdentity: channelBindings.channelIdentity,
      userId: channelBindings.userId,
    })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.provider, "whatsapp"),
        isNull(channelBindings.revokedAt),
        or(
          eq(channelBindings.channelIdentity, channelIdentity),
          eq(channelBindings.userId, userId),
        ),
      ),
    )
    .for("update");
  return rows.map((row) => Schema.decodeSync(Onboarding.StoredChannelBinding)(row));
};

const expireByDigest = (db: Database, digest: string, now: Date) =>
  db
    .update(registrationInvitations)
    .set(expiredInvitation)
    .where(
      and(
        eq(registrationInvitations.tokenDigest, digest),
        eq(registrationInvitations.state, "live"),
        lt(registrationInvitations.expiresAt, now),
      ),
    );

const expireLive = async (db: Database, now: Date) => {
  const expired = await db
    .update(registrationInvitations)
    .set(expiredInvitation)
    .where(
      and(eq(registrationInvitations.state, "live"), lt(registrationInvitations.expiresAt, now)),
    )
    .returning({ invitationId: registrationInvitations.invitationId });
  return expired.length;
};

const expiredInvitation = {
  channelIdentity: null,
  expiryReason: "elapsed" as const,
  invitedPhoneNumber: null,
  state: "expired" as const,
  userId: null,
};
