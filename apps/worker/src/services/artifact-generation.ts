import { Effect, Predicate, Schema } from "effect";

import { AllowancePeriodId, type UserId } from "../domain";
import type { ActionId } from "../domain/action-execution";
import { ContentId } from "../domain/client-content";
import type {
  AllowanceItem,
  AllowancePeriodNotFound,
  AllowanceSource,
  BillingTransactionRetryExhausted,
  DatabaseUnavailable,
  ExistingUsage,
  Recorded,
  UsageConflict,
} from "../domain/allowance";
import { DocumentArtifact } from "../domain/document-artifact";
import type { PlanPolicyNotFound } from "../domain/plan-policy";
import type { AuthorizationContext, Denied, Interface as Authorization } from "./authorization";

/* oxlint-disable eslint/no-underscore-dangle -- Domain outcomes use the _tag discriminator. */

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
const optionalText = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const singleLineText = (maximum: number) =>
  Schema.String.check(Schema.isMaxLength(maximum), Schema.isPattern(/^[^\r\n]*$/u));

export const PresentationSlide = Schema.Struct({
  body: Schema.Array(singleLineText(160)).check(Schema.isMaxLength(12)),
  diagramContentId: Schema.NullOr(ContentId),
  imageContentId: Schema.NullOr(ContentId),
  sourceNotes: Schema.Array(boundedText(500)).check(Schema.isMaxLength(10)),
  speakerNotes: optionalText(4_000),
  title: boundedText(100).check(Schema.isPattern(/^[^\r\n]+$/u)),
});
export type PresentationSlide = typeof PresentationSlide.Type;

export const PresentationSource = Schema.Struct({
  audience: boundedText(500),
  purpose: boundedText(500),
  slides: Schema.Array(PresentationSlide).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DocumentArtifact.maximumPresentationSlides),
  ),
  title: boundedText(120),
});
export type PresentationSource = typeof PresentationSource.Type;

export const ImageSource = Schema.Struct({
  altText: boundedText(500),
  height: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(DocumentArtifact.maximumImagePixelsPerEdge),
  ),
  prompt: boundedText(4_000),
  width: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(DocumentArtifact.maximumImagePixelsPerEdge),
  ),
});
export type ImageSource = typeof ImageSource.Type;

const DiagramNodeId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u),
);
export const DiagramSource = Schema.Struct({
  direction: Schema.Literals(["leftToRight", "topToBottom"]),
  edges: Schema.Array(
    Schema.Struct({ from: DiagramNodeId, label: optionalText(60), to: DiagramNodeId }),
  ).check(Schema.isMaxLength(40)),
  height: ImageSource.fields.height,
  nodes: Schema.Array(Schema.Struct({ id: DiagramNodeId, label: boundedText(80) })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  title: boundedText(120),
  width: ImageSource.fields.width,
}).check(
  Schema.makeFilter((source) => {
    const nodeIds = new Set(source.nodes.map(({ id }) => id));
    return (
      (nodeIds.size === source.nodes.length &&
        source.edges.every(({ from, to }) => nodeIds.has(from) && nodeIds.has(to))) ||
      "diagram edges must reference unique declared nodes"
    );
  }),
);
export type DiagramSource = typeof DiagramSource.Type;

export const ArtifactIntent = Schema.TaggedUnion({
  Diagram: { source: DiagramSource },
  Image: { source: ImageSource },
  Presentation: { source: PresentationSource },
});
export type ArtifactIntent = typeof ArtifactIntent.Type;

export const ArtifactIntentDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("ArtifactIntentDigest"),
);
export type ArtifactIntentDigest = typeof ArtifactIntentDigest.Type;

export const CostEvidence = Schema.Union([
  Schema.TaggedStruct("ProvenNoUse", {}),
  Schema.TaggedStruct("Incurred", {
    allowancePeriodId: AllowancePeriodId,
    basis: Schema.Literals(["conservative", "observed"]),
    providerOperationId: Schema.String.check(Schema.isMinLength(1)),
    usdMicros: Schema.BigIntFromString,
  }),
]);
export type CostEvidence = typeof CostEvidence.Type;

