import { Context, Crypto, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { HelpArea, OnboardingLocale, RegistrationToken } from "@osfo/api";

import {
  AgentId,
  ChannelBindingId,
  ChannelIdentity,
  RegistrationInvitationId,
  UserId,
} from "../domain";
import * as Registration from "./registration";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Effect tags and Drizzle transaction callbacks use these required forms. */

export { HelpArea, OnboardingLocale, RegistrationToken } from "@osfo/api";

/** Messaging providers proven by the onboarding adapters. */
export const ChannelProvider = Schema.Literals(["telegram", "whatsapp"]);

/** Messaging provider accepted by shared onboarding policy. */
export type ChannelProvider = typeof ChannelProvider.Type;

/** Explicit setup facts supplied by the person. */
export const SetupProfile = Schema.Struct({
  helpAreas: Schema.Array(HelpArea),
  locale: OnboardingLocale,
  preferredName: Schema.NullOr(
    Schema.String.check(
      Schema.makeFilter(
        (value) =>
          (value.trim().length > 0 && value.trim().length <= 80) ||
          "must contain between 1 and 80 characters",
      ),
    ),
  ),
});

/** Explicit setup facts supplied by the person. */
export type SetupProfile = typeof SetupProfile.Type;

/** Authenticated normalized event for one unknown supported-channel sender. */
export const ChannelInvitationMessage = Schema.Union([
  Schema.Struct({
    channelIdentity: ChannelIdentity,
    eventId: Schema.String,
    locale: OnboardingLocale,
    message: Schema.String,
    provider: Schema.Literal("telegram"),
  }),
  Schema.Struct({
    channelIdentity: ChannelIdentity,
    eventId: Schema.String,
    invitedPhoneNumber: Schema.String,
    locale: OnboardingLocale,
    message: Schema.String,
    provider: Schema.Literal("whatsapp"),
  }),
]);

/** Authenticated normalized event for one unknown supported-channel sender. */
export type ChannelInvitationMessage = typeof ChannelInvitationMessage.Type;

/** Authenticated normalized enrollment event for a provider channel. */
export const ChannelEnrollment = Schema.Struct({
  channelIdentity: ChannelIdentity,
  eventId: Schema.String,
  provider: ChannelProvider,
  token: Schema.RedactedFromValue(RegistrationToken),
});

/** Authenticated normalized enrollment event for a provider channel. */
export type ChannelEnrollment = typeof ChannelEnrollment.Type;

/** Public view of one Registration Invitation. */
export const InvitationView = Schema.Struct({
  locale: OnboardingLocale,
  maskedPhoneNumber: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(ChannelProvider),
  state: Schema.Literals(["live", "expired", "consumed", "invalid"]),
});

/** Public view of one Registration Invitation. */
export type InvitationView = typeof InvitationView.Type;

/** Result from issuing or recovering one channel-first Registration Invitation. */
export const RegistrationInvitationIssued = Schema.Struct({
  invitationId: RegistrationInvitationId,
  verifyUrl: Schema.URLFromString,
});

/** Result from issuing or recovering one channel-first Registration Invitation. */
export type RegistrationInvitationIssued = typeof RegistrationInvitationIssued.Type;

/** Channel state returned after authenticated onboarding completion. */
export const ChannelOnboardingState = Schema.Union([
  Schema.TaggedStruct("BindingCreated", { channelBindingId: ChannelBindingId }),
  Schema.TaggedStruct("BindingExisting", {
    channelBindingId: ChannelBindingId,
  }),
  Schema.TaggedStruct("ConsentRefused", {}),
  Schema.TaggedStruct("EnrollmentPending", {
    enrollmentUrl: Schema.URLFromString,
  }),
  Schema.TaggedStruct("NotConnected", {}),
  Schema.TaggedStruct("ProfileConfirmationPending", {}),
]);

/** Channel state returned after authenticated onboarding completion. */
export type ChannelOnboardingState = typeof ChannelOnboardingState.Type;

/** Complete onboarding result presented to the authenticated web client. */
export const OnboardingCompleted = Schema.Struct({
  agentId: AgentId,
  channel: ChannelOnboardingState,
  completedAt: Schema.Date,
  profileConfirmationRequired: Schema.Boolean,
  userId: UserId,
});

/** Complete onboarding result presented to the authenticated web client. */
export type OnboardingCompleted = typeof OnboardingCompleted.Type;

/** Expected safe failure for invalid, expired, consumed, or replaced invitations. */
export class RegistrationInvitationUnavailable extends Schema.TaggedError<RegistrationInvitationUnavailable>()(
  "RegistrationInvitationUnavailable",
  { reason: Schema.Literals(["consumed", "expired", "invalid", "replaced"]) },
) {}

/** Expected fail-closed result for a Channel Identity conflict. */
export class ChannelBindingConflict extends Schema.TaggedError<ChannelBindingConflict>()(
  "ChannelBindingConflict",
  { message: Schema.String },
) {}

/** Expected failure when secure invitation identities cannot be generated. */
export class OnboardingIdentityUnavailable extends Schema.TaggedError<OnboardingIdentityUnavailable>()(
  "OnboardingIdentityUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Expected failure when an Agent or Registration Dialogue cannot be reached. */
export class OnboardingExecutionUnavailable extends Schema.TaggedError<OnboardingExecutionUnavailable>()(
  "OnboardingExecutionUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Expected rejection when the authenticated User has not completed Phone Verification. */
export class OnboardingPhoneVerificationRequired extends Schema.TaggedError<OnboardingPhoneVerificationRequired>()(
  "OnboardingPhoneVerificationRequired",
  { message: Schema.String },
) {}

/** Expected failure when onboarding persistence cannot complete an operation. */
export class OnboardingPersistenceUnavailable extends Schema.TaggedError<OnboardingPersistenceUnavailable>()(
  "OnboardingPersistenceUnavailable",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}

/** Expected failure when Postgres rejects an atomic onboarding transition. */
export class OnboardingPersistenceRejected extends Schema.TaggedError<OnboardingPersistenceRejected>()(
  "OnboardingPersistenceRejected",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
    operationId: Schema.String,
  },
) {}

/** Input used to initialize the stable Agent and its primary Session. */
export interface InitializeAgentInput extends Registration.RegistrationCompleted {}

/** Input for the first committed personal welcome. */
export interface CommitWelcomeInput {
  readonly agentId: AgentId;
  readonly channelBindingId: ChannelBindingId;
  readonly profile: SetupProfile;
}

/** Application-owned port for stable Agent initialization and welcome commitment. */
export interface AgentOnboardingPort {
  readonly initialize: (
    input: InitializeAgentInput,
  ) => Effect.Effect<void, OnboardingExecutionUnavailable>;
  readonly commitWelcome: (
    input: CommitWelcomeInput,
  ) => Effect.Effect<void, OnboardingExecutionUnavailable>;
}

/** Agent-side onboarding behavior supplied by Cloudflare Durable Object bindings. */
export class AgentOnboarding extends Context.Service<AgentOnboarding, AgentOnboardingPort>()(
  "@osfo/AgentOnboarding",
) {}

/** Cleanup capability for invitation-scoped Registration Dialogue state. */
export interface RegistrationDialogueCleanupPort {
  readonly delete: (
    invitationId: RegistrationInvitationId,
  ) => Effect.Effect<void, OnboardingExecutionUnavailable>;
}

/** Cleanup supplied by the Registration Dialogue Durable Object binding. */
export class RegistrationDialogueCleanup extends Context.Service<
  RegistrationDialogueCleanup,
  RegistrationDialogueCleanupPort
>()("@osfo/RegistrationDialogueCleanup") {}

/** Public URL projections needed by onboarding policy. */
export interface OnboardingLinksPort {
  readonly enrollment: (
    token: Redacted.Redacted<RegistrationToken>,
    provider: ChannelProvider,
  ) => {
    readonly provider: ChannelProvider;
    readonly url: URL;
  };
  readonly registrationHome: () => URL;
  readonly verification: (token: Redacted.Redacted<RegistrationToken>) => URL;
}

/** Public onboarding links supplied by an outbound projection adapter. */
export class OnboardingLinks extends Context.Service<OnboardingLinks, OnboardingLinksPort>()(
  "@osfo/OnboardingLinks",
) {}

/** Authenticated completion input from the web journey. */
export interface CompleteInput {
  readonly existingProfileChoice: "apply" | "keep" | null;
  readonly invitationToken: Redacted.Redacted<RegistrationToken> | null;
  readonly profile: SetupProfile;
  readonly userId: UserId;
}

/** Parsed Registration Invitation stored by the control-plane persistence adapter. */
export const StoredInvitation = Schema.Struct({
  bindingOutcome: Schema.NullOr(Schema.Literals(["created", "existing", "refused"])),
  channelBindingId: Schema.NullOr(ChannelBindingId),
  channelIdentity: Schema.NullOr(ChannelIdentity),
  consumptionDigest: Schema.NullOr(Schema.String),
  expiresAt: Schema.Date,
  expiryReason: Schema.NullOr(Schema.Literals(["elapsed", "replaced"])),
  invitationId: RegistrationInvitationId,
  invitedPhoneNumber: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["telegram_first", "whatsapp_first", "web_enrollment"]),
  locale: OnboardingLocale,
  provider: ChannelProvider,
  state: Schema.Literals(["live", "expired", "consumed"]),
  userId: Schema.NullOr(UserId),
});

/** Parsed Registration Invitation stored by the control-plane persistence adapter. */
export type StoredInvitation = typeof StoredInvitation.Type;

/** Parsed User facts needed by onboarding policy. */
export const StoredOnboardingUser = Schema.Struct({
  phoneNumber: Schema.NullOr(Schema.String),
  phoneNumberVerified: Schema.Boolean,
  profile: SetupProfile,
  registrationCompletedAt: Schema.NullOr(Schema.Date),
});

/** Parsed User facts needed by onboarding policy. */
export type StoredOnboardingUser = typeof StoredOnboardingUser.Type;

/** Parsed Agent route and accepted profile used for the first personal welcome. */
export const StoredWelcomeRoute = Schema.Struct({
  agentId: AgentId,
  profile: SetupProfile,
});

/** Parsed Agent route and accepted profile used for the first personal welcome. */
export type StoredWelcomeRoute = typeof StoredWelcomeRoute.Type;

/** Parsed active Channel Binding used by atomic onboarding decisions. */
export const StoredChannelBinding = Schema.Struct({
  channelBindingId: ChannelBindingId,
  channelIdentity: ChannelIdentity,
  provider: ChannelProvider,
  userId: UserId,
});

/** Parsed active Channel Binding used by atomic onboarding decisions. */
export type StoredChannelBinding = typeof StoredChannelBinding.Type;

/** Locked facts supplied to the pure completion decision. */
export interface CompletePersistenceContext {
  readonly activeBindings: ReadonlyArray<StoredChannelBinding>;
  readonly invitation: StoredInvitation | null;
  readonly userPhoneNumber: string | null;
}

/** Locked facts supplied to the pure enrollment decision. */
export interface EnrollmentPersistenceContext {
  readonly activeBindings: ReadonlyArray<StoredChannelBinding>;
  readonly invitation: StoredInvitation | null;
}

type PersistedBindingChannel = Extract<
  ChannelOnboardingState,
  {
    readonly _tag: "BindingCreated" | "BindingExisting" | "ConsentRefused" | "NotConnected";
  }
>;

/** Application-selected atomic completion transition. */
export type CompletePersistenceDecision =
  | {
      readonly _tag: "Commit";
      readonly channel: PersistedBindingChannel;
    }
  | {
      readonly _tag: "Reject";
      readonly reason:
        | "binding-conflict"
        | "invitation-expired"
        | "invitation-invalid"
        | "invitation-unavailable";
    };

/** Application-selected atomic enrollment transition. */
export type EnrollmentPersistenceDecision =
  | {
      readonly _tag: "Commit";
      readonly channel: Extract<
        ChannelOnboardingState,
        { readonly _tag: "BindingCreated" | "BindingExisting" }
      >;
    }
  | {
      readonly _tag: "Reject";
      readonly reason: "binding-conflict" | "invitation-expired" | "invitation-unavailable";
    };

/** Atomic completion outcomes returned by onboarding persistence. */
export type CompletePersistenceResult =
  | ChannelOnboardingState
  | "binding-conflict"
  | "invitation-expired"
  | "invitation-invalid"
  | "invitation-unavailable";

/** Atomic enrollment outcomes returned by onboarding persistence. */
export type EnrollmentPersistenceResult =
  | Extract<ChannelOnboardingState, { readonly _tag: "BindingCreated" | "BindingExisting" }>
  | "binding-conflict"
  | "invitation-expired"
  | "invitation-unavailable";

/** Values needed to consume an invitation and apply accepted setup facts atomically. */
export interface CompletePersistenceInput {
  readonly acceptedProfile: SetupProfile;
  readonly applyProfile: boolean;
  readonly bindingConsent: "accepted" | "web-enrollment";
  readonly bindingId: ChannelBindingId;
  readonly invitationId: RegistrationInvitationId | null;
  readonly now: Date;
  readonly requestDigest: string;
  readonly userId: UserId;
}

/** Values needed to consume a provider-authenticated channel enrollment atomically. */
export interface EnrollPersistenceInput {
  readonly bindingId: ChannelBindingId;
  readonly channelIdentity: ChannelIdentity;
  readonly enrollmentDigest: string;
  readonly invitationId: RegistrationInvitationId;
  readonly now: Date;
  readonly provider: ChannelProvider;
  readonly userId: UserId;
}

/** Values needed to create or replace one web enrollment invitation. */
export interface WebEnrollmentPersistenceInput {
  readonly digest: string;
  readonly expiresAt: Date;
  readonly invitationId: RegistrationInvitationId;
  readonly locale: OnboardingLocale;
  readonly now: Date;
  readonly provider: ChannelProvider;
  readonly userId: UserId;
}

/** Provider facts needed to insert one channel-first Registration Invitation. */
export type ChannelFirstInvitation =
  | {
      readonly _tag: "TelegramFirst";
      readonly channelIdentity: ChannelIdentity;
    }
  | {
      readonly _tag: "WhatsAppFirst";
      readonly channelIdentity: ChannelIdentity;
      readonly invitedPhoneNumber: string;
    };

/** Values needed to insert one channel-first Registration Invitation. */
export interface ChannelInvitationPersistenceInput {
  readonly channel: ChannelFirstInvitation;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly invitationId: RegistrationInvitationId;
  readonly locale: OnboardingLocale;
  readonly providerEventId: string;
  readonly tokenDigest: string;
}

/** Application-owned control-plane persistence operations for onboarding. */
export interface PersistencePort {
  readonly complete: (
    input: CompletePersistenceInput,
    decide: (context: CompletePersistenceContext) => CompletePersistenceDecision,
  ) => Effect.Effect<CompletePersistenceResult, OnboardingPersistenceRejected>;
  readonly createWebEnrollment: (
    input: WebEnrollmentPersistenceInput,
  ) => Effect.Effect<void, OnboardingPersistenceRejected>;
  readonly enroll: (
    input: EnrollPersistenceInput,
    decide: (context: EnrollmentPersistenceContext) => EnrollmentPersistenceDecision,
  ) => Effect.Effect<EnrollmentPersistenceResult, OnboardingPersistenceRejected>;
  readonly expireByDigest: (
    digest: string,
    now: Date,
  ) => Effect.Effect<void, OnboardingPersistenceUnavailable>;
  readonly expireLive: (now: Date) => Effect.Effect<number, OnboardingPersistenceUnavailable>;
  readonly findByDigest: (
    digest: string,
  ) => Effect.Effect<StoredInvitation | null, OnboardingPersistenceUnavailable>;
  readonly findLiveChannel: (
    provider: ChannelProvider,
    channelIdentity: ChannelIdentity,
  ) => Effect.Effect<RegistrationInvitationId | null, OnboardingPersistenceUnavailable>;
  readonly insertChannelInvitation: (
    input: ChannelInvitationPersistenceInput,
  ) => Effect.Effect<boolean, OnboardingPersistenceRejected>;
  readonly readCurrentBinding: (query: {
    readonly channelBindingId: ChannelBindingId;
    readonly provider: ChannelProvider;
    readonly userId: UserId;
  }) => Effect.Effect<StoredChannelBinding | null, OnboardingPersistenceUnavailable>;
  readonly readUser: (
    userId: UserId,
  ) => Effect.Effect<StoredOnboardingUser | null, OnboardingPersistenceUnavailable>;
  readonly readWelcomeRoute: (
    userId: UserId,
  ) => Effect.Effect<StoredWelcomeRoute | null, OnboardingPersistenceUnavailable>;
}

/** Control-plane onboarding persistence supplied by a Postgres adapter. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/Onboarding/Persistence",
) {}

/** Onboarding application operations. */
export interface Interface {
  readonly issueChannelInvitation: (
    input: ChannelInvitationMessage,
  ) => Effect.Effect<
    RegistrationInvitationIssued,
    OnboardingIdentityUnavailable | OnboardingPersistenceRejected | OnboardingPersistenceUnavailable
  >;
  readonly inspectInvitation: (
    token: Redacted.Redacted<RegistrationToken>,
  ) => Effect.Effect<
    InvitationView,
    OnboardingIdentityUnavailable | OnboardingPersistenceUnavailable
  >;
  readonly phoneVerificationTarget: (
    token: Redacted.Redacted<RegistrationToken>,
  ) => Effect.Effect<
    PhoneVerificationTarget,
    | OnboardingIdentityUnavailable
    | OnboardingPersistenceUnavailable
    | RegistrationInvitationUnavailable
  >;
  readonly complete: (
    input: CompleteInput,
  ) => Effect.Effect<
    OnboardingCompleted,
    | ChannelBindingConflict
    | OnboardingExecutionUnavailable
    | OnboardingIdentityUnavailable
    | OnboardingPersistenceRejected
    | OnboardingPersistenceUnavailable
    | OnboardingPhoneVerificationRequired
    | Registration.RegistrationError
    | RegistrationInvitationUnavailable
  >;
  readonly startChannelEnrollment: (input: {
    readonly provider: ChannelProvider;
    readonly userId: UserId;
  }) => Effect.Effect<
    { readonly enrollmentUrl: URL; readonly provider: ChannelProvider },
    | OnboardingIdentityUnavailable
    | OnboardingPersistenceRejected
    | OnboardingPersistenceUnavailable
    | OnboardingPhoneVerificationRequired
  >;
  readonly enrollChannel: (
    input: ChannelEnrollment,
  ) => Effect.Effect<
    ChannelOnboardingState,
    | ChannelBindingConflict
    | OnboardingExecutionUnavailable
    | OnboardingIdentityUnavailable
    | OnboardingPersistenceRejected
    | OnboardingPersistenceUnavailable
    | RegistrationInvitationUnavailable
  >;
  readonly expireInvitations: Effect.Effect<number, OnboardingPersistenceUnavailable>;
}

/** Phone-number source allowed by one live channel-first invitation. */
export type PhoneVerificationTarget =
  | { readonly _tag: "EnteredPhoneRequired" }
  | { readonly _tag: "LockedPhone"; readonly phoneNumber: Redacted.Redacted };

/** Complete phone-first onboarding authority. */
export class Service extends Context.Service<Service, Interface>()("@osfo/Onboarding") {}

/** Construct onboarding from request-scoped application capabilities. */
export const make = Effect.gen(function* () {
  const agentOnboarding = yield* AgentOnboarding;
  const crypto = yield* Crypto.Crypto;
  const links = yield* OnboardingLinks;
  const persistence = yield* Persistence;
  const registration = yield* Registration.Service;
  const registrationDialogueCleanup = yield* RegistrationDialogueCleanup;
  const inspectInvitation = Effect.fn("Onboarding.inspectInvitation")(function* (
    token: Redacted.Redacted<RegistrationToken>,
  ) {
    const tokenDigest = yield* digestRegistrationToken(crypto, token);
    const now = yield* DateTime.now;
    const nowDate = DateTime.toDateUtc(now);
    const row = yield* persistence.findByDigest(tokenDigest);
    if (row === null) return invalidInvitationView;
    const locale: OnboardingLocale = row.locale === "es" ? "es" : "en";
    if (row.state === "live" && row.expiresAt.getTime() <= nowDate.getTime()) {
      yield* persistence.expireByDigest(tokenDigest, nowDate);
      return {
        locale,
        maskedPhoneNumber: null,
        provider: row.provider,
        state: "expired" as const,
      };
    }
    const state =
      row.state === "live" || row.state === "expired" || row.state === "consumed"
        ? row.state
        : "invalid";
    const view: InvitationView = {
      locale,
      maskedPhoneNumber:
        row.invitedPhoneNumber === null ? null : maskPhoneNumber(row.invitedPhoneNumber),
      provider: row.provider,
      state,
    };
    return view;
  });

  const phoneVerificationTarget = Effect.fn("Onboarding.phoneVerificationTarget")(function* (
    token: Redacted.Redacted<RegistrationToken>,
  ) {
    const invitation = yield* readUsableInvitation(
      persistence,
      crypto,
      token,
      yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
    );
    if (invitation.state !== "live") {
      return yield* new RegistrationInvitationUnavailable({
        reason: "invalid",
      });
    }
    if (invitation.kind === "telegram_first" && invitation.invitedPhoneNumber === null) {
      return { _tag: "EnteredPhoneRequired" } as const;
    }
    if (invitation.kind === "whatsapp_first" && invitation.invitedPhoneNumber !== null) {
      return {
        _tag: "LockedPhone",
        phoneNumber: Redacted.make(invitation.invitedPhoneNumber),
      } as const;
    }
    return yield* new RegistrationInvitationUnavailable({
      reason: "invalid",
    });
  });

  const issueChannelInvitation = Effect.fn("Onboarding.issueChannelInvitation")(function* (
    input: ChannelInvitationMessage,
  ) {
    const now = yield* DateTime.now;
    const nowDate = DateTime.toDateUtc(now);
    yield* persistence.expireLive(nowDate);
    const existing = yield* persistence.findLiveChannel(input.provider, input.channelIdentity);
    if (existing !== null) {
      return {
        invitationId: existing,
        verifyUrl: links.registrationHome(),
      };
    }

    const generated = yield* generateRegistrationInvitationIdentity(crypto);
    const invitationId = RegistrationInvitationId.make(`registration-invitation-${generated.id}`);
    const expiresAt = DateTime.toDateUtc(DateTime.add(now, { hours: 24 }));
    const inserted = yield* persistence.insertChannelInvitation({
      channel:
        input.provider === "telegram"
          ? { _tag: "TelegramFirst", channelIdentity: input.channelIdentity }
          : {
              _tag: "WhatsAppFirst",
              channelIdentity: input.channelIdentity,
              invitedPhoneNumber: input.invitedPhoneNumber,
            },
      createdAt: nowDate,
      expiresAt,
      invitationId,
      locale: input.locale,
      providerEventId: input.eventId,
      tokenDigest: generated.digest,
    });
    if (!inserted) {
      const concurrent = yield* persistence.findLiveChannel(input.provider, input.channelIdentity);
      if (concurrent === null) {
        return yield* new OnboardingPersistenceRejected({
          cause: { channelIdentity: input.channelIdentity },
          operation: "issueRegistrationInvitation",
          operationId: invitationId,
        });
      }
      return {
        invitationId: concurrent,
        verifyUrl: links.registrationHome(),
      };
    }
    const verifyUrl = links.verification(generated.token);
    return {
      invitationId,
      verifyUrl,
    };
  });

  const complete = Effect.fn("Onboarding.complete")(function* (input: CompleteInput) {
    const bindingConsent = input.invitationToken === null ? "web-enrollment" : "accepted";
    const currentTime = yield* DateTime.now;
    const invitation =
      input.invitationToken === null
        ? null
        : yield* readUsableInvitation(
            persistence,
            crypto,
            input.invitationToken,
            DateTime.toDateUtc(currentTime),
          );
    if (invitation !== null && invitation.kind === "web_enrollment") {
      return yield* new RegistrationInvitationUnavailable({
        reason: "invalid",
      });
    }
    if (invitation?.state === "consumed" && invitation.userId !== input.userId) {
      return yield* new RegistrationInvitationUnavailable({
        reason: "consumed",
      });
    }

    const profile = normalizeProfile(input.profile);
    const existingUser = yield* persistence.readUser(input.userId);
    if (
      existingUser === null ||
      existingUser.phoneNumber === null ||
      !existingUser.phoneNumberVerified
    ) {
      return yield* new OnboardingPhoneVerificationRequired({
        message: "Phone Verification is required before onboarding can complete",
      });
    }
    if (
      invitation?.state === "live" &&
      invitation.invitedPhoneNumber !== null &&
      invitation.invitedPhoneNumber !== existingUser.phoneNumber
    ) {
      return yield* new RegistrationInvitationUnavailable({
        reason: "invalid",
      });
    }
    const wasRegistered = existingUser.registrationCompletedAt !== null;
    const existingProfile = existingUser.profile;
    const profileAlreadyApplied =
      existingProfile.preferredName === profile.preferredName &&
      existingProfile.locale === profile.locale &&
      sameHelpAreas(existingProfile.helpAreas, profile.helpAreas);
    const profileConfirmationRequired =
      wasRegistered && input.existingProfileChoice === null && !profileAlreadyApplied;
    const requestDigest = yield* digestJson(crypto, {
      bindingConsent,
      existingProfileChoice: input.existingProfileChoice,
      profile,
      userId: input.userId,
    });
    const acceptedProfile =
      wasRegistered && input.existingProfileChoice === "keep" ? existingProfile : profile;

    if (invitation?.state === "consumed") {
      if (invitation.consumptionDigest !== requestDigest) {
        return yield* new RegistrationInvitationUnavailable({
          reason: "consumed",
        });
      }
      const recoveredChannel = yield* readChannelReceipt(invitation);
      const registrationResult = yield* registration.complete(input.userId);
      yield* agentOnboarding.initialize(registrationResult);
      yield* ignorePostCommitFailure(
        registrationDialogueCleanup.delete(invitation.invitationId),
        "delete-registration-dialogue",
      );
      if (
        recoveredChannel._tag === "BindingCreated" ||
        recoveredChannel._tag === "BindingExisting"
      ) {
        yield* agentOnboarding.commitWelcome({
          agentId: registrationResult.agentId,
          channelBindingId: recoveredChannel.channelBindingId,
          profile: acceptedProfile,
        });
      }
      return {
        ...registrationResult,
        channel: recoveredChannel,
        profileConfirmationRequired,
      };
    }
    if (profileConfirmationRequired) {
      const registrationResult = yield* registration.complete(input.userId);
      return {
        ...registrationResult,
        channel: { _tag: "ProfileConfirmationPending" } as const,
        profileConfirmationRequired: true,
      };
    }
    const now = yield* DateTime.now;
    const nowDate = DateTime.toDateUtc(now);
    const bindingId = ChannelBindingId.make(`channel-binding-${yield* secureUuid(crypto)}`);

    const persistenceInput: CompletePersistenceInput = {
      acceptedProfile,
      applyProfile: !(wasRegistered && input.existingProfileChoice === "keep"),
      bindingConsent,
      bindingId,
      invitationId: invitation?.invitationId ?? null,
      now: nowDate,
      requestDigest,
      userId: input.userId,
    };
    const registrationResult = yield* registration.complete(input.userId);
    yield* agentOnboarding.initialize(registrationResult);
    const channel = yield* persistence.complete(persistenceInput, (context) =>
      decideCompletion(persistenceInput, context),
    );

    if (channel === "invitation-unavailable") {
      return yield* new RegistrationInvitationUnavailable({
        reason: "consumed",
      });
    }
    if (channel === "invitation-expired") {
      return yield* new RegistrationInvitationUnavailable({
        reason: "expired",
      });
    }
    if (channel === "invitation-invalid") {
      return yield* new RegistrationInvitationUnavailable({
        reason: "invalid",
      });
    }
    if (channel === "binding-conflict") {
      return yield* new ChannelBindingConflict({
        message: "The channel identity is already bound to another User",
      });
    }

    if (invitation !== null) {
      yield* ignorePostCommitFailure(
        registrationDialogueCleanup.delete(invitation.invitationId),
        "delete-registration-dialogue",
      );
    }

    const finalChannel = channel;
    if (finalChannel._tag === "BindingCreated" || finalChannel._tag === "BindingExisting") {
      yield* agentOnboarding.commitWelcome({
        agentId: registrationResult.agentId,
        channelBindingId: finalChannel.channelBindingId,
        profile: acceptedProfile,
      });
    }
    return {
      ...registrationResult,
      channel: finalChannel,
      profileConfirmationRequired: false,
    };
  });

  const startChannelEnrollment: Interface["startChannelEnrollment"] = Effect.fn(
    "Onboarding.startChannelEnrollment",
  )(function* (input) {
    const user = yield* persistence.readUser(input.userId);
    if (
      user === null ||
      user.phoneNumber === null ||
      !user.phoneNumberVerified ||
      user.registrationCompletedAt === null
    ) {
      return yield* new OnboardingPhoneVerificationRequired({
        message: "Complete Phone Verification and registration before connecting a channel",
      });
    }
    const enrollment = yield* createWebEnrollment(
      persistence,
      crypto,
      input.userId,
      user.profile.locale,
      yield* DateTime.now,
      links,
      input.provider,
    );
    return {
      enrollmentUrl: enrollment.enrollmentUrl,
      provider: input.provider,
    };
  });

  const enrollChannel = Effect.fn("Onboarding.enrollChannel")(function* (input: ChannelEnrollment) {
    const now = yield* DateTime.now;
    const invitation = yield* readUsableInvitation(
      persistence,
      crypto,
      input.token,
      DateTime.toDateUtc(now),
    );
    if (
      invitation.kind !== "web_enrollment" ||
      invitation.userId === null ||
      invitation.provider !== input.provider
    ) {
      return yield* new RegistrationInvitationUnavailable({
        reason: "invalid",
      });
    }
    const userId = invitation.userId;
    const nowDate = DateTime.toDateUtc(now);
    const bindingId = ChannelBindingId.make(`channel-binding-${yield* secureUuid(crypto)}`);
    const enrollmentDigest = yield* digestJson(crypto, {
      channelIdentity: input.channelIdentity,
      eventId: input.eventId,
    });
    const result =
      invitation.state === "consumed"
        ? yield* Effect.gen(function* () {
            if (invitation.consumptionDigest !== enrollmentDigest) {
              return yield* new RegistrationInvitationUnavailable({
                reason: "consumed",
              });
            }
            const recovered = yield* readChannelReceipt(invitation);
            if (recovered._tag !== "BindingCreated" && recovered._tag !== "BindingExisting") {
              return yield* new RegistrationInvitationUnavailable({
                reason: "consumed",
              });
            }
            const currentBinding = yield* persistence.readCurrentBinding({
              channelBindingId: recovered.channelBindingId,
              provider: input.provider,
              userId,
            });
            if (currentBinding?.channelIdentity !== input.channelIdentity) {
              return yield* new RegistrationInvitationUnavailable({
                reason: "consumed",
              });
            }
            return recovered;
          })
        : yield* persistence.enroll(
            {
              bindingId,
              channelIdentity: input.channelIdentity,
              enrollmentDigest,
              invitationId: invitation.invitationId,
              now: nowDate,
              provider: input.provider,
              userId,
            },
            (context) =>
              decideEnrollment(bindingId, input.channelIdentity, userId, nowDate, context),
          );
    if (result === "invitation-unavailable") {
      return yield* new RegistrationInvitationUnavailable({
        reason: "consumed",
      });
    }
    if (result === "invitation-expired") {
      return yield* new RegistrationInvitationUnavailable({
        reason: "expired",
      });
    }
    if (result === "binding-conflict") {
      return yield* new ChannelBindingConflict({
        message: "The channel identity conflicts with an active Channel Binding",
      });
    }
    const route = yield* persistence.readWelcomeRoute(userId);
    if (route === null) {
      return yield* new OnboardingPersistenceUnavailable({
        cause: { userId },
        operation: "readWelcomeRoute",
      });
    }
    yield* agentOnboarding.commitWelcome({
      agentId: route.agentId,
      channelBindingId: result.channelBindingId,
      profile: route.profile,
    });
    return result;
  });

  const expireInvitations = persistence.expireLive(
    yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
  );

  return Service.of({
    complete,
    enrollChannel,
    expireInvitations,
    inspectInvitation,
    issueChannelInvitation,
    phoneVerificationTarget,
    startChannelEnrollment,
  });
});

/** Onboarding Layer that preserves its database and application requirements. */
export const layerWithoutDependencies = Layer.effect(Service, make);

const invalidInvitationView: InvitationView = {
  locale: "en",
  maskedPhoneNumber: null,
  provider: null,
  state: "invalid",
};

const normalizeProfile = (profile: SetupProfile): SetupProfile => ({
  helpAreas: [...new Set(profile.helpAreas)],
  locale: profile.locale,
  preferredName: profile.preferredName === null ? null : profile.preferredName.trim(),
});

const maskPhoneNumber = (phoneNumber: string) => {
  const visible = phoneNumber.slice(-4);
  return `${"•".repeat(Math.max(4, phoneNumber.length - visible.length))}${visible}`;
};

const secureUuid = (crypto: Crypto.Crypto) =>
  crypto.randomUUIDv7.pipe(
    Effect.mapError(
      (cause) =>
        new OnboardingIdentityUnavailable({
          cause,
          message: "A secure onboarding identity could not be generated",
        }),
    ),
  );

/** Generate one high-entropy Registration Invitation identity and digest-only token evidence. */
export const generateRegistrationInvitationIdentity = (crypto: Crypto.Crypto) =>
  Effect.gen(function* () {
    const [bytes, id] = yield* Effect.all([crypto.randomBytes(32), secureUuid(crypto)]).pipe(
      Effect.mapError(
        (cause) =>
          new OnboardingIdentityUnavailable({
            cause,
            message: "A secure Registration Token could not be generated",
          }),
      ),
    );
    const token = Redacted.make(RegistrationToken.make(encodeHex(bytes)));
    const digest = yield* digestRegistrationToken(crypto, token);
    return { digest, id, token };
  });

/** Digest one Registration Token without persisting or returning its plaintext value. */
export const digestRegistrationToken = (
  crypto: Crypto.Crypto,
  token: Redacted.Redacted<RegistrationToken>,
) =>
  crypto.digest("SHA-256", new TextEncoder().encode(Redacted.value(token))).pipe(
    Effect.map(encodeHex),
    Effect.mapError(
      (cause) =>
        new OnboardingIdentityUnavailable({
          cause,
          message: "The Registration Token could not be inspected",
        }),
    ),
  );

type RetryDigestInput =
  | {
      readonly bindingConsent: "accepted" | "web-enrollment";
      readonly existingProfileChoice: CompleteInput["existingProfileChoice"];
      readonly profile: SetupProfile;
      readonly userId: UserId;
    }
  | { readonly channelIdentity: ChannelIdentity; readonly eventId: string };

const digestJson = (crypto: Crypto.Crypto, value: RetryDigestInput) =>
  crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))).pipe(
    Effect.map(encodeHex),
    Effect.mapError(
      (cause) =>
        new OnboardingIdentityUnavailable({
          cause,
          message: "The onboarding retry evidence could not be generated",
        }),
    ),
  );

const encodeHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sameHelpAreas = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const ignorePostCommitFailure = (
  operation: Effect.Effect<void, OnboardingExecutionUnavailable>,
  operationName: "delete-registration-dialogue",
) =>
  operation.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Onboarding follow-up failed after durable completion").pipe(
        Effect.annotateLogs({ failureTag: error._tag, operation: operationName }),
      ),
    ),
  );

const decideCompletion = (
  input: CompletePersistenceInput,
  context: CompletePersistenceContext,
): CompletePersistenceDecision => {
  const invitation = context.invitation;
  if (invitation === null) {
    return { _tag: "Commit", channel: { _tag: "NotConnected" } };
  }
  if (invitation.state !== "live") {
    return { _tag: "Reject", reason: "invitation-unavailable" };
  }
  if (invitation.expiresAt.getTime() <= input.now.getTime()) {
    return { _tag: "Reject", reason: "invitation-expired" };
  }
  if (
    invitation.invitedPhoneNumber !== null &&
    invitation.invitedPhoneNumber !== context.userPhoneNumber
  ) {
    return { _tag: "Reject", reason: "invitation-invalid" };
  }
  if (input.bindingConsent !== "accepted" || invitation.channelIdentity === null) {
    return { _tag: "Commit", channel: { _tag: "ConsentRefused" } };
  }
  return decideBinding(
    input.bindingId,
    invitation.channelIdentity,
    input.userId,
    context.activeBindings,
  );
};

