import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect, Predicate, Result, Schema } from "effect";

import { DbTimestamp } from "../../../db";
import {
  ActionApprovalRecordInvalid,
  ActionApprovalStoreUnavailable,
  ApprovalCancellationRecorded,
  ActionDefinitionVersion,
  ActionDigest,
  ActionId,
  ActionMaterialityConflict,
  ActionNotApproved,
  ActionPresentation,
  ActionPresentationFound,
  ActionPresentationNotFound,
  ActionPresentationPrepared,
  ApprovalAlreadyResolved,
  ApprovalDecisionRecorded,
  ApprovalExpired,
  ApprovalStatus,
  ActionPresentationId,
  CommittedApprovedAction,
  type ApprovalActor,
  type ApprovalActorReference,
  type ApprovalRequestId,
  type CancelActionApprovalInput,
  type DecideActionApprovalInput,
  type PrepareActionPresentationInput,
} from "../../../domain/action-approval";
import { UserId } from "../../../domain";
import { AuthorizationOperationName } from "../../../domain/authorization-operation";
import type { AgentDb } from "./client";
import { actionPresentations, approvalRequests } from "./schema";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and internal tagged unions expose their discriminator as _tag. */

const approvalLifetimeMilliseconds = 15 * 60 * 1_000;

const PersistedActionPresentationField = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    label: Schema.String,
    name: Schema.String,
    value: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("integer"),
    label: Schema.String,
    name: Schema.String,
    unit: Schema.String,
    value: Schema.BigIntFromString,
  }),
  Schema.Struct({
    contentId: Schema.String,
    digestSha256: Schema.String,
    kind: Schema.Literal("content"),
    label: Schema.String,
    mediaType: Schema.String,
    name: Schema.String,
    sizeBytes: Schema.BigIntFromString,
  }),
]);

const PersistedFields = Schema.fromJsonString(Schema.Array(PersistedActionPresentationField));
const PersistedConsequences = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeFields = Schema.encodeUnknownSync(PersistedFields);
const encodeConsequences = Schema.encodeUnknownSync(PersistedConsequences);
const encodeDigestMaterial = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const StoredActionApproval = Schema.Struct({
  actionDefinitionVersion: ActionDefinitionVersion,
  actionDigest: ActionDigest,
  actionId: ActionId,
  actorAuthorityId: Schema.NullOr(Schema.String),
  actorAuthorityKind: Schema.NullOr(Schema.Literals(["authSession", "channelBinding"])),
  consequencesJson: PersistedConsequences,
  createdAt: Schema.DateFromString,
  decidedAt: Schema.NullOr(Schema.DateFromString),
  description: Schema.String,
  dispatchAmbiguousAt: Schema.NullOr(Schema.DateFromString),
  dispatchedAt: Schema.NullOr(Schema.DateFromString),
  executionId: Schema.String,
  expiresAt: Schema.DateFromString,
  fieldsJson: PersistedFields,
  operation: AuthorizationOperationName,
  originatingAuthorityId: Schema.String,
  originatingAuthorityKind: Schema.Literals([
    "authSession",
    "channelBinding",
    "scheduledTask",
    "workflow",
  ]),
  presentationId: ActionPresentationId,
  reason: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "approved", "denied", "expired", "canceled"]),
  title: Schema.String,
  userId: UserId,
});

type StoredActionApproval = typeof StoredActionApproval.Type;
type StoredActionApprovalEncoded = typeof StoredActionApproval.Encoded;

/** Internal result used to dispatch the persisted terminal decision to Think. */
interface ApprovalDecisionDispatch {
  readonly decision: "approve" | "reject";
  readonly executionId: string;
  readonly recorded: ApprovalDecisionRecorded;
}

/** Internal result used to dispatch a persisted cancellation to Think. */
interface ApprovalCancellationDispatch {
  readonly executionId: string;
  readonly recorded: ApprovalCancellationRecorded;
}

