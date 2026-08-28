import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";

import {
  AgentId,
  type AllowancePeriodId,
  type CapabilityCatalogVersion,
  type ConversationRouteId,
  ModelAccessPolicyVersion,
  type PlanPolicyVersion,
  type ResourcePriceVersion,
  type SessionId,
  UserId,
} from "../domain";
import type { ActionId } from "../domain/action-execution";
import { currentCapabilityCatalog } from "../domain/capability-catalog";
import { DocumentArtifact } from "../domain/document-artifact";
import { FileDigest, FileMediaType } from "../domain/file-content";
import { FileId } from "../domain/file";
import type { ManagedModelRoute } from "../domain/model-access-policy";
import {
  launchModelAccessPolicy,
  selectManagedRoute,
  sharedUsageModelAccessPolicy,
} from "../domain/model-access-policy";
import {
  isLaunchPolicy,
  policyFor,
  policyForVersion,
  retainedCatalog,
} from "../domain/plan-policy";
import { currentResourcePriceVersion } from "../domain/usage";
import {
  type AuthorizationContext,
  type Denied,
  Authorization,
  type OriginatingAuthority,
} from "./authorization";
import { DocumentSource, type CostEvidence } from "./document-generation";

/* oxlint-disable eslint/no-underscore-dangle, typescript/consistent-return -- Document Build outcomes use the standard Effect discriminator and generator branches fail through Effect. */

const boundedIdentity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const WorkflowId = boundedIdentity.pipe(Schema.brand("DocumentBuildWorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;

export const CloudflareInstanceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/u),
).pipe(Schema.brand("DocumentBuildCloudflareInstanceId"));
export type CloudflareInstanceId = typeof CloudflareInstanceId.Type;

export const InputDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("DocumentBuildInputDigest"),
);
export type InputDigest = typeof InputDigest.Type;

/** Public/model request. File metadata always comes from the owning Agent. */
export const Request = Schema.Struct({
  fileIds: Schema.Array(FileId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
    Schema.makeFilter(
      (fileIds) => new Set(fileIds).size === fileIds.length || "fileIds must be unique",
    ),
  ),
  format: DocumentArtifact.DocumentFormat,
});
export type Request = typeof Request.Type;

/** Immutable metadata captured from one ready, owned, non-deleted FileRecord. */
export const FileSnapshot = Schema.Struct({
  byteLength: Schema.BigIntFromString,
  fileId: FileId,
  mediaType: FileMediaType,
  sha256: FileDigest,
});
export type FileSnapshot = typeof FileSnapshot.Type;

/** Minimal private Agent RPC result. It deliberately excludes storage keys and upload state. */
export const ResolvedFile = Schema.Struct({
  ...FileSnapshot.fields,
  fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  normalizedText: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000_000)),
});
export type ResolvedFile = typeof ResolvedFile.Type;

/** Private Directory RPC request for authoritative Document Build source facts. */
export const FileResolutionRequest = Schema.Struct({
  agentId: AgentId,
  fileIds: Request.fields.fileIds,
  userId: UserId,
});
export type FileResolutionRequest = typeof FileResolutionRequest.Type;

/** Minimal private RPC result. Storage keys and upload lifecycle facts never cross this seam. */
export const FileResolutionResult = Schema.Union([
  Schema.TaggedStruct("Resolved", { files: Schema.Array(ResolvedFile) }),
  Schema.TaggedStruct("Unavailable", {
    reason: Schema.Literals([
      "deletionFenced",
      "fileUnavailable",
      "invalidRequest",
      "routeMismatch",
    ]),
  }),
]);
export type FileResolutionResult = typeof FileResolutionResult.Type;

/** Exact immutable request retained before Cloudflare acceptance. */
export const StoredRequest = Schema.Struct({
  fileSnapshots: Schema.Array(FileSnapshot).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  format: DocumentArtifact.DocumentFormat,
  source: DocumentSource,
});
export type StoredRequest = typeof StoredRequest.Type;

export const WorkflowPayload = Schema.Struct({
  inputDigest: InputDigest,
  workflowId: WorkflowId,
});
export type WorkflowPayload = typeof WorkflowPayload.Type;

export const State = Schema.Literals([
  "admitted",
  "accepted",
  "running",
  "preview_stored",
  "publication_committed",
  "cancel_requested",
  "success",
  "failure",
  "canceled",
]);
export type State = typeof State.Type;