const decideEnrollment = (
  bindingId: ChannelBindingId,
  channelIdentity: ChannelIdentity,
  userId: UserId,
  now: Date,
  context: EnrollmentPersistenceContext,
): EnrollmentPersistenceDecision => {
  const invitation = context.invitation;
  if (invitation === null || invitation.state !== "live") {
    return { _tag: "Reject", reason: "invitation-unavailable" };
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    return { _tag: "Reject", reason: "invitation-expired" };
  }
  return decideBinding(bindingId, channelIdentity, userId, context.activeBindings);
};

const decideBinding = (
  bindingId: ChannelBindingId,
  channelIdentity: ChannelIdentity,
  userId: UserId,
  activeBindings: ReadonlyArray<StoredChannelBinding>,
): EnrollmentPersistenceDecision => {
  const matching = activeBindings.find(
    (binding) => binding.channelIdentity === channelIdentity && binding.userId === userId,
  );
  if (matching !== undefined) {
    return {
      _tag: "Commit",
      channel: {
        _tag: "BindingExisting",
        channelBindingId: matching.channelBindingId,
      },
    };
  }
  if (activeBindings.length > 0) return { _tag: "Reject", reason: "binding-conflict" };
  return {
    _tag: "Commit",
    channel: { _tag: "BindingCreated", channelBindingId: bindingId },
  };
};