/** Durable terminal Approval handoff that may need reconciliation with Think. */
interface ApprovalTerminalDispatch {
  readonly decision: "approve" | "reject";
  readonly executionId: string;
  readonly presentationId: ActionPresentationId;
}

/** Compute the exact digest of client-safe material facts owned by one Action definition. */
export const digestActionPresentation = (
  input: PrepareActionPresentationInput,
): Effect.Effect<ActionDigest> =>
  Effect.promise(() =>
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        encodeDigestMaterial({
          actionDefinitionVersion: input.actionDefinitionVersion,
          actionId: input.actionId,
          consequences: encodeConsequences(input.consequences),
          description: input.description,
          fields: encodeFields(input.fields),
          operation: input.operation,
          originatingAuthority: input.originatingAuthority,
          title: input.title,
          userId: input.userId,
        }),
      ),
    ),
  ).pipe(
    Effect.map((digest) =>
      ActionDigest.make(
        `sha256:${Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("")}`,
      ),
    ),
  );

/** Construct durable Action Presentation and exact Approval operations. */
export const makeActionApprovalStore = (db: AgentDb) => {
  const prepare = (
    input: PrepareActionPresentationInput,
    presentationId: ActionPresentationId,
    approvalRequestId: ApprovalRequestId,
    actionDigest: ActionDigest,
  ) =>
    Effect.gen(function* () {
      // oxlint-disable-next-line effecttsgo/global-date-in-effect -- RPC timestamps use the platform Date contract.
      const expiresAt = new Date(input.createdAt.getTime() + approvalLifetimeMilliseconds);
      const outcome = yield* execute("prepareActionPresentation", () =>
        db.transaction((transaction) => {
          const existing = transaction
            .select(storedFields)
            .from(actionPresentations)
            .innerJoin(
              approvalRequests,
              eq(approvalRequests.presentationId, actionPresentations.presentationId),
            )
            .where(eq(actionPresentations.actionId, input.actionId))
            .limit(1)
            .get();
          if (existing !== undefined) {
            return {
              _tag:
                existing.actionDigest === actionDigest && existing.executionId === input.executionId
                  ? "Existing"
                  : "Conflict",
              row: existing,
            } as const;
          }

          transaction
            .insert(actionPresentations)
            .values({
              actionDefinitionVersion: input.actionDefinitionVersion,
              actionDigest,
              actionId: input.actionId,
              consequencesJson: encodeConsequences(input.consequences),
              createdAt: timestamp(input.createdAt),
              description: input.description,
              executionId: input.executionId,
              expiresAt: timestamp(expiresAt),
              fieldsJson: encodeFields(input.fields),
              operation: input.operation,
              originatingAuthorityId: authorityId(input.originatingAuthority),
              originatingAuthorityKind: authorityKind(input.originatingAuthority),
              presentationId,
              title: input.title,
              userId: input.userId,
            })
            .run();
          transaction
            .insert(approvalRequests)
            .values({
              actorAuthorityId: null,
              actorAuthorityKind: null,
              approvalRequestId,
              decidedAt: null,
              dispatchAmbiguousAt: null,
              dispatchedAt: null,
              presentationId,
              reason: null,
              status: "pending",
            })
            .run();
          const inserted = transaction
            .select(storedFields)
            .from(actionPresentations)
            .innerJoin(
              approvalRequests,
              eq(approvalRequests.presentationId, actionPresentations.presentationId),
            )
            .where(eq(actionPresentations.presentationId, presentationId))
            .limit(1)
            .get();
          return { _tag: "Inserted", row: inserted } as const;
        }),
      );
      if (outcome._tag === "Conflict") {
        return yield* new ActionMaterialityConflict({
          actionId: input.actionId,
          message: "The Action identity is already committed with different material facts",
        });
      }
      if (outcome.row === undefined) return yield* invalidRecord("prepareActionPresentation");
      const stored = yield* decodeStored("prepareActionPresentation", outcome.row);
      const view = yield* toView(stored);
      return ActionPresentationPrepared.make(view);
    });

  const inspect = (presentationId: ActionPresentationId) =>
    Effect.gen(function* () {
      const stored = yield* readStored(presentationId, "inspectActionApproval");
      return {
        found: ActionPresentationFound.make(yield* toView(stored)),
        userId: stored.userId,
      };
    });

  const decide = (input: DecideActionApprovalInput, decidedAt: Date) =>
    Effect.gen(function* () {
      const outcome = yield* execute("decideActionApproval", () =>
        db.transaction((transaction) => {
          const row = transaction
            .select(storedFields)
            .from(actionPresentations)
            .innerJoin(
              approvalRequests,
              eq(approvalRequests.presentationId, actionPresentations.presentationId),
            )
            .where(eq(actionPresentations.presentationId, input.presentationId))
            .limit(1)
            .get();
          if (row === undefined) return { _tag: "NotFound" } as const;
          const decoded = Schema.decodeResult(StoredActionApproval)(row);
          if (Result.isFailure(decoded)) return { _tag: "Invalid" } as const;
          const stored = decoded.success;
          if (stored.status !== "pending") return { _tag: "Resolved", stored } as const;
          const decision = input.decision === "approve" ? "approved" : "denied";
          transaction
            .update(approvalRequests)
            .set({
              actorAuthorityId: approvalActorId(input.actor),
              actorAuthorityKind: approvalActorKind(input.actor),
              decidedAt: timestamp(decidedAt),
              reason: input.decision === "reject" ? (input.reason ?? null) : null,
              status: decision,
            })
            .where(eq(approvalRequests.presentationId, input.presentationId))
            .run();
          return { _tag: "Recorded", decision, executionId: stored.executionId } as const;
        }),
      );

      switch (outcome._tag) {
        case "NotFound":
          return yield* notFound(input.presentationId);
        case "Invalid":
          return yield* invalidRecord("decideActionApproval");
        case "Resolved": {
          const status = yield* toStatus(outcome.stored);
          if (Predicate.isTagged(status, "Expired")) {
            return yield* new ApprovalExpired({
              expiredAt: status.expiredAt,
              message: "The Approval Request expired before the decision",
              presentationId: input.presentationId,
            });
          }
          const repeated =
            (input.decision === "approve" && Predicate.isTagged(status, "Approved")) ||
            (input.decision === "reject" && Predicate.isTagged(status, "Denied"));
          if (repeated) {
            return {
              decision: input.decision,
              executionId: outcome.stored.executionId,
              recorded: ApprovalDecisionRecorded.make({
                decision: input.decision === "approve" ? "approved" : "denied",
                presentationId: input.presentationId,
              }),
            } satisfies ApprovalDecisionDispatch;
          }
          return yield* new ApprovalAlreadyResolved({
            message: "Another terminal Approval decision already won",
            presentationId: input.presentationId,
            status,
          });
        }
        case "Recorded":
          return {
            decision: input.decision,
            executionId: outcome.executionId,
            recorded: ApprovalDecisionRecorded.make({
              decision: outcome.decision,
              presentationId: input.presentationId,
            }),
          } satisfies ApprovalDecisionDispatch;
        default:
          return outcome satisfies never;
      }
    });

  const cancel = (input: CancelActionApprovalInput, canceledAt: Date) =>
    Effect.gen(function* () {
      const outcome = yield* execute("cancelActionApproval", () =>
        db.transaction((transaction) => {
          const row = transaction
            .select(storedFields)
            .from(actionPresentations)
            .innerJoin(
              approvalRequests,
              eq(approvalRequests.presentationId, actionPresentations.presentationId),
            )
            .where(eq(actionPresentations.presentationId, input.presentationId))
            .limit(1)
            .get();
          if (row === undefined) return { _tag: "NotFound" } as const;
          const decoded = Schema.decodeResult(StoredActionApproval)(row);
          if (Result.isFailure(decoded)) return { _tag: "Invalid" } as const;
          const stored = decoded.success;
          if (stored.status === "canceled") {
            return { _tag: "Canceled", executionId: stored.executionId } as const;
          }
          if (stored.status !== "pending") return { _tag: "Resolved", stored } as const;
          transaction
            .update(approvalRequests)
            .set({
              decidedAt: timestamp(canceledAt),
              reason: input.reason,
              status: "canceled",
            })
            .where(eq(approvalRequests.presentationId, input.presentationId))
            .run();
          return { _tag: "Canceled", executionId: stored.executionId } as const;
        }),
      );
      switch (outcome._tag) {
        case "NotFound":
          return yield* notFound(input.presentationId);
        case "Invalid":
          return yield* invalidRecord("cancelActionApproval");
        case "Resolved":
          return yield* new ApprovalAlreadyResolved({
            message: "Another terminal Approval decision already won",
            presentationId: input.presentationId,
            status: yield* toStatus(outcome.stored),
          });
        case "Canceled":
          return {
            executionId: outcome.executionId,
            recorded: ApprovalCancellationRecorded.make({ presentationId: input.presentationId }),
          } satisfies ApprovalCancellationDispatch;
        default:
          return outcome satisfies never;
      }
    });

  const readStored = (presentationId: ActionPresentationId, operation: string) =>
    Effect.gen(function* () {
      const row = yield* execute(operation, () =>
        db
          .select(storedFields)
          .from(actionPresentations)
          .innerJoin(
            approvalRequests,
            eq(approvalRequests.presentationId, actionPresentations.presentationId),
          )
          .where(eq(actionPresentations.presentationId, presentationId))
          .limit(1)
          .get(),
      );
      if (row === undefined) return yield* notFound(presentationId);
      return yield* decodeStored(operation, row);
    });

  const readApproved = (actionId: ActionId) =>
    Effect.gen(function* () {
      const row = yield* execute("readApprovedAction", () =>
        db
          .select(storedFields)
          .from(actionPresentations)
          .innerJoin(
            approvalRequests,
            eq(approvalRequests.presentationId, actionPresentations.presentationId),
          )
          .where(eq(actionPresentations.actionId, actionId))
          .limit(1)
          .get(),
      );
      if (row === undefined) return yield* notApproved(actionId);
      const stored = yield* decodeStored("readApprovedAction", row);
      if (stored.status !== "approved") return yield* notApproved(actionId);
      return CommittedApprovedAction.make({
        actionId: stored.actionId,
        operation: stored.operation,
        originatingAuthority: originatingAuthority(stored),
        userId: stored.userId,
      });
    });

  const expire = (presentationId: ActionPresentationId, expiredAt: Date) =>
    execute("expireActionApproval", () =>
      db
        .update(approvalRequests)
        .set({ decidedAt: timestamp(expiredAt), status: "expired" })
        .where(
          and(
            eq(approvalRequests.presentationId, presentationId),
            eq(approvalRequests.status, "pending"),
          ),
        )
        .run(),
    ).pipe(Effect.andThen(inspect(presentationId)));

  const readTerminalDispatches = execute("readTerminalApprovalDispatches", () =>
    db
      .select({
        executionId: actionPresentations.executionId,
        presentationId: actionPresentations.presentationId,
        status: approvalRequests.status,
      })
      .from(actionPresentations)
      .innerJoin(
        approvalRequests,
        eq(approvalRequests.presentationId, actionPresentations.presentationId),
      )
      .where(
        and(
          inArray(approvalRequests.status, ["approved", "denied", "canceled"]),
          isNull(approvalRequests.dispatchAmbiguousAt),
          isNull(approvalRequests.dispatchedAt),
        ),
      )
      .all()
      .flatMap((row): ReadonlyArray<ApprovalTerminalDispatch> => {
        switch (row.status) {
          case "approved":
            return [
              {
                decision: "approve",
                executionId: row.executionId,
                presentationId: row.presentationId,
              },
            ];
          case "denied":
          case "canceled":
            return [
              {
                decision: "reject",
                executionId: row.executionId,
                presentationId: row.presentationId,
              },
            ];
          default:
            return [];
        }
      }),
  );

  const markDispatched = (presentationId: ActionPresentationId, dispatchedAt: Date) =>
    execute("markApprovalDispatched", () => {
      db.update(approvalRequests)
        .set({ dispatchedAt: timestamp(dispatchedAt) })
        .where(eq(approvalRequests.presentationId, presentationId))
        .run();
    });

  const markDispatchAmbiguous = (presentationId: ActionPresentationId, observedAt: Date) =>
    execute("markApprovalDispatchAmbiguous", () => {
      db.update(approvalRequests)
        .set({ dispatchAmbiguousAt: timestamp(observedAt) })
        .where(eq(approvalRequests.presentationId, presentationId))
        .run();
    });

  return {
    cancel,
    decide,
    expire,
    inspect,
    markDispatchAmbiguous,
    markDispatched,
    prepare,
    readApproved,
    readTerminalDispatches,
  };
};

