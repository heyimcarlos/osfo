import { Context, Crypto, Effect, Layer, type Redacted, Schema } from "effect";

import type { DbUnavailable } from "../db";
import { UserId } from "../domain";
import {
  type AdminActorId,
  type AuthSessionAuthorityFact,
  AuthSessionId,
  DeletionCaseId,
  type LifecycleReason,
  type ManualSupportRequired,
  PhoneNumber,
  type UserLifecycleFacts,
  UserSuspensionEventId,
} from "../domain/user-lifecycle";

/* oxlint-disable eslint/no-underscore-dangle -- Effect tags and domain outcomes require this form. */

/** Expected failure when an administrative User target does not exist. */
export class LifecycleUserNotFound extends Schema.TaggedError<LifecycleUserNotFound>()(
  "LifecycleUserNotFound",
  { message: Schema.String, userId: UserId },
) {}

/** Expected failure when an AuthSession belongs to another User. */
export class AuthSessionOwnershipMismatch extends Schema.TaggedError<AuthSessionOwnershipMismatch>()(
  "AuthSessionOwnershipMismatch",
  { authSessionId: AuthSessionId, message: Schema.String, userId: UserId },
) {}

/** Safe failure when the phone verification provider does not approve a replacement code. */
export class PhoneVerificationRejected extends Schema.TaggedError<PhoneVerificationRejected>()(
  "PhoneVerificationRejected",
  { message: Schema.String },
) {}

/** Safe failure when a phone verification request is rejected. */
export class PhoneVerificationRequestRejected extends Schema.TaggedError<PhoneVerificationRequestRejected>()(
  "PhoneVerificationRequestRejected",
  { message: Schema.String },
) {}

/** Safe failure when phone verification is unavailable. */
export class PhoneVerificationUnavailable extends Schema.TaggedError<PhoneVerificationUnavailable>()(
  "PhoneVerificationUnavailable",
  { message: Schema.String },
) {}