export const terminalStates = new Set<State>(["success", "failure", "canceled"]);

export interface Record {
  readonly workflowId: WorkflowId;
  readonly actionId: ActionId;
  readonly userId: UserId;
  readonly agentId: AgentId;
  readonly routeId: ConversationRouteId;
  readonly sessionId: SessionId;
  readonly originatingAuthority: typeof OriginatingAuthority.Type;
  readonly inputDigest: InputDigest;
  readonly request: StoredRequest;
  readonly state: State;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly planPolicyVersion: PlanPolicyVersion;
  readonly capabilityCatalogVersion: CapabilityCatalogVersion;
  readonly modelAccessPolicyVersion: ModelAccessPolicyVersion;
  readonly modelRoute: ManagedModelRoute;
  readonly resourcePriceVersion: ResourcePriceVersion;
  readonly manifestVersion: string | null;
  readonly cloudflareInstanceId: CloudflareInstanceId;
  readonly cloudflareTimerInstanceId: CloudflareInstanceId;
  readonly artifactContentId: string | null;
  readonly costEvidence: CostEvidence | null;
  readonly safeFailureCode: string | null;
  readonly admittedAt: Date;
  readonly deadlineAt: Date;
  readonly acceptedAt: Date | null;
  readonly startedAt: Date | null;
  readonly previewStoredAt: Date | null;
  readonly accountingCommittedAt: Date | null;
  readonly publicationCommittedAt: Date | null;
  readonly artifactAccountedAt: Date | null;
  readonly cancelRequestedAt: Date | null;
  readonly terminalAt: Date | null;
}

export interface StartInput {
  readonly actionId: ActionId;
  readonly agentId: AgentId;
  readonly authorization: AuthorizationContext;
  readonly request: Request;
  readonly routeId: ConversationRouteId;
  readonly sessionId: SessionId;
}

export type StartResult =
  | { readonly _tag: "Started"; readonly build: Record }
  | { readonly _tag: "Replayed"; readonly build: Record }
  | { readonly _tag: "AcceptancePending"; readonly build: Record };

export type CancelResult =
  | { readonly _tag: "CancelRequested"; readonly build: Record }
  | { readonly _tag: "PublicationCommitted"; readonly build: Record }
  | { readonly _tag: "Terminal"; readonly build: Record };

