import { Context, Crypto, Effect, Encoding, Layer, Redacted, Schema } from "effect";

import type { DbUnavailable } from "../db";
import type { PlanPolicyVersion, UserId } from "../domain";
import type { AdminActorId, AdminReason } from "../domain/account-administration";
import type { AuthSessionId } from "../domain/auth-session";
import { type DeletionAccessFact, DeletionCaseId } from "../domain/deletion-case";
import type { ActionId } from "../domain/action-execution";
import type { ApprovalPresentation } from "./authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Domain outcomes use the _tag discriminator. */

/** Expected failure when a secure Deletion Case identity cannot be generated. */
export class DeletionCaseIdentityUnavailable extends Schema.TaggedError<DeletionCaseIdentityUnavailable>()(
  "DeletionCaseIdentityUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Administrative Deletion Case request. */
export interface RequestCommand {
  readonly adminActorId: AdminActorId;
  readonly reason: AdminReason;
  readonly userId: UserId;
}

/** Exact immutable Approval retained with a self-service Deletion Case. */
export interface SelfDeletionApproval {
  readonly actionId: ActionId;
  readonly presentation: ApprovalPresentation;
  readonly presentationVersion: string;
  readonly replayTokenHash: SelfDeletionReplayTokenHash;
}

/** Retained server-owned Action that can approve one exact self-service deletion. */
export interface SelfDeletionAction extends SelfDeletionApproval {
  readonly authSessionId: AuthSessionId;
  readonly expiresAt: Date;
}

/** SHA-256 identity of the dedicated retained account-deletion replay bearer. */
export const SelfDeletionReplayTokenHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{64}$/u),
).pipe(Schema.brand("SelfDeletionReplayTokenHash"));

/** SHA-256 identity of the dedicated retained account-deletion replay bearer. */
export type SelfDeletionReplayTokenHash = typeof SelfDeletionReplayTokenHash.Type;

/** Exact retained credential allowed to acknowledge a consumed self-service deletion. */
export type SelfDeletionReplay = SelfDeletionApproval;

/** Reduce the dedicated replay bearer to its retained lookup identity. */
export const hashReplayToken = (crypto: Crypto.Crypto, token: Redacted.Redacted) =>
  crypto.digest("SHA-256", new TextEncoder().encode(Redacted.value(token))).pipe(
    Effect.map((digest) => SelfDeletionReplayTokenHash.make(Encoding.encodeHex(digest))),
    Effect.mapError(
      (cause) =>
        new DeletionCaseIdentityUnavailable({
          cause,
          message: "The account-deletion replay credential could not be retained",
        }),
    ),
  );

/** Exact current facts that must remain locked through the self-service access fence. */
export interface SelfDeletionAuthority {
  readonly authSessionId: AuthSessionId;
  readonly plan: "adventurer" | "free";
  readonly planPolicyVersion: PlanPolicyVersion;
}

/** Persistence result for one Deletion Case request. */
export type RequestResult =
  | { readonly _tag: "AuthorityChanged" }
  | { readonly _tag: "Created" }
  | { readonly _tag: "Existing"; readonly deletionCaseId: DeletionCaseId }
  | { readonly _tag: "MissingUser" };

/** Self-service result proving the exact request is unusable and no Case or fence exists. */
export type SelfRequestResult = RequestResult | { readonly _tag: "ActionUnavailable" };

/** Persistence result when presenting one server-owned self-service deletion Action. */
export type PresentSelfResult =
  | { readonly _tag: "AuthorityChanged" }
  | { readonly _tag: "Presented" }
  | { readonly _tag: "MissingUser" };

/** Result of authenticating one post-revocation account-deletion retry. */
export type AuthenticateSelfReplayResult =
  | {
      readonly _tag: "Authenticated";
      readonly deletionCaseId: DeletionCaseId;
      readonly userId: UserId;
    }
  | { readonly _tag: "Denied" };

/** Exact administrative access-fence persistence result. */
export type AccessFenceResult = { readonly _tag: "AuthorityChanged" } | { readonly _tag: "Fenced" };

/** Deletion Case persistence interface. */
export interface PersistencePort {
  readonly authenticateSelfReplay: (
    replay: SelfDeletionReplay,
  ) => Effect.Effect<AuthenticateSelfReplayResult, DbUnavailable>;
  readonly inspect: (userId: UserId) => Effect.Effect<DeletionAccessFact, DbUnavailable>;
  readonly markAccessFenced: (
    command: RequestCommand,
    deletionCaseId: DeletionCaseId,
  ) => Effect.Effect<AccessFenceResult, DbUnavailable>;
  readonly request: (
    command: RequestCommand,
    deletionCaseId: DeletionCaseId,
  ) => Effect.Effect<RequestResult, DbUnavailable>;
  readonly presentSelf: (
    userId: UserId,
    action: SelfDeletionAction,
  ) => Effect.Effect<PresentSelfResult, DbUnavailable>;
  readonly requestSelf: (
    userId: UserId,
    deletionCaseId: DeletionCaseId,
    approval: SelfDeletionApproval,
    authority: SelfDeletionAuthority,
  ) => Effect.Effect<SelfRequestResult, DbUnavailable>;
}