/** Expected failure when a secure lifecycle identity cannot be generated. */
export class LifecycleIdentityUnavailable extends Schema.TaggedError<LifecycleIdentityUnavailable>()(
  "LifecycleIdentityUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Administrative command fields shared by User lifecycle operations. */
export interface AdminLifecycleCommand {
  readonly adminActorId: AdminActorId;
  readonly reason: LifecycleReason;
  readonly userId: UserId;
}

/** Administrative AuthSession revocation command. */
export interface RevokeAuthSessionCommand extends AdminLifecycleCommand {
  readonly authSessionId: AuthSessionId;
}

/** Administrative Phone Account replacement command. */
export interface PhoneReplacementCommand extends AdminLifecycleCommand {
  readonly phoneNumber: PhoneNumber;
}

/** Administrative Phone Account replacement verification command. */
export interface CompletePhoneReplacementCommand extends PhoneReplacementCommand {
  readonly code: Redacted.Redacted;
}

/** One retained administrative suspension or restoration event. */
export interface SuspensionHistoryEvent {
  readonly action: "restored" | "suspended";
  readonly adminActorId: AdminActorId;
  readonly eventId: UserSuspensionEventId;
  readonly occurredAt: Date;
  readonly reason: LifecycleReason;
}

/** Persistence result for one suspension state transition. */
export type SuspensionTransitionResult = "changed" | "unchanged" | "user-not-found";

/** Persistence result for one AuthSession revocation. */
export type SessionRevocationResult = "absent" | "revoked" | "wrong-user";

/** Persistence result for one verified Phone Account replacement. */
export type PhoneReplacementResult =
  | "deletion-requested"
  | "phone-collision"
  | "phone-unverified"
  | "replaced"
  | "unchanged"
  | "user-missing";

/** Current lifecycle facts used to decide Phone Account replacement eligibility. */
export const PhoneReplacementFacts = Schema.Union([
  Schema.TaggedStruct("MissingUser", {}),
  Schema.TaggedStruct("UnverifiedPhoneAccount", {}),
  Schema.TaggedStruct("VerifiedPhoneAccount", {
    currentPhoneNumber: PhoneNumber,
    hasCollision: Schema.Boolean,
    hasDeletionCase: Schema.Boolean,
  }),
]);

/** Current lifecycle facts used to decide Phone Account replacement eligibility. */
export type PhoneReplacementFacts = typeof PhoneReplacementFacts.Type;

/** Focused persistence input for one Phone Account replacement target. */
export interface PhoneReplacementTarget {
  readonly phoneNumber: PhoneNumber;
  readonly userId: UserId;
}

/** Persistence result for one deletion request. */
export type DeletionRequestResult =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Existing"; readonly deletionCaseId: DeletionCaseId }
  | { readonly _tag: "UserNotFound" };

/** Narrow persistence boundary owned by the User lifecycle application service. */
export interface PersistencePort {
  readonly inspectAuthSession: (
    userId: UserId,
    authSessionId: AuthSessionId,
  ) => Effect.Effect<AuthSessionAuthorityFact, DbUnavailable>;
  readonly readPhoneReplacementFacts: (
    target: PhoneReplacementTarget,
  ) => Effect.Effect<PhoneReplacementFacts, DbUnavailable>;
  readonly inspectUser: (userId: UserId) => Effect.Effect<UserLifecycleFacts | null, DbUnavailable>;
  readonly replacePhoneAccount: (
    target: PhoneReplacementTarget,
  ) => Effect.Effect<PhoneReplacementResult, DbUnavailable>;
  readonly requestDeletion: (
    command: AdminLifecycleCommand,
    deletionCaseId: DeletionCaseId,
  ) => Effect.Effect<DeletionRequestResult, DbUnavailable>;
  readonly revokeAuthSession: (
    command: RevokeAuthSessionCommand,
  ) => Effect.Effect<SessionRevocationResult, DbUnavailable>;
  readonly suspensionHistory: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<SuspensionHistoryEvent>, DbUnavailable>;
  readonly transitionSuspension: (
    command: AdminLifecycleCommand,
    eventId: UserSuspensionEventId,
    action: "restored" | "suspended",
  ) => Effect.Effect<SuspensionTransitionResult, DbUnavailable>;
}

/** User lifecycle persistence capability supplied by an outbound adapter. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/UserLifecycle/Persistence",
) {}

/** Provider-neutral phone verification capability owned by User lifecycle. */
export interface PhoneVerificationPort {
  readonly sendCode: (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<void, PhoneVerificationRequestRejected | PhoneVerificationUnavailable>;
  readonly verifyCode: (
    phoneNumber: PhoneNumber,
    code: Redacted.Redacted,
  ) => Effect.Effect<boolean, PhoneVerificationUnavailable>;
}

/** Phone verification capability supplied by an outbound provider adapter. */
export class PhoneVerification extends Context.Service<PhoneVerification, PhoneVerificationPort>()(
  "@osfo/UserLifecycle/PhoneVerification",
) {}

/** User lifecycle operations available only through a trusted administrator boundary. */
export interface Interface {
  readonly beginPhoneReplacement: (
    command: PhoneReplacementCommand,
  ) => Effect.Effect<
    PhoneReplacementStarted | ManualSupportRequired,
    DbUnavailable | PhoneVerificationRequestRejected | PhoneVerificationUnavailable
  >;
  readonly completePhoneReplacement: (
    command: CompletePhoneReplacementCommand,
  ) => Effect.Effect<
    PhoneAccountReplaced | PhoneAccountUnchanged | ManualSupportRequired,
    DbUnavailable | PhoneVerificationRejected | PhoneVerificationUnavailable
  >;
  readonly inspectAuthSession: PersistencePort["inspectAuthSession"];
  readonly inspectUser: (
    userId: UserId,
  ) => Effect.Effect<UserLifecycleFacts, DbUnavailable | LifecycleUserNotFound>;
  readonly requestDeletion: (
    command: AdminLifecycleCommand,
  ) => Effect.Effect<
    DeletionAlreadyRequested | DeletionRequested,
    DbUnavailable | LifecycleIdentityUnavailable | LifecycleUserNotFound
  >;
  readonly requestRecovery: Effect.Effect<ManualSupportRequired>;
  readonly restore: (
    command: AdminLifecycleCommand,
  ) => Effect.Effect<
    AlreadyActive | UserRestored,
    DbUnavailable | LifecycleIdentityUnavailable | LifecycleUserNotFound
  >;
  readonly revokeAuthSession: (
    command: RevokeAuthSessionCommand,
  ) => Effect.Effect<
    AuthSessionAlreadyRevoked | AuthSessionRevoked,
    AuthSessionOwnershipMismatch | DbUnavailable
  >;
  readonly suspend: (
    command: AdminLifecycleCommand,
  ) => Effect.Effect<
    AlreadySuspended | UserSuspended,
    DbUnavailable | LifecycleIdentityUnavailable | LifecycleUserNotFound
  >;
  readonly suspensionHistory: PersistencePort["suspensionHistory"];
}

/** All typed failures exposed by the trusted User lifecycle interface. */
export type LifecycleError =
  | AuthSessionOwnershipMismatch
  | DbUnavailable
  | LifecycleIdentityUnavailable
  | LifecycleUserNotFound
  | PhoneVerificationRequestRejected
  | PhoneVerificationRejected
  | PhoneVerificationUnavailable;

/** The User was suspended and one history event was appended. */
export interface UserSuspended {
  readonly _tag: "UserSuspended";
  readonly eventId: UserSuspensionEventId;
}
/** The User already had a current suspension fact. */
export interface AlreadySuspended {
  readonly _tag: "AlreadySuspended";
}
/** The User was restored and one history event was appended. */
export interface UserRestored {
  readonly _tag: "UserRestored";
  readonly eventId: UserSuspensionEventId;
}
/** The User already had no current suspension fact. */
export interface AlreadyActive {
  readonly _tag: "AlreadyActive";
}
/** One Better Auth session was revoked. */
export interface AuthSessionRevoked {
  readonly _tag: "AuthSessionRevoked";
  readonly authSessionId: AuthSessionId;
}
/** The selected Better Auth session was already absent. */
export interface AuthSessionAlreadyRevoked {
  readonly _tag: "AuthSessionAlreadyRevoked";
  readonly authSessionId: AuthSessionId;
}
/** The phone verification provider accepted a support-approved replacement request. */
export interface PhoneReplacementStarted {
  readonly _tag: "PhoneReplacementStarted";
}
/** The verified Phone Account changed and every existing AuthSession was revoked. */
export interface PhoneAccountReplaced {
  readonly _tag: "PhoneAccountReplaced";
}
/** The verified Phone Account already used the selected number. */
export interface PhoneAccountUnchanged {
  readonly _tag: "PhoneAccountUnchanged";
}
/** One Deletion Case was created and every existing AuthSession was revoked. */
export interface DeletionRequested {
  readonly _tag: "DeletionRequested";
  readonly deletionCaseId: DeletionCaseId;
}
/** The User already had a Deletion Case. */
export interface DeletionAlreadyRequested {
  readonly _tag: "DeletionAlreadyRequested";
  readonly deletionCaseId: DeletionCaseId;
}

/** Trusted v1 administrative User lifecycle service. */
export class Service extends Context.Service<Service, Interface>()("@osfo/UserLifecycle") {}

/** Construct the User lifecycle service from its narrow outbound capabilities. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const persistence = yield* Persistence;
  const phoneVerification = yield* PhoneVerification;
  const secureId = Effect.mapError(
    crypto.randomUUIDv7,
    (cause) =>
      new LifecycleIdentityUnavailable({
        cause,
        message: "A secure User lifecycle identity could not be generated",
      }),
  );
  const inspectUser = (userId: UserId) =>
    persistence
      .inspectUser(userId)
      .pipe(
        Effect.flatMap((facts) =>
          facts === null
            ? Effect.fail(new LifecycleUserNotFound({ message: "The User does not exist", userId }))
            : Effect.succeed(facts),
        ),
      );

  return Service.of({
    beginPhoneReplacement: (command) =>
      Effect.gen(function* () {
        const facts = yield* persistence.readPhoneReplacementFacts(phoneReplacementTarget(command));
        if (!isPhoneReplacementEligible(facts)) {
          return manualSupport("Phone replacement requires manual support.");
        }
        yield* phoneVerification.sendCode(command.phoneNumber);
        return { _tag: "PhoneReplacementStarted" } as const;
      }),
    completePhoneReplacement: (command) =>
      Effect.gen(function* () {
        const approved = yield* phoneVerification.verifyCode(command.phoneNumber, command.code);
        if (!approved) {
          return yield* new PhoneVerificationRejected({
            message: "The phone verification code was not accepted",
          });
        }
        const result = yield* persistence.replacePhoneAccount(phoneReplacementTarget(command));
        if (result !== "replaced" && result !== "unchanged") {
          return manualSupport("Phone replacement requires manual support.");
        }
        return result === "unchanged"
          ? ({ _tag: "PhoneAccountUnchanged" } as const)
          : ({ _tag: "PhoneAccountReplaced" } as const);
      }),
    inspectAuthSession: persistence.inspectAuthSession,
    inspectUser,
    requestDeletion: (command) =>
      Effect.flatMap(secureId, (id) => {
        const deletionCaseId = DeletionCaseId.make(id);
        return persistence.requestDeletion(command, deletionCaseId).pipe(
          Effect.flatMap((result) => {
            if (result._tag === "UserNotFound") {
              return Effect.fail(
                new LifecycleUserNotFound({
                  message: "The User does not exist",
                  userId: command.userId,
                }),
              );
            }
            return Effect.succeed(
              result._tag === "Existing"
                ? ({
                    _tag: "DeletionAlreadyRequested",
                    deletionCaseId: result.deletionCaseId,
                  } as const)
                : ({ _tag: "DeletionRequested", deletionCaseId } as const),
            );
          }),
        );
      }),
    requestRecovery: Effect.succeed(manualSupport("Account recovery requires manual support.")),
    restore: (command) =>
      Effect.gen(function* () {
        const id = yield* secureId;
        const eventId = UserSuspensionEventId.make(id);
        const result = yield* persistence.transitionSuspension(command, eventId, "restored");
        if (result === "user-not-found") {
          return yield* new LifecycleUserNotFound({
            message: "The User does not exist",
            userId: command.userId,
          });
        }
        return result === "changed"
          ? ({ _tag: "UserRestored", eventId } as const)
          : ({ _tag: "AlreadyActive" } as const);
      }),
    revokeAuthSession: (command) =>
      persistence.revokeAuthSession(command).pipe(
        Effect.flatMap((result) =>
          result === "wrong-user"
            ? Effect.fail(
                new AuthSessionOwnershipMismatch({
                  authSessionId: command.authSessionId,
                  message: "The AuthSession does not belong to the selected User",
                  userId: command.userId,
                }),
              )
            : Effect.succeed(
                result === "revoked"
                  ? ({ _tag: "AuthSessionRevoked", authSessionId: command.authSessionId } as const)
                  : ({
                      _tag: "AuthSessionAlreadyRevoked",
                      authSessionId: command.authSessionId,
                    } as const),
              ),
        ),
      ),
    suspend: (command) =>
      Effect.gen(function* () {
        const id = yield* secureId;
        const eventId = UserSuspensionEventId.make(id);
        const result = yield* persistence.transitionSuspension(command, eventId, "suspended");
        if (result === "user-not-found") {
          return yield* new LifecycleUserNotFound({
            message: "The User does not exist",
            userId: command.userId,
          });
        }
        return result === "changed"
          ? ({ _tag: "UserSuspended", eventId } as const)
          : ({ _tag: "AlreadySuspended" } as const);
      }),
    suspensionHistory: persistence.suspensionHistory,
  });
});

/** User lifecycle Layer that preserves its required outbound capabilities. */
export const layerWithoutDependencies = Layer.effect(Service, make);

/** Read whether an existing User may create or use an AuthSession. Missing facts deny access. */
export const canCreateAuthSession = (persistence: PersistencePort, userId: UserId) =>
  persistence
    .inspectUser(userId)
    .pipe(
      Effect.map(
        (facts) =>
          facts !== null &&
          facts.user._tag === "ActiveUser" &&
          facts.deletionAccess._tag === "DeletionAccessAvailable",
      ),
    );

const manualSupport = (message: string): ManualSupportRequired => ({
  _tag: "ManualSupportRequired",
  message,
});

const phoneReplacementTarget = (command: PhoneReplacementCommand): PhoneReplacementTarget => ({
  phoneNumber: command.phoneNumber,
  userId: command.userId,
});

const isPhoneReplacementEligible = (facts: PhoneReplacementFacts) =>
  facts._tag === "VerifiedPhoneAccount" && !facts.hasDeletionCase && !facts.hasCollision;