export class Conflict extends Schema.TaggedError<Conflict>()("DocumentBuildConflict", {
  message: Schema.String,
  workflowId: WorkflowId,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("DocumentBuildNotFound", {
  workflowId: WorkflowId,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("DocumentBuildUnavailable", {
  cause: Schema.Defect(),
  message: Schema.String,
  operation: Schema.String,
}) {}

type Persisted =
  | { readonly _tag: "Created"; readonly build: Record }
  | { readonly _tag: "Existing"; readonly build: Record };

export interface PortInterface {
  readonly currentAuthorization: (
    build: Record,
  ) => Effect.Effect<AuthorizationContext, Unavailable>;
  readonly discardPendingArtifact: (build: Record) => Effect.Effect<void, Unavailable>;
  readonly files: {
    readonly resolve: (
      agentId: AgentId,
      userId: UserId,
      fileIds: ReadonlyArray<FileId>,
    ) => Effect.Effect<ReadonlyArray<ResolvedFile>, Unavailable>;
  };
  readonly recordWorkflowStart: (build: Record) => Effect.Effect<void, Unavailable>;
  readonly commitPreviewReadyFollowUp: (build: Record) => Effect.Effect<void, Unavailable>;
  readonly commitTerminalFollowUp: (build: Record) => Effect.Effect<void, Unavailable>;
  readonly persistence: {
    readonly admit: (
      record: Record,
      activeWorkflowLimit: bigint,
    ) => Effect.Effect<Persisted, Conflict | Denied | Unavailable>;
    readonly inspect: (workflowId: WorkflowId) => Effect.Effect<Record | null, Unavailable>;
    readonly markAccepted: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      acceptedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly beginExecution: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      startedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly markPreviewStored: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      contentId: string,
      storedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly markAccountingCommitted: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      contentId: string,
      cost: CostEvidence,
      committedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly commitPublication: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      contentId: string,
      committedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly finishSuccess: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      contentId: string,
      accountedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly enforceDeadline: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      checkedAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly finishTerminal: (
      workflowId: WorkflowId,
      inputDigest: InputDigest,
      state: "canceled" | "failure",
      safeFailureCode: string,
      terminalAt: Date,
    ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
    readonly requestCancel: (
      workflowId: WorkflowId,
      userId: UserId,
      requestedAt: Date,
    ) => Effect.Effect<Record, NotFound | Unavailable>;
  };
  readonly workflow: {
    readonly create: (
      mainInstanceId: CloudflareInstanceId,
      timerInstanceId: CloudflareInstanceId,
      payload: WorkflowPayload,
    ) => Effect.Effect<void, Unavailable>;
    readonly terminate: (
      mainInstanceId: CloudflareInstanceId,
      timerInstanceId: CloudflareInstanceId,
    ) => Effect.Effect<void, Unavailable>;
  };
}

export class Port extends Context.Service<Port, PortInterface>()("@osfo/DocumentBuild/Port") {}

export interface Interface {
  readonly artifactAuthorization: (
    payload: WorkflowPayload,
    requestVendorUsdMicros: bigint,
  ) => Effect.Effect<
    { readonly authorization: AuthorizationContext; readonly build: Record },
    Conflict | Denied | NotFound | Unavailable
  >;
  readonly authorizeExecution: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly beginExecution: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly cancel: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<CancelResult, Conflict | Denied | NotFound | Unavailable>;
  readonly commitAccounting: (
    payload: WorkflowPayload,
    contentId: string,
    cost: CostEvidence,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly commitPublication: (
    payload: WorkflowPayload,
    contentId: string,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly finishCanceled: (
    payload: WorkflowPayload,
    safeFailureCode: string,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly finishFailure: (
    payload: WorkflowPayload,
    safeFailureCode: string,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly finishSuccess: (
    payload: WorkflowPayload,
    contentId: string,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly inspect: (
    workflowId: WorkflowId,
    userId: UserId,
  ) => Effect.Effect<Record, Denied | NotFound | Unavailable>;
  /** Workflow-only identity inspection; it grants no User read authority. */
  readonly inspectExecution: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly markPreviewStored: (
    payload: WorkflowPayload,
    contentId: string,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly reconcileAcceptance: (
    workflowId: WorkflowId,
    inputDigest: InputDigest,
  ) => Effect.Effect<Record, Conflict | Denied | NotFound | Unavailable>;
  readonly resumePublication: (
    payload: WorkflowPayload,
  ) => Effect.Effect<Record, Conflict | NotFound | Unavailable>;
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<StartResult, Conflict | Denied | NotFound | Unavailable>;
}

export class Service extends Context.Service<Service, Interface>()("@osfo/DocumentBuild") {}

export const make = Effect.gen(function* () {
  const ports = yield* Port;
  const authorization = Authorization.make(retainedCatalog);

  const authorizeControl = Effect.fn("DocumentBuild.authorizeControl")(function* (
    build: Record,
    kind: "workflow.cancel" | "workflow.inspect",
  ) {
    const current = yield* ports.currentAuthorization(build);
    const result = authorization.recheck(
      { ...current, approval: null },
      { actionId: build.actionId, kind },
    );
    if (Predicate.isTagged(result, "Denied")) return yield* Effect.fail(result);
    return build;
  });

  const inspect = Effect.fn("DocumentBuild.inspect")(function* (
    workflowId: WorkflowId,
    userId: UserId,
  ) {
    const build = yield* ports.persistence.inspect(workflowId);
    if (build === null || build.userId !== userId) return yield* new NotFound({ workflowId });
    return yield* authorizeControl(build, "workflow.inspect");
  });

  const authorizeContinuation = Effect.fn("DocumentBuild.authorizeContinuation")(function* (
    build: Record,
    context: AuthorizationContext,
  ) {
    const result = authorization.recheck(
      {
        ...context,
        approval: null,
        subscription: { ...context.subscription, planPolicyVersion: build.planPolicyVersion },
      },
      { actionId: build.actionId, kind: "workflow.cancel" },
    );
    if (Predicate.isTagged(result, "Denied")) return yield* Effect.fail(result);
  });

  const revalidateFiles = Effect.fn("DocumentBuild.revalidateFiles")(function* (build: Record) {
    const files = yield* ports.files.resolve(
      build.agentId,
      build.userId,
      build.request.fileSnapshots.map(({ fileId }) => fileId),
    );
    const rebuilt = yield* storedRequestFor(build.request.format, files);
    if (!(yield* sameStoredRequest(build.request, rebuilt))) {
      return yield* new Conflict({
        message: "The owned Document Build source changed after admission",
        workflowId: build.workflowId,
      });
    }
  });

  const accept = Effect.fn("DocumentBuild.accept")(function* (build: Record) {
    if (build.state !== "admitted") {
      if (build.acceptedAt !== null) yield* ports.recordWorkflowStart(build);
      return build;
    }
    const payload = WorkflowPayload.make({
      inputDigest: build.inputDigest,
      workflowId: build.workflowId,
    });
    yield* ports.workflow.create(
      build.cloudflareInstanceId,
      build.cloudflareTimerInstanceId,
      payload,
    );
    const acceptedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const accepted = yield* ports.persistence.markAccepted(
      build.workflowId,
      build.inputDigest,
      acceptedAt,
    );
    yield* ports.recordWorkflowStart(accepted);
    return accepted;
  });

  const reconcileAcceptance = Effect.fn("DocumentBuild.reconcileAcceptance")(function* (
    workflowId: WorkflowId,
    inputDigest: InputDigest,
  ) {
    const build = yield* ports.persistence.inspect(workflowId);
    if (build === null) return yield* new NotFound({ workflowId });
    if (build.inputDigest !== inputDigest) {
      return yield* new Conflict({
        message: "The Workflow identity names changed input",
        workflowId,
      });
    }
    const current = yield* ports.currentAuthorization(build);
    yield* authorizeContinuation(build, current);
    yield* revalidateFiles(build);
    return yield* accept(build);
  });

  const authorizeExecution = Effect.fn("DocumentBuild.authorizeExecution")(function* (
    payload: WorkflowPayload,
  ) {
    const build = yield* ports.persistence.inspect(payload.workflowId);
    if (build === null) return yield* new NotFound({ workflowId: payload.workflowId });
    const identities = yield* cloudflareInstanceIdsFor(payload.workflowId);
    if (
      build.inputDigest !== payload.inputDigest ||
      build.cloudflareInstanceId !== identities.main ||
      build.cloudflareTimerInstanceId !== identities.timer
    ) {
      return yield* new Conflict({
        message: "Cloudflare execution does not match the admitted Document Build",
        workflowId: payload.workflowId,
      });
    }
    if (build.state === "cancel_requested") {
      const terminalAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
      yield* ports.persistence.finishTerminal(
        build.workflowId,
        build.inputDigest,
        "canceled",
        "cancel-requested",
        terminalAt,
      );
      return yield* new Conflict({
        message: "The Document Build was canceled before further execution",
        workflowId: build.workflowId,
      });
    }
    if (terminalStates.has(build.state)) {
      return yield* new Conflict({
        message: "The Document Build is no longer executable",
        workflowId: build.workflowId,
      });
    }
    const current = yield* ports.currentAuthorization(build);
    const deadlineChecked = yield* ports.persistence.enforceDeadline(
      build.workflowId,
      build.inputDigest,
      current.now,
    );
    if (deadlineChecked.state === "canceled") {
      return yield* new Conflict({
        message: "The Document Build deadline ended execution",
        workflowId: build.workflowId,
      });
    }
    if (deadlineChecked.state !== "publication_committed") {
      yield* authorizeContinuation(deadlineChecked, current).pipe(
        Effect.catch((denied) =>
          ports.persistence
            .finishTerminal(
              build.workflowId,
              build.inputDigest,
              "canceled",
              "authority-ended",
              current.now,
            )
            .pipe(Effect.andThen(Effect.fail(denied))),
        ),
      );
      yield* revalidateFiles(deadlineChecked).pipe(
        Effect.catch((failure) =>
          ports.persistence
            .finishTerminal(
              build.workflowId,
              build.inputDigest,
              "canceled",
              "source-changed",
              current.now,
            )
            .pipe(Effect.andThen(Effect.fail(failure))),
        ),
      );
    }
    return deadlineChecked;
  });

  const inspectExecution = Effect.fn("DocumentBuild.inspectExecution")(function* (
    payload: WorkflowPayload,
  ) {
    const build = yield* ports.persistence.inspect(payload.workflowId);
    if (build === null) return yield* new NotFound({ workflowId: payload.workflowId });
    const identities = yield* cloudflareInstanceIdsFor(payload.workflowId);
    if (
      build.inputDigest !== payload.inputDigest ||
      build.cloudflareInstanceId !== identities.main ||
      build.cloudflareTimerInstanceId !== identities.timer
    ) {
      return yield* new Conflict({
        message: "Cloudflare inspection does not match the admitted Document Build",
        workflowId: payload.workflowId,
      });
    }
    return build;
  });

  const beginExecution = Effect.fn("DocumentBuild.beginExecution")(function* (
    payload: WorkflowPayload,
  ) {
    const build = yield* authorizeExecution(payload);
    if (["running", "preview_stored", "publication_committed"].includes(build.state)) return build;
    if (build.state !== "admitted" && build.state !== "accepted") {
      return yield* new Conflict({
        message: "The Document Build cannot start from its current state",
        workflowId: build.workflowId,
      });
    }
    const startedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.beginExecution(build.workflowId, build.inputDigest, startedAt);
  });

  const artifactAuthorization = Effect.fn("DocumentBuild.artifactAuthorization")(function* (
    payload: WorkflowPayload,
    requestVendorUsdMicros: bigint,
  ) {
    const build = yield* authorizeExecution(payload);
    const current = yield* ports.currentAuthorization(build);
    yield* authorizeContinuation(build, current);
    const authorizationContext: AuthorizationContext = {
      ...current,
      approval: null,
      authority: {
        _tag: "DurableTrigger",
        triggerId: build.workflowId,
        triggerType: "workflow",
        userId: build.userId,
      },
      originatingAuthority: {
        _tag: "DurableTrigger",
        triggerId: build.workflowId,
        triggerType: "workflow",
      },
      requestVendorUsdMicros,
      resourceOwnerUserId: build.userId,
      subscription: { ...current.subscription, planPolicyVersion: build.planPolicyVersion },
    };
    return {
      authorization: authorizationContext,
      build,
    };
  });

  const markPreviewStored = Effect.fn("DocumentBuild.markPreviewStored")(function* (
    payload: WorkflowPayload,
    contentId: string,
  ) {
    const build = yield* authorizeExecution(payload);
    const storedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const preview = yield* ports.persistence.markPreviewStored(
      build.workflowId,
      build.inputDigest,
      contentId,
      storedAt,
    );
    yield* ports.commitPreviewReadyFollowUp(preview);
    return preview;
  });

  const commitAccounting = Effect.fn("DocumentBuild.commitAccounting")(function* (
    payload: WorkflowPayload,
    contentId: string,
    cost: CostEvidence,
  ) {
    const build = yield* authorizeExecution(payload);
    const committedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.markAccountingCommitted(
      build.workflowId,
      build.inputDigest,
      contentId,
      cost,
      committedAt,
    );
  });

  const commitPublication = Effect.fn("DocumentBuild.commitPublication")(function* (
    payload: WorkflowPayload,
    contentId: string,
  ) {
    const build = yield* authorizeExecution(payload);
    const committedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    return yield* ports.persistence.commitPublication(
      build.workflowId,
      build.inputDigest,
      contentId,
      committedAt,
    );
  });

  const finishSuccess = Effect.fn("DocumentBuild.finishSuccess")(function* (
    payload: WorkflowPayload,
    contentId: string,
  ) {
    const accountedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const finished = yield* ports.persistence.finishSuccess(
      payload.workflowId,
      payload.inputDigest,
      contentId,
      accountedAt,
    );
    yield* ports.commitTerminalFollowUp(finished);
    return finished;
  });

  const finishTerminal = (payload: WorkflowPayload, state: "canceled" | "failure", code: string) =>
    DateTime.now.pipe(
      Effect.map(DateTime.toDateUtc),
      Effect.flatMap((terminalAt) =>
        ports.persistence.finishTerminal(
          payload.workflowId,
          payload.inputDigest,
          state,
          code,
          terminalAt,
        ),
      ),
      Effect.tap((build) => ports.discardPendingArtifact(build)),
      Effect.tap((build) => ports.commitTerminalFollowUp(build)),
    );

  const start = Effect.fn("DocumentBuild.start")(function* (input: StartInput) {
    const workflowId = yield* workflowIdFor(input.authorization.user.userId, input.actionId);
    const identities = yield* cloudflareInstanceIdsFor(workflowId);
    const files = yield* ports.files.resolve(
      input.agentId,
      input.authorization.user.userId,
      input.request.fileIds,
    );
    const request = yield* storedRequestFor(input.request.format, files);
    const inputDigest = yield* digestRequest(input.authorization.user.userId, request);
    const existing = yield* ports.persistence.inspect(workflowId);
    if (existing !== null) {
      if (
        existing.userId !== input.authorization.user.userId ||
        existing.inputDigest !== inputDigest
      ) {
        return yield* new Conflict({
          message: "The Workflow identity was replayed with changed input",
          workflowId,
        });
      }
      yield* authorizeContinuation(existing, input.authorization);
      const accepted = yield* accept(existing).pipe(
        Effect.catchIf(isWorkflowAcknowledgementFailure, () => Effect.succeed(null)),
      );
      return accepted === null
        ? { _tag: "AcceptancePending" as const, build: existing }
        : { _tag: "Replayed" as const, build: accepted };
    }
    const initialAdmission = authorization.admit(
      input.authorization,
      workflowOperation(input.actionId),
    );
    const freeParityAdmission =
      input.authorization.subscription.plan === "free" &&
      Predicate.isTagged(initialAdmission, "Denied") &&
      (initialAdmission.reason === "missingEntitlement" ||
        initialAdmission.reason === "allowanceExhausted");
    const admission = freeParityAdmission
      ? supersedingFreeDocumentBuildAdmission(authorization, input.authorization, input.actionId)
      : initialAdmission;
    if (!Predicate.isTagged(admission, "Admitted")) {
      return yield* Effect.fail(
        Predicate.isTagged(admission, "Denied")
          ? admission
          : ({ _tag: "Denied", reason: "approvalRequired", resetAt: null } satisfies Denied),
      );
    }
    if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
      return yield* Effect.fail({
        _tag: "Denied",
        reason: "allowancePeriodUnavailable",
        resetAt: null,
      } satisfies Denied);
    }
    const admittedPolicy = yield* policyForVersion(
      retainedCatalog,
      input.authorization.subscription.planPolicyVersion,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({
            cause,
            message: "The admitted Plan policy is unavailable",
            operation: "start.planPolicy",
          }),
      ),
    );
    const modelAccessPolicy = isLaunchPolicy(admittedPolicy)
      ? launchModelAccessPolicy
      : sharedUsageModelAccessPolicy;
    const route = yield* selectManagedRoute(
      modelAccessPolicy,
      input.authorization.subscription.plan,
      input.authorization.subscription.planPolicyVersion,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({
            cause,
            message: "The admitted Plan has no retained model route",
            operation: "start.selectRoute",
          }),
      ),
    );
    const build: Record = {
      workflowId,
      actionId: input.actionId,
      userId: input.authorization.user.userId,
      agentId: input.agentId,
      routeId: input.routeId,
      sessionId: input.sessionId,
      originatingAuthority: input.authorization.originatingAuthority,
      inputDigest,
      request,
      state: "admitted",
      allowancePeriodId: admission.allowancePeriod.allowancePeriodId,
      planPolicyVersion: input.authorization.subscription.planPolicyVersion,
      capabilityCatalogVersion: admission.capabilityCatalogVersion,
      modelAccessPolicyVersion: ModelAccessPolicyVersion.make(modelAccessPolicy.planPolicyVersion),
      modelRoute: route.route,
      resourcePriceVersion: currentResourcePriceVersion,
      manifestVersion: admission.manifestVersion,
      cloudflareInstanceId: identities.main,
      cloudflareTimerInstanceId: identities.timer,
      artifactContentId: null,
      costEvidence: null,
      safeFailureCode: null,
      admittedAt: input.authorization.now,
      deadlineAt: deadlineAfter(input.authorization.now),
      acceptedAt: null,
      startedAt: null,
      previewStoredAt: null,
      accountingCommittedAt: null,
      publicationCommittedAt: null,
      artifactAccountedAt: null,
      cancelRequestedAt: null,
      terminalAt: null,
    };
    const activeWorkflowLimit = freeParityAdmission
      ? BigInt(
          currentCapabilityCatalog.planResourceLimits[input.authorization.subscription.plan]
            .activeWorkflows,
        )
      : isLaunchPolicy(admittedPolicy)
        ? policyFor(admittedPolicy, input.authorization.subscription.plan).liveLimits
            .concurrentWorkflows
        : BigInt(
            currentCapabilityCatalog.planResourceLimits[input.authorization.subscription.plan]
              .activeWorkflows,
          );
    const persisted = yield* ports.persistence.admit(build, activeWorkflowLimit);
    if (
      persisted.build.inputDigest !== build.inputDigest ||
      persisted.build.userId !== build.userId
    ) {
      return yield* new Conflict({
        message: "Concurrent admission retained different immutable facts",
        workflowId,
      });
    }
    const accepted = yield* accept(persisted.build).pipe(
      Effect.catchIf(isWorkflowAcknowledgementFailure, () => Effect.succeed(null)),
    );
    if (accepted === null) return { _tag: "AcceptancePending" as const, build: persisted.build };
    return {
      _tag: persisted._tag === "Created" ? ("Started" as const) : ("Replayed" as const),
      build: accepted,
    };
  });

  const cancel = Effect.fn("DocumentBuild.cancel")(function* (
    workflowId: WorkflowId,
    userId: UserId,
  ) {
    const retained = yield* ports.persistence.inspect(workflowId);
    if (retained === null || retained.userId !== userId) return yield* new NotFound({ workflowId });
    yield* authorizeControl(retained, "workflow.cancel");
    const requestedAt = yield* DateTime.now.pipe(Effect.map(DateTime.toDateUtc));
    const requested = yield* ports.persistence.requestCancel(workflowId, userId, requestedAt);
    if (terminalStates.has(requested.state)) return { _tag: "Terminal" as const, build: requested };
    if (requested.state === "publication_committed")
      return { _tag: "PublicationCommitted" as const, build: requested };
    const canceled = yield* ports.persistence.finishTerminal(
      requested.workflowId,
      requested.inputDigest,
      "canceled",
      "cancel-requested",
      requestedAt,
    );
    yield* ports
      .discardPendingArtifact(canceled)
      .pipe(
        Effect.andThen(ports.commitTerminalFollowUp(canceled)),
        Effect.ensuring(
          ports.workflow
            .terminate(canceled.cloudflareInstanceId, canceled.cloudflareTimerInstanceId)
            .pipe(Effect.ignore),
        ),
      );
    return { _tag: "CancelRequested" as const, build: canceled };
  });

  const resumePublication = Effect.fn("DocumentBuild.resumePublication")(function* (
    payload: WorkflowPayload,
  ) {
    const build = yield* ports.persistence.inspect(payload.workflowId);
    if (build === null) return yield* new NotFound({ workflowId: payload.workflowId });
    if (build.inputDigest !== payload.inputDigest)
      return yield* new Conflict({
        message: "Publication recovery named changed input",
        workflowId: build.workflowId,
      });
    if (
      build.state !== "preview_stored" &&
      build.state !== "publication_committed" &&
      build.state !== "success"
    ) {
      return yield* new Conflict({
        message: "Only a retained preview can enter publication recovery",
        workflowId: build.workflowId,
      });
    }
    return build;
  });

  return Service.of({
    artifactAuthorization,
    authorizeExecution,
    beginExecution,
    cancel,
    commitAccounting,
    commitPublication,
    finishCanceled: (payload, code) => finishTerminal(payload, "canceled", code),
    finishFailure: (payload, code) => finishTerminal(payload, "failure", code),
    finishSuccess,
    inspect,
    inspectExecution,
    markPreviewStored,
    reconcileAcceptance,
    resumePublication,
    start,
  });
});

export const layerWithoutDependencies = Layer.effect(Service, make);

export const storedRequestFor = (
  format: DocumentArtifact.DocumentFormat,
  files: ReadonlyArray<ResolvedFile>,
): Effect.Effect<StoredRequest, Unavailable> =>
  Effect.gen(function* () {
    const pages = files.flatMap(({ fileName, normalizedText }) =>
      paginate(fileName, wrap(normalizedText)),
    );
    const source = yield* Schema.decodeEffect(DocumentSource)({
      pages,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new Unavailable({
            cause,
            message: "The supplied files exceed the bounded DocumentSource contract",
            operation: "files.combineSource",
          }),
      ),
    );
    return StoredRequest.make({
      fileSnapshots: files.map(({ byteLength, fileId, mediaType, sha256 }) => ({
        byteLength,
        fileId,
        mediaType,
        sha256,
      })),
      format,
      source,
    });
  });

const paginate = (title: string, lines: ReadonlyArray<string>) => {
  const pageCount = Math.max(1, Math.ceil(lines.length / 30));
  return Array.from({ length: pageCount }, (_, index) => ({
    lines: lines.slice(index * 30, (index + 1) * 30),
    title: truncate(pageCount === 1 ? title : `${title} (${index + 1}/${pageCount})`, 80),
  }));
};

const wrap = (value: string) =>
  value
    .replaceAll(/\s+/gu, " ")
    .trim()
    .split(" ")
    .flatMap((word) =>
      Array.from({ length: Math.ceil(word.length / 80) }, (_, index) =>
        word.slice(index * 80, (index + 1) * 80),
      ),
    )
    .reduce<ReadonlyArray<string>>((lines, word) => {
      const previous = lines.at(-1);
      if (previous === undefined || previous.length + word.length + 1 > 80) {
        return lines.concat(word);
      }
      return lines.slice(0, -1).concat(`${previous} ${word}`);
    }, []);

const truncate = (value: string, maximum: number) => value.trim().slice(0, maximum) || "Document";

const sameStoredRequest = (left: StoredRequest, right: StoredRequest) =>
  Effect.all([encodeStoredRequest(left), encodeStoredRequest(right)]).pipe(
    Effect.map(([leftEncoded, rightEncoded]) => leftEncoded === rightEncoded),
  );

const encodeStoredRequest = (request: StoredRequest) =>
  Schema.encodeEffect(Schema.fromJsonString(StoredRequest))(request).pipe(Effect.orDie);

const digestRequest = (userId: UserId, request: StoredRequest) =>
  Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ request: StoredRequest, userId: UserId })),
  )({ request, userId }).pipe(Effect.orDie, Effect.flatMap(digest));

const workflowIdFor = (userId: UserId, actionId: ActionId) =>
  digest(`${userId}\0${actionId}`).pipe(
    Effect.map((value) => WorkflowId.make(`document-build:${value}`)),
  );

export const cloudflareInstanceIdsFor = (workflowId: WorkflowId) =>
  digest(workflowId).pipe(
    Effect.map((value) => ({
      main: CloudflareInstanceId.make(`document-build-${value}`),
      timer: CloudflareInstanceId.make(`document-build-${value}-timer`),
    })),
  );

const deadlineAfter = (admittedAt: Date) =>
  DateTime.toDateUtc(
    DateTime.add(DateTime.makeUnsafe(admittedAt), {
      milliseconds: currentCapabilityCatalog.operationLimits.durableArtifactOperationMilliseconds,
    }),
  );

export const workflowOperation = (actionId: ActionId) => ({
  actionId,
  change: "start" as const,
  consequences: [],
  kind: "workflow.manage" as const,
});

/**
 * #252 supersedes launch-v1's Free capability gate for new Document Builds without
 * activating shared-usage-v1. Keep the real period and Usage facts intact, recheck
 * all current authority/ownership/deletion gates, and use catalog hard capacity.
 */
const supersedingFreeDocumentBuildAdmission = (
  authorization: Authorization.Interface,
  context: AuthorizationContext,
  actionId: ActionId,
) => {
  const control = authorization.recheck(context, { actionId, kind: "workflow.inspect" });
  if (Predicate.isTagged(control, "Denied")) return control;
  if (!Predicate.isTagged(context.allowance, "Metered")) {
    return { _tag: "Denied", reason: "allowancePeriodUnavailable", resetAt: null } as const;
  }
  return {
    _tag: "Admitted",
    allowancePeriod: {
      _tag: "Metered",
      allowancePeriodId: context.allowance.allowancePeriodId,
      grantSource: null,
    },
    capabilityCatalogVersion: currentCapabilityCatalog.version,
    executionMode: "normalPlanUsage",
    manifestVersion: null,
  } as const;
};

const isWorkflowAcknowledgementFailure = (failure: Conflict | NotFound | Unavailable) =>
  Predicate.isTagged(failure, "DocumentBuildUnavailable") &&
  (failure.operation === "workflow.create" || failure.operation === "workflow.reconcileCreate");

const digest = (value: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).pipe(
    Effect.map((bytes) =>
      InputDigest.make(
        Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

export * as DocumentBuild from "./document-build";
