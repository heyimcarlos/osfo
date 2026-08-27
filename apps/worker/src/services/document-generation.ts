import { Effect, Predicate, Schema } from "effect";

import type { AllowancePeriodId, UserId } from "../domain";
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

/** SHA-256 digest of the exact document intent owned by one Action. */
export const DocumentIntentDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)).pipe(
  Schema.brand("DocumentIntentDigest"),
);

/** SHA-256 digest of the exact document intent owned by one Action. */
export type DocumentIntentDigest = typeof DocumentIntentDigest.Type;

/** One bounded page supplied to disposable document compute. */
export const DocumentPage = Schema.Struct({
  lines: Schema.Array(Schema.String.check(Schema.isMaxLength(80))).check(Schema.isMaxLength(30)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  visualContentId: Schema.optionalKey(ContentId),
}).check(
  Schema.makeFilter(
    (page) =>
      page.visualContentId === undefined ||
      page.lines.length <= 16 ||
      "A document page with a visual may contain at most 16 lines",
  ),
);

/** One bounded page supplied to disposable document compute. */
export type DocumentPage = typeof DocumentPage.Type;

/** Parsed, explicitly paginated source for one generated document. */
export const DocumentSource = Schema.Struct({
  pages: Schema.Array(DocumentPage).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});

/** Parsed, explicitly paginated source for one generated document. */
export type DocumentSource = typeof DocumentSource.Type;

/** Provider cost evidence returned by disposable compute. */
export type CostEvidence =
  | { readonly _tag: "ProvenNoUse" }
  | {
      readonly _tag: "Incurred";
      readonly allowancePeriodId: AllowancePeriodId;
      readonly basis: "conservative" | "observed";
      readonly providerOperationId: string;
      readonly usdMicros: bigint;
    };

/** Closed result from one safely repeatable disposable compute attempt. */
export type ComputeResult =
  | {
      readonly _tag: "AuthorizationFailure";
      readonly cost: CostEvidence;
      readonly failure: Denied | DocumentAuthorizationUnavailable;
    }
  | {
      readonly _tag: "AttemptPending";
      readonly cost: CostEvidence;
      readonly evidence: string;
    }
  | {
      readonly _tag: "AttemptUnavailable";
      readonly cost: CostEvidence;
      readonly evidence: string;
    }
  | {
      readonly _tag: "Completed";
      readonly bytes: Uint8Array;
      readonly cost: CostEvidence;
      readonly renderedPageCount: number;
    }
  | {
      readonly _tag: "Interrupted";
      readonly cost: CostEvidence;
      readonly evidence: string;
    }
  | { readonly _tag: "IntentConflict"; readonly cost: CostEvidence }
  | {
      readonly _tag: "RejectedOversize";
      readonly cost: CostEvidence;
      readonly size: number;
    };

/** Durable evidence that an earlier admission owns this document attempt. */
export interface ComputeRecovery {
  readonly cost: Extract<CostEvidence, { readonly _tag: "Incurred" }>;
  readonly intentDigest: DocumentIntentDigest;
}

/** Input for one exact generated document intent. */
export interface GenerateRequest {
  readonly actionId: ActionId;
  readonly authorization: AuthorizationContext;
  readonly format: DocumentArtifact.DocumentFormat;
  readonly owner: DocumentArtifact.DocumentOwner;
  readonly source: DocumentSource;
}

/** One authorized request to export or delete a retained document. */
export interface ArtifactRequest {
  readonly actionId: ActionId;
  readonly authorization: AuthorizationContext;
  readonly contentId: ContentId;
}

/** Trusted retained metadata available without retrieving private Client Content bytes. */
export interface StoredArtifactMetadata {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly artifact: DocumentArtifact.ArtifactRef;
  readonly cost: CostEvidence;
  readonly format: DocumentArtifact.DocumentFormat;
  readonly intentDigest: DocumentIntentDigest;
  readonly owner: DocumentArtifact.DocumentOwner;
  /** Accounting state fences retained bytes until allowance evidence is durable. */
  readonly retention: "accounted" | "pending";
  readonly userId: UserId;
}

/** Retained artifact bytes and recovery evidence hidden behind the Artifact Store seam. */
export interface StoredArtifact extends StoredArtifactMetadata {
  readonly bytes: Uint8Array;
}

/** Expected failure when the Artifact Store cannot complete an immutable operation. */
export class ArtifactStoreUnavailable extends Schema.TaggedError<ArtifactStoreUnavailable>()(
  "ArtifactStoreUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["account", "delete", "inspect", "put", "readBytes"]),
  },
) {}