const storedFields = {
  actionDefinitionVersion: actionPresentations.actionDefinitionVersion,
  actionDigest: actionPresentations.actionDigest,
  actionId: actionPresentations.actionId,
  actorAuthorityId: approvalRequests.actorAuthorityId,
  actorAuthorityKind: approvalRequests.actorAuthorityKind,
  consequencesJson: actionPresentations.consequencesJson,
  createdAt: actionPresentations.createdAt,
  decidedAt: approvalRequests.decidedAt,
  description: actionPresentations.description,
  dispatchAmbiguousAt: approvalRequests.dispatchAmbiguousAt,
  dispatchedAt: approvalRequests.dispatchedAt,
  executionId: actionPresentations.executionId,
  expiresAt: actionPresentations.expiresAt,
  fieldsJson: actionPresentations.fieldsJson,
  operation: actionPresentations.operation,
  originatingAuthorityId: actionPresentations.originatingAuthorityId,
  originatingAuthorityKind: actionPresentations.originatingAuthorityKind,
  presentationId: actionPresentations.presentationId,
  reason: approvalRequests.reason,
  status: approvalRequests.status,
  title: actionPresentations.title,
  userId: actionPresentations.userId,
};

const toView = (stored: StoredActionApproval) =>
  Effect.gen(function* () {
    const presentation = yield* Schema.decodeEffect(ActionPresentation)({
      actionDefinitionVersion: stored.actionDefinitionVersion,
      actionDigest: stored.actionDigest,
      actionId: stored.actionId,
      consequences: stored.consequencesJson,
      createdAt: stored.createdAt,
      description: stored.description,
      expiresAt: stored.expiresAt,
      fields: stored.fieldsJson,
      operation: stored.operation,
      presentationId: stored.presentationId,
      title: stored.title,
    }).pipe(Effect.mapError(() => invalidRecord("projectActionPresentation")));
    const status = yield* toStatus(stored);
    return { presentation, status };
  });