export type ArtifactInspection =
  | {
      readonly _tag: "Presentation";
      readonly issues: ReadonlyArray<string>;
      readonly renderedSlideCount: number;
    }
  | { readonly _tag: "Visual"; readonly height: number; readonly width: number };

export type ComputeResult =
  | {
      readonly _tag: "Completed";
      readonly bytes: Uint8Array;
      readonly cost: CostEvidence;
      readonly inspection: ArtifactInspection;
    }
  | { readonly _tag: "Interrupted"; readonly cost: CostEvidence; readonly evidence: string }
  | { readonly _tag: "AttemptPending"; readonly cost: CostEvidence; readonly evidence: string }
  | { readonly _tag: "IntentConflict"; readonly cost: CostEvidence }
  | { readonly _tag: "RejectedOversize"; readonly cost: CostEvidence; readonly size: number };

export interface ComputeRecovery {
  readonly cost: Extract<CostEvidence, { readonly _tag: "Incurred" }>;
  readonly intentDigest: ArtifactIntentDigest;
}

export interface GenerateRequest {
  readonly actionId: ActionId;
  readonly authorization: AuthorizationContext;
  readonly intent: ArtifactIntent;
  readonly owner: DocumentArtifact.DocumentOwner;
}

export interface ReviseRequest extends GenerateRequest {
  readonly intent: Extract<ArtifactIntent, { readonly _tag: "Presentation" }>;
  readonly sourceContentId: ContentId;
}

export interface ArtifactRequest {
  readonly actionId: ActionId;
  readonly authorization: AuthorizationContext;
  readonly contentId: ContentId;
}

export interface StoredArtifactMetadata {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly artifact: DocumentArtifact.ArtifactRef;
  readonly cost: CostEvidence;
  readonly intentDigest: ArtifactIntentDigest;
  readonly intentTag: ArtifactIntent["_tag"];
  readonly owner: DocumentArtifact.DocumentOwner;
  readonly retention: "accounted" | "pending";
  readonly userId: UserId;
}

export interface StoredArtifact extends StoredArtifactMetadata {
  readonly bytes: Uint8Array;
}

export class ArtifactStoreUnavailable extends Schema.TaggedError<ArtifactStoreUnavailable>()(
  "ArtifactStoreUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["account", "delete", "inspect", "put", "readBytes"]),
  },
) {}

export class ArtifactIntegrityFailure extends Schema.TaggedError<ArtifactIntegrityFailure>()(
  "ArtifactIntegrityFailure",
  { contentId: ContentId, message: Schema.String },
) {}

export class ArtifactIntentConflict extends Schema.TaggedError<ArtifactIntentConflict>()(
  "ArtifactIntentConflict",
  { contentId: ContentId, message: Schema.String },
) {}

export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()("ArtifactNotFound", {
  contentId: ContentId,
  message: Schema.String,
}) {}

export class ArtifactComputeInterrupted extends Schema.TaggedError<ArtifactComputeInterrupted>()(
  "ArtifactComputeInterrupted",
  { contentId: ContentId, evidence: Schema.String, message: Schema.String },
) {}

export class ArtifactCostLimitExceeded extends Schema.TaggedError<ArtifactCostLimitExceeded>()(
  "ArtifactCostLimitExceeded",
  {
    admittedUsdMicros: Schema.BigInt,
    contentId: ContentId,
    incurredUsdMicros: Schema.BigInt,
    message: Schema.String,
  },
) {}

export class ArtifactCleanupUnavailable extends Schema.TaggedError<ArtifactCleanupUnavailable>()(
  "ArtifactCleanupUnavailable",
  { cause: Schema.Defect(), contentId: ContentId, message: Schema.String },
) {}