/** Deletion Case persistence capability supplied by Postgres. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/DeletionCase/Persistence",
) {}

/** Public Deletion Case authority. */
export interface Interface {
  readonly authenticateSelfReplay: PersistencePort["authenticateSelfReplay"];
  readonly inspect: PersistencePort["inspect"];
  readonly presentSelf: PersistencePort["presentSelf"];
  readonly request: (
    command: RequestCommand,
  ) => Effect.Effect<
    | { readonly _tag: "DeletionAlreadyRequested"; readonly deletionCaseId: DeletionCaseId }
    | { readonly _tag: "DeletionAuthorityChanged" }
    | { readonly _tag: "DeletionRequested"; readonly deletionCaseId: DeletionCaseId }
    | { readonly _tag: "UserMissing" },
    DbUnavailable | DeletionCaseIdentityUnavailable
  >;
  readonly requestSelf: (
    userId: UserId,
    approval: SelfDeletionApproval,
    authority: SelfDeletionAuthority,
  ) => Effect.Effect<
    | { readonly _tag: "DeletionAlreadyRequested"; readonly deletionCaseId: DeletionCaseId }
    | { readonly _tag: "DeletionActionUnavailable" }
    | { readonly _tag: "DeletionAuthorityChanged" }
    | { readonly _tag: "DeletionRequested"; readonly deletionCaseId: DeletionCaseId }
    | { readonly _tag: "UserMissing" },
    DbUnavailable | DeletionCaseIdentityUnavailable
  >;
}

/** Trusted Deletion Case authority. */
export class Service extends Context.Service<Service, Interface>()("@osfo/DeletionCase") {}

/** Construct a durable Deletion Case authority whose persistence owns the exact access fence. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const persistence = yield* Persistence;
  const secureId = Effect.mapError(
    crypto.randomUUIDv7,
    (cause) =>
      new DeletionCaseIdentityUnavailable({
        cause,
        message: "A secure Deletion Case identity could not be generated",
      }),
  );
  const requestSelf = Effect.fn("DeletionCase.requestSelf")(function* (
    userId: UserId,
    approval: SelfDeletionApproval,
    authority: SelfDeletionAuthority,
  ) {
    const deletionCaseId = DeletionCaseId.make(yield* secureId);
    const result = yield* persistence.requestSelf(userId, deletionCaseId, approval, authority);
    if (result._tag === "ActionUnavailable") {
      return { _tag: "DeletionActionUnavailable" } as const;
    }
    if (result._tag === "AuthorityChanged") return { _tag: "DeletionAuthorityChanged" } as const;
    if (result._tag === "MissingUser") return { _tag: "UserMissing" } as const;
    return result._tag === "Existing"
      ? ({
          _tag: "DeletionAlreadyRequested",
          deletionCaseId: result.deletionCaseId,
        } as const)
      : ({ _tag: "DeletionRequested", deletionCaseId } as const);
  });
  const request = Effect.fn("DeletionCase.request")(function* (command: RequestCommand) {
    const deletionCaseId = DeletionCaseId.make(yield* secureId);
    const result = yield* persistence.request(command, deletionCaseId);
    if (result._tag === "AuthorityChanged") {
      return { _tag: "DeletionAuthorityChanged" } as const;
    }
    if (result._tag === "MissingUser") return { _tag: "UserMissing" } as const;
    const retainedDeletionCaseId =
      result._tag === "Existing" ? result.deletionCaseId : deletionCaseId;
    const fence = yield* persistence.markAccessFenced(command, retainedDeletionCaseId);
    if (fence._tag === "AuthorityChanged") {
      return { _tag: "DeletionAuthorityChanged" } as const;
    }
    return result._tag === "Existing"
      ? ({
          _tag: "DeletionAlreadyRequested",
          deletionCaseId: result.deletionCaseId,
        } as const)
      : ({ _tag: "DeletionRequested", deletionCaseId } as const);
  });
  return Service.of({
    authenticateSelfReplay: persistence.authenticateSelfReplay,
    inspect: persistence.inspect,
    presentSelf: persistence.presentSelf,
    request,
    requestSelf,
  });
});

/** Deletion Case Layer that preserves its persistence dependency. */
export const layerWithoutDependencies = Layer.effect(Service, make);

export * as DeletionCase from "./deletion-case";