const toStatus = (stored: StoredActionApproval) => {
  const actor = actorReference(stored);
  switch (stored.status) {
    case "pending":
      return Effect.succeed(ApprovalStatus.make({ _tag: "Pending" }));
    case "approved":
      return actor !== null && stored.decidedAt !== null
        ? Effect.succeed(
            ApprovalStatus.make({ _tag: "Approved", actor, decidedAt: stored.decidedAt }),
          )
        : Effect.fail(invalidRecord("projectApprovalStatus"));
    case "denied":
      return actor !== null && stored.decidedAt !== null
        ? Effect.succeed(
            ApprovalStatus.make({
              _tag: "Denied",
              actor,
              decidedAt: stored.decidedAt,
              reason: stored.reason,
            }),
          )
        : Effect.fail(invalidRecord("projectApprovalStatus"));
    case "expired":
      return stored.decidedAt !== null
        ? Effect.succeed(ApprovalStatus.make({ _tag: "Expired", expiredAt: stored.decidedAt }))
        : Effect.fail(invalidRecord("projectApprovalStatus"));
    case "canceled":
      return stored.decidedAt !== null && stored.reason !== null
        ? Effect.succeed(
            ApprovalStatus.make({
              _tag: "Canceled",
              canceledAt: stored.decidedAt,
              reason: stored.reason,
            }),
          )
        : Effect.fail(invalidRecord("projectApprovalStatus"));
    default:
      return stored.status satisfies never;
  }
};