export class ArtifactAuthorizationUnavailable extends Schema.TaggedError<ArtifactAuthorizationUnavailable>()(
  "ArtifactAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

export interface ArtifactStore {
  readonly account: (
    contentId: ContentId,
  ) => Effect.Effect<void, ArtifactIntegrityFailure | ArtifactStoreUnavailable>;
  readonly delete: (
    metadata: StoredArtifactMetadata,
  ) => Effect.Effect<void, ArtifactStoreUnavailable>;
  readonly inspect: (
    contentId: ContentId,
  ) => Effect.Effect<
    StoredArtifactMetadata | null,
    ArtifactIntegrityFailure | ArtifactStoreUnavailable
  >;
  readonly put: (
    artifact: StoredArtifact,
  ) => Effect.Effect<
    void,
    ArtifactIntegrityFailure | ArtifactStoreUnavailable | ArtifactIntentConflict
  >;
  readonly readBytes: (
    metadata: StoredArtifactMetadata,
  ) => Effect.Effect<Uint8Array, ArtifactIntegrityFailure | ArtifactStoreUnavailable>;
}

export interface ArtifactValidator {
  readonly validate: (
    contentId: ContentId,
    intent: ArtifactIntent,
    bytes: Uint8Array,
    inspection: ArtifactInspection,
    sourceContentId: ContentId | null,
  ) => Effect.Effect<DocumentArtifact.ArtifactRef, DocumentArtifact.InvalidGeneratedArtifact>;
}

export interface DisposableCompute {
  readonly dispose: (contentId: ContentId) => Effect.Effect<void, ArtifactCleanupUnavailable>;
  readonly generate: (input: {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly computeMilliseconds: number;
    readonly contentId: ContentId;
    readonly intent: ArtifactIntent;
    readonly intentDigest: ArtifactIntentDigest;
    readonly sourceArtifact: Uint8Array | null;
    readonly supportingVisuals: ReadonlyArray<{
      readonly bytes: Uint8Array;
      readonly contentId: ContentId;
    }>;
    readonly userId: UserId;
  }) => Effect.Effect<ComputeResult>;
  readonly inspect: (
    contentId: ContentId,
    intentDigest: ArtifactIntentDigest,
  ) => Effect.Effect<ComputeRecovery | null, ArtifactComputeInterrupted | ArtifactIntentConflict>;
}

type AllowanceFailure =
  | AllowancePeriodNotFound
  | BillingTransactionRetryExhausted
  | DatabaseUnavailable
  | PlanPolicyNotFound
  | UsageConflict;

export interface Allowances {
  readonly record: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<ExistingUsage | Recorded, AllowanceFailure>;
}

export interface MakeOptions {
  readonly allowances: Allowances;
  readonly artifacts: ArtifactStore;
  readonly authorization: Authorization;
  readonly compute: DisposableCompute;
  readonly currentAuthorization: (
    admitted: AuthorizationContext,
  ) => Effect.Effect<AuthorizationContext, ArtifactAuthorizationUnavailable>;
  readonly executionLimits: (request: GenerateRequest) => {
    readonly computeMilliseconds: number;
    readonly maximumOutputBytes: bigint;
    readonly modelSteps: bigint;
  };
  readonly validator: ArtifactValidator;
}

type ArtifactFailure =
  | AllowanceFailure
  | ArtifactAuthorizationUnavailable
  | ArtifactCleanupUnavailable
  | ArtifactComputeInterrupted
  | ArtifactCostLimitExceeded
  | ArtifactIntegrityFailure
  | ArtifactIntentConflict
  | ArtifactNotFound
  | ArtifactStoreUnavailable
  | Denied
  | DocumentArtifact.InvalidGeneratedArtifact;

export interface Interface {
  readonly delete: (request: ArtifactRequest) => Effect.Effect<void, ArtifactFailure>;
  readonly export: (
    request: ArtifactRequest,
  ) => Effect.Effect<
    { readonly artifact: DocumentArtifact.ArtifactRef; readonly bytes: Uint8Array },
    ArtifactFailure
  >;
  readonly generate: (
    request: GenerateRequest,
  ) => Effect.Effect<DocumentArtifact.ArtifactRef, ArtifactFailure>;
  readonly reference: (
    request: ArtifactRequest,
  ) => Effect.Effect<DocumentArtifact.ArtifactRef, ArtifactFailure>;
  readonly revise: (
    request: ReviseRequest,
  ) => Effect.Effect<DocumentArtifact.ArtifactRef, ArtifactFailure>;
}

export const make = (options: MakeOptions): Interface => {
  const write = Effect.fn("ArtifactGeneration.write")(function* (
    request: GenerateRequest,
    sourceContentId: ContentId | null,
  ) {
    const contentId = contentIdFor(request.owner);
    const userId = request.authorization.user.userId;
    if (!ownerMatchesRequest(request)) return yield* denied("ownershipRequired");

    const intentDigest = yield* digestIntent(request.intent, sourceContentId);
    const executionLimits = options.executionLimits(request);
    const operation = operationFor(
      request,
      sourceContentId === null ? "artifact.generate" : "artifact.revise",
      executionLimits,
    );
    const authorizeWrite = Effect.gen(function* () {
      const current = yield* options.currentAuthorization(request.authorization);
      const permitted = options.authorization.recheck(current, operation);
      if (Predicate.isTagged(permitted, "Denied")) return yield* Effect.fail(permitted);
      return undefined;
    });

    const existing = yield* options.artifacts.inspect(contentId);
    if (existing !== null) {
      if (
        existing.userId !== userId ||
        existing.intentDigest !== intentDigest ||
        existing.intentTag !== request.intent._tag ||
        !DocumentArtifact.sameOwner(existing.owner, request.owner) ||
        existing.artifact.lineage.sourceContentId !== sourceContentId
      ) {
        return yield* new ArtifactIntentConflict({
          contentId,
          message: "The owning identity already names a different artifact intent",
        });
      }
      yield* recordCost(options.allowances, existing.cost);
      yield* authorizeWrite;
      yield* options.artifacts.account(contentId);
      yield* options.compute.dispose(contentId);
      return existing.artifact;
    }

    const recovery = yield* options.compute.inspect(contentId, intentDigest);
    const allowancePeriodId = yield* recovery === null
      ? admit(options.authorization, request.authorization, operation)
      : Effect.succeed(recovery.cost.allowancePeriodId);
    yield* authorizeWrite;
    // Immutable replay above needs only the retained result. Resolve source and
    // supporting artifacts only when this invocation will enter compute.
    const source = yield* sourceContentId === null
      ? Effect.succeed(null)
      : readOwnedPresentation(options, request.authorization, sourceContentId);
    const supportingVisuals = yield* readSupportingVisuals(
      options,
      request.authorization,
      request.intent,
    );

    let cleanupRequired = true;
    return yield* Effect.gen(function* () {
      const computed = yield* options.compute.generate({
        allowancePeriodId,
        computeMilliseconds: executionLimits.computeMilliseconds,
        contentId,
        intent: request.intent,
        intentDigest,
        sourceArtifact: source?.bytes ?? null,
        supportingVisuals,
        userId,
      });
      if (Predicate.isTagged(computed, "AttemptPending")) {
        cleanupRequired = false;
        return yield* new ArtifactComputeInterrupted({
          contentId,
          evidence: computed.evidence,
          message: "Another caller owns disposable artifact compute",
        });
      }
      if (Predicate.isTagged(computed, "IntentConflict")) {
        return yield* new ArtifactIntentConflict({
          contentId,
          message: "The owning identity already names a different artifact attempt",
        });
      }
      if (Predicate.isTagged(computed, "Interrupted")) {
        yield* recordCost(options.allowances, computed.cost);
        return yield* new ArtifactComputeInterrupted({
          contentId,
          evidence: computed.evidence,
          message: "Disposable artifact compute was interrupted",
        });
      }
      if (Predicate.isTagged(computed, "RejectedOversize")) {
        yield* recordCost(options.allowances, computed.cost);
        return yield* DocumentArtifact.invalid(
          contentId,
          "byteLimit",
          "The generated artifact exceeds its byte limit",
        );
      }
      if (BigInt(computed.bytes.byteLength) > executionLimits.maximumOutputBytes) {
        yield* recordCost(options.allowances, computed.cost);
        return yield* DocumentArtifact.invalid(
          contentId,
          "byteLimit",
          "The generated artifact exceeds this Plan's byte limit",
        );
      }
      if (
        computed.cost._tag === "Incurred" &&
        computed.cost.usdMicros > request.authorization.requestVendorUsdMicros
      ) {
        yield* recordCost(options.allowances, computed.cost);
        return yield* new ArtifactCostLimitExceeded({
          admittedUsdMicros: request.authorization.requestVendorUsdMicros,
          contentId,
          incurredUsdMicros: computed.cost.usdMicros,
          message: "Artifact generation exceeded the admitted vendor-cost maximum",
        });
      }
      const artifact = yield* options.validator
        .validate(contentId, request.intent, computed.bytes, computed.inspection, sourceContentId)
        .pipe(Effect.tapError(() => recordCost(options.allowances, computed.cost)));
      const retained: StoredArtifact = {
        allowancePeriodId,
        artifact,
        bytes: computed.bytes,
        cost: computed.cost,
        intentDigest,
        intentTag: request.intent._tag,
        owner: request.owner,
        retention: "pending",
        userId,
      };
      yield* authorizeWrite;
      yield* options.artifacts.put(retained);
      yield* recordCost(options.allowances, computed.cost);
      yield* authorizeWrite;
      yield* options.artifacts.account(contentId);
      return artifact;
    }).pipe(
      Effect.onExit(() => (cleanupRequired ? options.compute.dispose(contentId) : Effect.void)),
    );
  });

  return {
    delete: (request) =>
      Effect.gen(function* () {
        const stored = yield* readAuthorized(options, request, "artifact.delete");
        yield* options.artifacts.delete(stored);
      }),
    export: (request) =>
      Effect.gen(function* () {
        const stored = yield* readAuthorized(options, request, "artifact.read");
        return { artifact: stored.artifact, bytes: yield* options.artifacts.readBytes(stored) };
      }),
    generate: (request) => write(request, null),
    reference: (request) =>
      Effect.map(readAuthorized(options, request, "artifact.read"), ({ artifact }) => artifact),
    revise: (request) => write(request, request.sourceContentId),
  };
};

const operationFor = (
  request: GenerateRequest,
  kind: "artifact.generate" | "artifact.revise",
  executionLimits: ReturnType<MakeOptions["executionLimits"]>,
) => {
  const artifactKind =
    request.intent._tag === "Presentation"
      ? ("pptx" as const)
      : request.intent._tag === "Image"
        ? ("image" as const)
        : ("diagram" as const);
  return {
    actionId: request.actionId,
    artifactKind,
    bytes: executionLimits.maximumOutputBytes,
    computeMilliseconds: BigInt(executionLimits.computeMilliseconds),
    kind,
    modelSteps: executionLimits.modelSteps,
    pages: 0n,
    pixelsPerEdge:
      request.intent._tag === "Presentation"
        ? 0n
        : BigInt(Math.max(request.intent.source.width, request.intent.source.height)),
    slides:
      request.intent._tag === "Presentation" ? BigInt(request.intent.source.slides.length) : 0n,
  } as const;
};

const admit = (
  authorization: Authorization,
  context: AuthorizationContext,
  operation: ReturnType<typeof operationFor>,
) => {
  const admission = authorization.admit(context, operation);
  if (!Predicate.isTagged(admission, "Admitted")) {
    return Predicate.isTagged(admission, "Denied")
      ? Effect.fail(admission)
      : denied("approvalRequired");
  }
  if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
    return denied("allowancePeriodUnavailable");
  }
  return Effect.succeed(admission.allowancePeriod.allowancePeriodId);
};

