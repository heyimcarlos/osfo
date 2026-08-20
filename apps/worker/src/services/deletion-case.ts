import { Context, Crypto, Effect, Layer, Schema } from "effect";

import type { DbUnavailable } from "../db";
import type { UserId } from "../domain";
import type { AdminActorId, AdminReason } from "../domain/account-administration";
import { type DeletionAccessFact, DeletionCaseId } from "../domain/deletion-case";
import type { AuthSessionUnavailable } from "./auth-session";
import { AuthSession } from "./auth-session";

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

/** Persistence result for one Deletion Case request. */
export type RequestResult =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Existing"; readonly deletionCaseId: DeletionCaseId }
  | { readonly _tag: "MissingUser" };

/** Deletion Case persistence interface. */
export interface PersistencePort {
  readonly inspect: (userId: UserId) => Effect.Effect<DeletionAccessFact, DbUnavailable>;
  readonly request: (
    command: RequestCommand,
    deletionCaseId: DeletionCaseId,
  ) => Effect.Effect<RequestResult, DbUnavailable>;
}

/** Deletion Case persistence capability supplied by Postgres. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/DeletionCase/Persistence",
) {}

/** Public Deletion Case authority. */
export interface Interface {
  readonly inspect: PersistencePort["inspect"];
  readonly request: (
    command: RequestCommand,
  ) => Effect.Effect<
    | { readonly _tag: "DeletionAlreadyRequested"; readonly deletionCaseId: DeletionCaseId }
    | { readonly _tag: "DeletionRequested"; readonly deletionCaseId: DeletionCaseId }
    | { readonly _tag: "UserMissing" },
    AuthSessionUnavailable | DbUnavailable | DeletionCaseIdentityUnavailable
  >;
}

/** Trusted Deletion Case authority. */
export class Service extends Context.Service<Service, Interface>()("@osfo/DeletionCase") {}

/** Construct a durable Deletion Case authority that revokes AuthSessions after the access fence. */
export const make = Effect.gen(function* () {
  const authSessions = yield* AuthSession.Service;
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
  return Service.of({
    inspect: persistence.inspect,
    request: (command) =>
      Effect.gen(function* () {
        const deletionCaseId = DeletionCaseId.make(yield* secureId);
        const result = yield* persistence.request(command, deletionCaseId);
        if (result._tag === "MissingUser") return { _tag: "UserMissing" } as const;
        yield* authSessions.revokeAllForUser(command.userId);
        return result._tag === "Existing"
          ? ({
              _tag: "DeletionAlreadyRequested",
              deletionCaseId: result.deletionCaseId,
            } as const)
          : ({ _tag: "DeletionRequested", deletionCaseId } as const);
      }),
  });
});

/** Deletion Case Layer that preserves its AuthSession.Service and persistence dependencies. */
export const layerWithoutDependencies = Layer.effect(Service, make);

export * as DeletionCase from "./deletion-case";