const actorReference = (stored: StoredActionApproval): ApprovalActorReference | null => {
  if (stored.actorAuthorityKind === "authSession" && stored.actorAuthorityId !== null) {
    return { _tag: "AuthSession" };
  }
  if (stored.actorAuthorityKind === "channelBinding" && stored.actorAuthorityId !== null) {
    return { _tag: "ChannelBinding" };
  }
  return null;
};

const originatingAuthority = (
  stored: StoredActionApproval,
): PrepareActionPresentationInput["originatingAuthority"] => {
  switch (stored.originatingAuthorityKind) {
    case "authSession":
      return { _tag: "AuthSession", authSessionId: stored.originatingAuthorityId };
    case "channelBinding":
      return { _tag: "ChannelBinding", channelBindingId: stored.originatingAuthorityId };
    case "scheduledTask":
    case "workflow":
      return {
        _tag: "DurableTrigger",
        triggerId: stored.originatingAuthorityId,
        triggerType: stored.originatingAuthorityKind,
      };
    default:
      return stored.originatingAuthorityKind satisfies never;
  }
};

const decodeStored = (operation: string, row: StoredActionApprovalEncoded) =>
  Schema.decodeEffect(StoredActionApproval)(row).pipe(
    Effect.mapError(() => invalidRecord(operation)),
  );