const denied = (reason: Denied["reason"]) =>
  Effect.fail({ _tag: "Denied", reason, resetAt: null } satisfies Denied);

const contentIdFor = (owner: DocumentArtifact.DocumentOwner): ContentId =>
  ContentId.make(
    Predicate.isTagged(owner, "ToolCall")
      ? `artifact:toolCall:${owner.toolCallId}`
      : `artifact:workflow:${owner.workflowId}`,
  );

const ownerMatchesRequest = (request: GenerateRequest) =>
  Predicate.isTagged(request.owner, "ToolCall")
    ? request.owner.toolCallId === request.actionId
    : Predicate.isTagged(request.authorization.authority, "DurableTrigger") &&
      request.authorization.authority.triggerType === "workflow" &&
      request.owner.workflowId === request.authorization.authority.triggerId;

const digestIntent = (intent: ArtifactIntent, sourceContentId: ContentId | null) =>
  Schema.encodeEffect(IntentEncoding)({ intent, sourceContentId }).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))),
    ),
    Effect.map((digest) =>
      ArtifactIntentDigest.make(
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

const IntentEncoding = Schema.fromJsonString(
  Schema.Struct({ intent: ArtifactIntent, sourceContentId: Schema.NullOr(ContentId) }),
);

const readOwnedPresentation = (
  options: MakeOptions,
  authorization: AuthorizationContext,
  contentId: ContentId,
) =>
  Effect.gen(function* () {
    const metadata = yield* options.artifacts.inspect(contentId);
    if (
      metadata === null ||
      metadata.userId !== authorization.user.userId ||
      metadata.artifact.artifactRole._tag !== "GeneratedPresentationV1"
    ) {
      return yield* new ArtifactNotFound({
        contentId,
        message: "The owned source presentation does not exist",
      });
    }
    return { bytes: yield* options.artifacts.readBytes(metadata), metadata };
  });

const readSupportingVisuals = (
  options: MakeOptions,
  authorization: AuthorizationContext,
  intent: ArtifactIntent,
) => {
  if (intent._tag !== "Presentation") return Effect.succeed([]);
  const ids = [
    ...new Set(
      intent.source.slides.flatMap(({ diagramContentId, imageContentId }) =>
        [diagramContentId, imageContentId].filter((id): id is ContentId => id !== null),
      ),
    ),
  ];
  return Effect.forEach(ids, (contentId) =>
    Effect.gen(function* () {
      const metadata = yield* options.artifacts.inspect(contentId);
      if (
        metadata === null ||
        metadata.userId !== authorization.user.userId ||
        (metadata.artifact.artifactRole._tag !== "GeneratedImageV1" &&
          metadata.artifact.artifactRole._tag !== "GeneratedDiagramV1")
      ) {
        return yield* new ArtifactNotFound({
          contentId,
          message: "A supporting visual is unavailable or not owned by the current User",
        });
      }
      return { bytes: yield* options.artifacts.readBytes(metadata), contentId };
    }),
  );
};

const readAuthorized = (
  options: MakeOptions,
  request: ArtifactRequest,
  kind: "artifact.read" | "artifact.delete",
) =>
  Effect.gen(function* () {
    const stored = yield* options.artifacts.inspect(request.contentId);
    if (stored === null) {
      return yield* new ArtifactNotFound({
        contentId: request.contentId,
        message: "The retained artifact does not exist",
      });
    }
    const authorization = {
      ...(yield* options.currentAuthorization(request.authorization)),
      requestVendorUsdMicros: 0n,
      resourceOwnerUserId: stored.userId,
    };
    const permitted = options.authorization.recheck(authorization, {
      actionId: request.actionId,
      kind,
    });
    if (Predicate.isTagged(permitted, "Denied")) return yield* Effect.fail(permitted);
    return stored;
  });

const recordCost = (allowances: Allowances, cost: CostEvidence) => {
  if (cost._tag === "ProvenNoUse") return Effect.void;
  return allowances.record(
    cost.allowancePeriodId,
    { sourceId: cost.providerOperationId, sourceType: "artifactProviderOperation" },
    [{ allowanceKind: "vendorUsdMicros", basis: cost.basis, quantity: cost.usdMicros }],
  );
};

export type { AllowanceItem, AllowanceSource } from "../domain/allowance";

export * as ArtifactGeneration from "./artifact-generation";