/** Expected failure when retained bytes or metadata no longer match their validated digest. */
export class ArtifactIntegrityFailure extends Schema.TaggedError<ArtifactIntegrityFailure>()(
  "ArtifactIntegrityFailure",
  {
    contentId: ContentId,
    message: Schema.String,
  },
) {}

/** Expected failure when one owning identity is retried with a changed document intent. */
export class DocumentIntentConflict extends Schema.TaggedError<DocumentIntentConflict>()(
  "DocumentIntentConflict",
  {
    contentId: ContentId,
    message: Schema.String,
  },
) {}

/** Expected failure after disposable compute stops before it returns a complete artifact. */
export class DocumentComputeInterrupted extends Schema.TaggedError<DocumentComputeInterrupted>()(
  "DocumentComputeInterrupted",
  {
    contentId: ContentId,
    evidence: Schema.String,
    message: Schema.String,
  },
) {}

/** Expected failure when incurred compute cost exceeds the admitted operation maximum. */
export class DocumentCostLimitExceeded extends Schema.TaggedError<DocumentCostLimitExceeded>()(
  "DocumentCostLimitExceeded",
  {
    admittedUsdMicros: Schema.BigInt,
    contentId: ContentId,
    incurredUsdMicros: Schema.BigInt,
    message: Schema.String,
  },
) {}

/** Expected failure when a requested retained document does not exist. */
export class DocumentArtifactNotFound extends Schema.TaggedError<DocumentArtifactNotFound>()(
  "DocumentArtifactNotFound",
  { contentId: ContentId, message: Schema.String },
) {}

/** Expected failure when disposable Sandbox cleanup cannot be confirmed. */
export class DocumentCleanupUnavailable extends Schema.TaggedError<DocumentCleanupUnavailable>()(
  "DocumentCleanupUnavailable",
  { cause: Schema.Defect(), contentId: ContentId, message: Schema.String },
) {}