const readUsableInvitation = Effect.fn("Onboarding.readUsableInvitation")(function* (
  persistence: PersistencePort,
  crypto: Crypto.Crypto,
  token: Redacted.Redacted<RegistrationToken>,
  now: Date,
) {
  const digest = yield* digestRegistrationToken(crypto, token);
  const invitation = yield* persistence.findByDigest(digest);
  if (invitation === null) {
    return yield* new RegistrationInvitationUnavailable({
      reason: "invalid",
    });
  }
  if (invitation.state === "expired") {
    return yield* new RegistrationInvitationUnavailable({
      reason: invitation.expiryReason === "replaced" ? "replaced" : "expired",
    });
  }
  if (invitation.state === "live" && invitation.expiresAt.getTime() <= now.getTime()) {
    yield* persistence.expireByDigest(digest, now);
    return yield* new RegistrationInvitationUnavailable({
      reason: "expired",
    });
  }
  return invitation;
});

const readChannelReceipt = (invitation: {
  readonly bindingOutcome: string | null;
  readonly channelBindingId: ChannelBindingId | null;
}): Effect.Effect<ChannelOnboardingState, RegistrationInvitationUnavailable> => {
  if (invitation.bindingOutcome === "refused" && invitation.channelBindingId === null) {
    return Effect.succeed({ _tag: "ConsentRefused" });
  }
  if (
    (invitation.bindingOutcome === "created" || invitation.bindingOutcome === "existing") &&
    invitation.channelBindingId !== null
  ) {
    return Effect.succeed({
      _tag: invitation.bindingOutcome === "created" ? "BindingCreated" : "BindingExisting",
      channelBindingId: invitation.channelBindingId,
    });
  }
  return new RegistrationInvitationUnavailable({ reason: "consumed" });
};

const createWebEnrollment = Effect.fn("Onboarding.createWebEnrollment")(function* (
  persistence: PersistencePort,
  crypto: Crypto.Crypto,
  userId: UserId,
  locale: OnboardingLocale,
  now: DateTime.Utc,
  links: OnboardingLinksPort,
  provider: ChannelProvider,
) {
  const identity = yield* generateRegistrationInvitationIdentity(crypto);
  const nowDate = DateTime.toDateUtc(now);
  yield* persistence.expireLive(nowDate);
  const enrollment = links.enrollment(identity.token, provider);
  const invitationId = RegistrationInvitationId.make(`registration-invitation-${identity.id}`);
  yield* persistence.createWebEnrollment({
    digest: identity.digest,
    expiresAt: DateTime.toDateUtc(DateTime.add(now, { hours: 24 })),
    invitationId,
    locale,
    now: nowDate,
    provider: enrollment.provider,
    userId,
  });
  return {
    _tag: "EnrollmentPending",
    enrollmentUrl: enrollment.url,
  } as const;
});