const approvalActorKind = (actor: ApprovalActor) =>
  Predicate.isTagged(actor, "AuthSession") ? ("authSession" as const) : ("channelBinding" as const);

const approvalActorId = (actor: ApprovalActor) =>
  Predicate.isTagged(actor, "AuthSession") ? actor.authSessionId : actor.channelBindingId;

const authorityKind = (authority: PrepareActionPresentationInput["originatingAuthority"]) => {
  switch (authority._tag) {
    case "AuthSession":
      return "authSession" as const;
    case "ChannelBinding":
      return "channelBinding" as const;
    case "DurableTrigger":
      return authority.triggerType;
    default:
      return authority satisfies never;
  }
};

const authorityId = (authority: PrepareActionPresentationInput["originatingAuthority"]) => {
  switch (authority._tag) {
    case "AuthSession":
      return authority.authSessionId;
    case "ChannelBinding":
      return authority.channelBindingId;
    case "DurableTrigger":
      return authority.triggerId;
    default:
      return authority satisfies never;
  }
};

const timestamp = (date: Date) => DbTimestamp.make(date.toISOString());

const execute = <A>(operation: string, effect: () => A) =>
  Effect.try({
    try: effect,
    catch: (cause) =>
      new ActionApprovalStoreUnavailable({
        cause,
        message: "Agent SQLite could not complete the Action Approval operation",
        operation,
      }),
  });

const notFound = (presentationId: ActionPresentationId) =>
  new ActionPresentationNotFound({
    message: "The Action Presentation does not exist",
    presentationId,
  });

const notApproved = (actionId: ActionId) =>
  new ActionNotApproved({
    actionId,
    message: "The Action has no persisted exact Approval",
  });

const invalidRecord = (operation: string) =>
  new ActionApprovalRecordInvalid({
    message: "Agent SQLite returned invalid Action Approval facts",
    operation,
  });