/** Expected failure when current protected-effect authorization facts cannot be loaded. */
export class DocumentAuthorizationUnavailable extends Schema.TaggedError<DocumentAuthorizationUnavailable>()(
  "DocumentAuthorizationUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Expected failure when a referenced visual is absent, unowned, pending, or not an image. */
export class DocumentSupportingVisualUnavailable extends Schema.TaggedError<DocumentSupportingVisualUnavailable>()(
  "DocumentSupportingVisualUnavailable",
  { contentId: ContentId, message: Schema.String },
) {}

/** Narrow immutable artifact persistence port implemented by R2. */
export interface ArtifactStore {
  /** Mark immutable retained bytes readable after both allowance records are durable. */
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
    ArtifactIntegrityFailure | ArtifactStoreUnavailable | DocumentIntentConflict
  >;
  readonly readBytes: (
    metadata: StoredArtifactMetadata,
  ) => Effect.Effect<Uint8Array, ArtifactIntegrityFailure | ArtifactStoreUnavailable>;
}

/** Narrow adapter boundary that parses PDF or DOCX bytes into an artifact reference. */
export interface ArtifactValidator {
  readonly validate: (
    contentId: ContentId,
    format: DocumentArtifact.DocumentFormat,
    bytes: Uint8Array,
    expectedPageCount: number,
  ) => Effect.Effect<DocumentArtifact.ArtifactRef, DocumentArtifact.InvalidGeneratedArtifact>;
}

/** Narrow disposable document compute port. Calls are idempotent for one ContentId. */
export interface DisposableCompute {
  readonly dispose: (contentId: ContentId) => Effect.Effect<void, DocumentCleanupUnavailable>;
  readonly generate: (input: {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly contentId: ContentId;
    readonly format: DocumentArtifact.DocumentFormat;
    readonly intentDigest: DocumentIntentDigest;
    readonly authorizeWrite: Effect.Effect<void, Denied | DocumentAuthorizationUnavailable>;
    readonly source: DocumentSource;
    readonly supportingVisuals: ReadonlyArray<{
      readonly bytes: Uint8Array;
      readonly contentId: ContentId;
    }>;
    readonly userId: UserId;
  }) => Effect.Effect<ComputeResult>;
  readonly inspect: (
    contentId: ContentId,
    intentDigest: DocumentIntentDigest,
  ) => Effect.Effect<ComputeRecovery | null, DocumentComputeInterrupted | DocumentIntentConflict>;
}

type AllowanceFailure =
  | AllowancePeriodNotFound
  | BillingTransactionRetryExhausted
  | DatabaseUnavailable
  | PlanPolicyNotFound
  | UsageConflict;

/** Narrow allowance recorder used for exact generation evidence. */
export interface Allowances {
  readonly record: (
    allowancePeriodId: AllowancePeriodId,
    source: AllowanceSource,
    items: ReadonlyArray<AllowanceItem>,
  ) => Effect.Effect<ExistingUsage | Recorded, AllowanceFailure>;
}

/** Concrete dependencies for bounded document generation. */
export interface MakeOptions {
  readonly allowances: Allowances;
  readonly artifactValidator: ArtifactValidator;
  readonly artifacts: ArtifactStore;
  readonly authorization: Authorization;
  readonly compute: DisposableCompute;
  readonly currentAuthorization: (
    admitted: AuthorizationContext,
  ) => Effect.Effect<AuthorizationContext, DocumentAuthorizationUnavailable>;
  readonly maximumComputeInputBytes: number;
  readonly visuals: {
    readonly read: (
      contentId: ContentId,
      userId: UserId,
    ) => Effect.Effect<Uint8Array, DocumentSupportingVisualUnavailable>;
  };
}

/** Bounded document generation and retained artifact lifecycle. */
export interface Interface {
  readonly delete: (
    request: ArtifactRequest,
  ) => Effect.Effect<
    void,
    | ArtifactIntegrityFailure
    | ArtifactStoreUnavailable
    | Denied
    | DocumentArtifactNotFound
    | DocumentAuthorizationUnavailable
    | DocumentCleanupUnavailable
  >;
  readonly export: (request: ArtifactRequest) => Effect.Effect<
    {
      readonly artifact: DocumentArtifact.ArtifactRef;
      readonly bytes: Uint8Array;
    },
    | ArtifactIntegrityFailure
    | ArtifactStoreUnavailable
    | Denied
    | DocumentArtifactNotFound
    | DocumentAuthorizationUnavailable
  >;
  readonly reference: (
    request: ArtifactRequest,
  ) => Effect.Effect<
    DocumentArtifact.ArtifactRef,
    | ArtifactIntegrityFailure
    | ArtifactStoreUnavailable
    | Denied
    | DocumentArtifactNotFound
    | DocumentAuthorizationUnavailable
  >;
  readonly generate: (
    request: GenerateRequest,
  ) => Effect.Effect<
    DocumentArtifact.ArtifactRef,
    | AllowanceFailure
    | ArtifactIntegrityFailure
    | ArtifactStoreUnavailable
    | Denied
    | DocumentArtifact.InvalidGeneratedArtifact
    | DocumentComputeInterrupted
    | DocumentAuthorizationUnavailable
    | DocumentCleanupUnavailable
    | DocumentCostLimitExceeded
    | DocumentIntentConflict
    | DocumentSupportingVisualUnavailable
  >;
}

/** Construct bounded document generation from Authorization, allowance, compute, and storage ports. */
export const make = (options: MakeOptions): Interface => ({
  delete: (request) =>
    Effect.gen(function* () {
      const stored = yield* readAuthorized(options, request, "file.delete");
      yield* options.artifacts.delete(stored);
    }),
  export: (request) =>
    Effect.gen(function* () {
      const stored = yield* readAuthorized(options, request, "file.read");
      const bytes = yield* options.artifacts.readBytes(stored);
      return { artifact: stored.artifact, bytes };
    }),
  reference: (request) =>
    Effect.map(readAuthorized(options, request, "file.read"), (stored) => stored.artifact),
  generate: (request) =>
    Effect.gen(function* () {
      const contentId = contentIdFor(request.owner);
      const userId = request.authorization.user.userId;
      if (!ownerMatchesRequest(request)) {
        return yield* Effect.fail({
          _tag: "Denied",
          reason: "ownershipRequired",
          resetAt: null,
        } satisfies Denied);
      }
      const intentDigest = yield* digestIntent(request.format, request.source);
      const operation = {
        actionId: request.actionId,
        artifactKind: "document" as const,
        bytes: BigInt(DocumentArtifact.maximumDocumentBytes),
        kind: "document.generate" as const,
        pages: BigInt(request.source.pages.length),
        researchSearches: 0n,
      };
      const authorizeWrite = Effect.gen(function* () {
        const currentAuthorization = yield* options.currentAuthorization(request.authorization);
        const permitted = options.authorization.recheck(currentAuthorization, operation);
        if (Predicate.isTagged(permitted, "Denied")) return yield* Effect.fail(permitted);
        return undefined;
      });
      const existing = yield* options.artifacts.inspect(contentId);
      if (existing !== null) {
        if (
          existing.userId !== userId ||
          existing.intentDigest !== intentDigest ||
          existing.format !== request.format ||
          !DocumentArtifact.sameOwner(existing.owner, request.owner)
        ) {
          return yield* new DocumentIntentConflict({
            contentId,
            message: "The owning identity already names a different document intent",
          });
        }
        // A pending immutable body may only become readable after idempotent allowance
        // evidence is complete. This recovery does not start new provider work.
        yield* recordEvidence(options.allowances, existing);
        yield* authorizeWrite;
        yield* options.artifacts.account(contentId);
        yield* options.compute.dispose(contentId);
        return existing.artifact;
      }

      const recovery = yield* options.compute.inspect(contentId, intentDigest);
      let admittedAllowancePeriodId: AllowancePeriodId;
      if (recovery === null) {
        const admission = options.authorization.admit(request.authorization, operation);
        if (!Predicate.isTagged(admission, "Admitted")) {
          return yield* Effect.fail(
            Predicate.isTagged(admission, "Denied")
              ? admission
              : ({
                  _tag: "Denied",
                  reason: "approvalRequired",
                  resetAt: null,
                } satisfies Denied),
          );
        }
        if (!Predicate.isTagged(admission.allowancePeriod, "Metered")) {
          return yield* Effect.fail({
            _tag: "Denied",
            reason: "allowancePeriodUnavailable",
            resetAt: null,
          } satisfies Denied);
        }
        admittedAllowancePeriodId = admission.allowancePeriod.allowancePeriodId;
      } else {
        admittedAllowancePeriodId = recovery.cost.allowancePeriodId;
      }

      yield* authorizeWrite;
      const supportingVisuals = yield* readSupportingVisuals(options, request.source, userId);
      let cleanupRequired = true;
      return yield* Effect.gen(function* () {
        const computed = yield* options.compute.generate({
          allowancePeriodId: admittedAllowancePeriodId,
          authorizeWrite,
          contentId,
          format: request.format,
          intentDigest,
          source: request.source,
          supportingVisuals,
          userId,
        });
        const recordComputedCost = recordCost(options.allowances, computed.cost);
        if (Predicate.isTagged(computed, "AuthorizationFailure")) {
          yield* recordComputedCost;
          return yield* Effect.fail(computed.failure);
        }
        if (Predicate.isTagged(computed, "AttemptPending")) {
          cleanupRequired = false;
          yield* recordComputedCost;
          return yield* new DocumentComputeInterrupted({
            contentId,
            evidence: computed.evidence,
            message: "Another caller owns disposable document compute",
          });
        }
        if (
          computed.cost._tag === "Incurred" &&
          computed.cost.usdMicros > request.authorization.requestVendorUsdMicros
        ) {
          yield* recordComputedCost;
          return yield* new DocumentCostLimitExceeded({
            admittedUsdMicros: request.authorization.requestVendorUsdMicros,
            contentId,
            incurredUsdMicros: computed.cost.usdMicros,
            message: "Disposable compute exceeded the admitted vendor-cost maximum",
          });
        }
        if (Predicate.isTagged(computed, "AttemptUnavailable")) {
          yield* recordComputedCost;
          return yield* new DocumentComputeInterrupted({
            contentId,
            evidence: computed.evidence,
            message: "Durable document attempt evidence is unavailable",
          });
        }
        if (Predicate.isTagged(computed, "IntentConflict")) {
          return yield* new DocumentIntentConflict({
            contentId,
            message: "The owning identity already names a different document attempt",
          });
        }
        if (Predicate.isTagged(computed, "Interrupted")) {
          yield* recordComputedCost;
          return yield* new DocumentComputeInterrupted({
            contentId,
            evidence: computed.evidence,
            message: "Disposable document compute was interrupted",
          });
        }
        if (Predicate.isTagged(computed, "RejectedOversize")) {
          yield* recordComputedCost;
          return yield* new DocumentArtifact.InvalidGeneratedArtifact({
            contentId,
            message: "The generated document exceeds 5 MB",
            reason: "byteLimit",
          });
        }
        if (computed.renderedPageCount !== request.source.pages.length) {
          yield* recordComputedCost;
          return yield* new DocumentArtifact.InvalidGeneratedArtifact({
            contentId,
            message: "Rendered pagination does not match the bounded source",
            reason: "invalidDocument",
          });
        }

        const artifact = yield* options.artifactValidator
          .validate(contentId, request.format, computed.bytes, computed.renderedPageCount)
          .pipe(Effect.tapError(() => recordComputedCost));
        const retained: StoredArtifact = {
          allowancePeriodId:
            computed.cost._tag === "Incurred"
              ? computed.cost.allowancePeriodId
              : admittedAllowancePeriodId,
          artifact,
          bytes: computed.bytes,
          cost: computed.cost,
          format: request.format,
          intentDigest,
          owner: request.owner,
          retention: "pending",
          userId,
        };
        yield* authorizeWrite;
        yield* options.artifacts.put(retained);
        yield* recordComputedCost;
        yield* recordDocument(options.allowances, retained);
        yield* authorizeWrite;
        yield* options.artifacts.account(contentId);
        return artifact;
      }).pipe(
        Effect.onExit(() => (cleanupRequired ? options.compute.dispose(contentId) : Effect.void)),
      );
    }),
});

const readSupportingVisuals = (options: MakeOptions, source: DocumentSource, userId: UserId) =>
  Effect.gen(function* () {
    const contentIds = [
      ...new Set(
        source.pages.flatMap(({ visualContentId }) =>
          visualContentId === undefined ? [] : [visualContentId],
        ),
      ),
    ];
    const visuals = yield* Effect.forEach(
      contentIds,
      (contentId) =>
        options.visuals.read(contentId, userId).pipe(Effect.map((bytes) => ({ bytes, contentId }))),
      { concurrency: 4 },
    );
    const totalBytes = visuals.reduce((total, { bytes }) => total + bytes.byteLength, 0);
    const firstContentId = contentIds[0];
    if (totalBytes > options.maximumComputeInputBytes && firstContentId !== undefined) {
      return yield* new DocumentSupportingVisualUnavailable({
        contentId: firstContentId,
        message: "Supporting visuals exceed the immutable compute-input limit",
      });
    }
    return visuals;
  });

const contentIdFor = (owner: DocumentArtifact.DocumentOwner): ContentId =>
  ContentId.make(
    Predicate.isTagged(owner, "ToolCall")
      ? `document:toolCall:${owner.toolCallId}`
      : `document:workflow:${owner.workflowId}`,
  );

const digestIntent = (format: DocumentArtifact.DocumentFormat, source: DocumentSource) =>
  Schema.encodeEffect(IntentEncoding)({ format, source }).pipe(
    Effect.orDie,
    Effect.flatMap((encoded) =>
      Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))),
    ),
    Effect.map((digest) =>
      DocumentIntentDigest.make(
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
    ),
  );

