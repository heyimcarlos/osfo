import { Context, Effect, Layer, type Redacted, Schema } from "effect";

import type { UserId } from "../domain";
import type { ManualSupportRequired } from "../domain/account-administration";
import { PhoneNumber } from "../domain/phone-account";
import { Service as DeletionCase } from "./deletion-case";
import type { DbUnavailable } from "../db";

/* oxlint-disable eslint/no-underscore-dangle -- Domain facts and outcomes use the _tag discriminator. */

/** Safe failure when the @osfo/auth Phone Account authority is unavailable. */
export class PhoneAccountUnavailable extends Schema.TaggedError<PhoneAccountUnavailable>()(
  "PhoneAccountUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Safe failure when the phone verification provider rejects a request. */
export class PhoneVerificationRequestRejected extends Schema.TaggedError<PhoneVerificationRequestRejected>()(
  "PhoneVerificationRequestRejected",
  { message: Schema.String },
) {}

/** Safe failure when the phone verification provider is unavailable. */
export class PhoneVerificationUnavailable extends Schema.TaggedError<PhoneVerificationUnavailable>()(
  "PhoneVerificationUnavailable",
  { message: Schema.String },
) {}

/** Safe failure when the phone verification provider rejects a replacement code. */
export class PhoneVerificationRejected extends Schema.TaggedError<PhoneVerificationRejected>()(
  "PhoneVerificationRejected",
  { message: Schema.String },
) {}

/** Administrative Phone Account replacement command. */
export interface ReplacementCommand {
  readonly phoneNumber: PhoneNumber;
  readonly userId: UserId;
}

/** Administrative Phone Account replacement verification command. */
export interface CompleteReplacementCommand extends ReplacementCommand {
  readonly code: Redacted.Redacted;
}

/** Current Phone Account facts used to decide replacement eligibility. */
export const ReplacementFacts = Schema.Union([
  Schema.TaggedStruct("MissingUser", {}),
  Schema.TaggedStruct("UnverifiedPhoneAccount", {}),
  Schema.TaggedStruct("VerifiedPhoneAccount", {
    currentPhoneNumber: PhoneNumber,
    hasCollision: Schema.Boolean,
  }),
]);

/** Current Phone Account facts used to decide replacement eligibility. */
export type ReplacementFacts = typeof ReplacementFacts.Type;

/** Narrow request-scoped Better Auth capability used by the Phone Account module. */
export interface StorePort {
  readonly inspectReplacement: (
    userId: UserId,
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<ReplacementFacts, PhoneAccountUnavailable>;
  readonly replaceAndRevokeSessions: (
    userId: UserId,
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<
    | "deletion-requested"
    | "phone-collision"
    | "phone-unverified"
    | "replaced"
    | "unchanged"
    | "user-missing",
    PhoneAccountUnavailable
  >;
}

/** Phone Account storage capability supplied by the @osfo/auth adapter. */
export class Store extends Context.Service<Store, StorePort>()("@osfo/PhoneAccount/Store") {}

/** Provider-neutral phone verification interface. */
export interface VerificationPort {
  readonly sendCode: (
    phoneNumber: PhoneNumber,
  ) => Effect.Effect<void, PhoneVerificationRequestRejected | PhoneVerificationUnavailable>;
  readonly verifyCode: (
    phoneNumber: PhoneNumber,
    code: Redacted.Redacted,
  ) => Effect.Effect<boolean, PhoneVerificationUnavailable>;
}

/** Phone verification capability supplied by an outbound provider adapter. */
export class Verification extends Context.Service<Verification, VerificationPort>()(
  "@osfo/PhoneAccount/Verification",
) {}

/** Public Phone Account authority. */
export interface Interface {
  readonly beginReplacement: (
    command: ReplacementCommand,
  ) => Effect.Effect<
    { readonly _tag: "PhoneReplacementStarted" } | ManualSupportRequired,
    | DbUnavailable
    | PhoneAccountUnavailable
    | PhoneVerificationRequestRejected
    | PhoneVerificationUnavailable
  >;
  readonly completeReplacement: (
    command: CompleteReplacementCommand,
  ) => Effect.Effect<
    | { readonly _tag: "PhoneAccountReplaced" }
    | { readonly _tag: "PhoneAccountUnchanged" }
    | ManualSupportRequired,
    | DbUnavailable
    | PhoneAccountUnavailable
    | PhoneVerificationRejected
    | PhoneVerificationUnavailable
  >;
  readonly requestRecovery: Effect.Effect<ManualSupportRequired>;
}

/** Trusted Phone Account authority. */
export class Service extends Context.Service<Service, Interface>()("@osfo/PhoneAccount") {}

/** Construct Phone Account authority from @osfo/auth, Deletion Case, and verification interfaces. */
export const make = Effect.gen(function* () {
  const deletionCases = yield* DeletionCase;
  const store = yield* Store;
  const verification = yield* Verification;
  return Service.of({
    beginReplacement: (command) =>
      Effect.gen(function* () {
        const [account, deletionAccess] = yield* Effect.all([
          store.inspectReplacement(command.userId, command.phoneNumber),
          deletionCases.inspect(command.userId),
        ]);
        if (
          account._tag !== "VerifiedPhoneAccount" ||
          account.hasCollision ||
          deletionAccess._tag === "DeletionAccessRevoked"
        ) {
          return manualSupport("Phone replacement requires manual support.");
        }
        yield* verification.sendCode(command.phoneNumber);
        return { _tag: "PhoneReplacementStarted" } as const;
      }),
    completeReplacement: (command) =>
      Effect.gen(function* () {
        const approved = yield* verification.verifyCode(command.phoneNumber, command.code);
        if (!approved) {
          return yield* new PhoneVerificationRejected({
            message: "The phone verification code was not accepted",
          });
        }
        const deletionAccess = yield* deletionCases.inspect(command.userId);
        if (deletionAccess._tag === "DeletionAccessRevoked") {
          return manualSupport("Phone replacement requires manual support.");
        }
        const result = yield* store.replaceAndRevokeSessions(command.userId, command.phoneNumber);
        if (result !== "replaced" && result !== "unchanged") {
          return manualSupport("Phone replacement requires manual support.");
        }
        return result === "unchanged"
          ? ({ _tag: "PhoneAccountUnchanged" } as const)
          : ({ _tag: "PhoneAccountReplaced" } as const);
      }),
    requestRecovery: Effect.succeed(manualSupport("Account recovery requires manual support.")),
  });
});

/** Phone Account Layer that preserves its separate authority dependencies. */
export const layerWithoutDependencies = Layer.effect(Service, make);

const manualSupport = (message: string): ManualSupportRequired => ({
  _tag: "ManualSupportRequired",
  message,
});