const IntentEncoding = Schema.fromJsonString(
  Schema.Struct({
    format: DocumentArtifact.DocumentFormat,
    source: DocumentSource,
  }),
);

const recordEvidence = (allowances: Allowances, stored: StoredArtifactMetadata) =>
  Effect.gen(function* () {
    yield* recordCost(allowances, stored.cost);
    yield* recordDocument(allowances, stored);
  });

const recordCost = (allowances: Allowances, cost: CostEvidence) => {
  if (cost._tag === "ProvenNoUse") return Effect.void;
  return allowances.record(
    cost.allowancePeriodId,
    {
      sourceId: cost.providerOperationId,
      sourceType: "documentProviderOperation",
    },
    [
      {
        allowanceKind: "vendorUsdMicros",
        basis: cost.basis,
        quantity: cost.usdMicros,
      },
    ],
  );
};

const recordDocument = (allowances: Allowances, stored: StoredArtifactMetadata) => {
  const source = Predicate.isTagged(stored.owner, "ToolCall")
    ? { sourceId: stored.owner.toolCallId, sourceType: "toolCall" }
    : { sourceId: stored.owner.workflowId, sourceType: "workflow" };
  return allowances.record(stored.allowancePeriodId, source, [
    { allowanceKind: "generatedDocuments", basis: "observed", quantity: 1n },
  ]);
};

const ownerMatchesRequest = (request: GenerateRequest) =>
  Predicate.isTagged(request.owner, "ToolCall")
    ? request.owner.toolCallId === request.actionId
    : Predicate.isTagged(request.authorization.authority, "DurableTrigger") &&
      request.authorization.authority.triggerType === "workflow" &&
      request.owner.workflowId === request.authorization.authority.triggerId;

const readAuthorized = (
  options: MakeOptions,
  request: ArtifactRequest,
  kind: "file.delete" | "file.read",
) =>
  Effect.gen(function* () {
    const stored = yield* options.artifacts.inspect(request.contentId);
    if (stored === null) {
      return yield* new DocumentArtifactNotFound({
        contentId: request.contentId,
        message: "The retained document does not exist",
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

export const DocumentOwner = DocumentArtifact.DocumentOwner;
export type DocumentOwner = DocumentArtifact.DocumentOwner;

export type { AllowanceItem, AllowanceSource } from "../domain/allowance";

export * as DocumentGeneration from "./document-generation";
