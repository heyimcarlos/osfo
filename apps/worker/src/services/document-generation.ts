import { Effect, Predicate, Schema } from "effect";

import type { AllowancePeriodId, UserId } from "../domain";
import type { ActionId } from "../domain/action-execution";
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
import * as DocumentArtifact from "../domain/document-artifact";
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
});

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
      readonly basis: "conservative" | "observed";
      readonly providerOperationId: string;
      readonly usdMicros: bigint;
    };

/** Closed result from one safely repeatable disposable compute attempt. */
export type ComputeResult =
  | {
      readonly _tag: "Completed";
      readonly bytes: Uint8Array;
      readonly cost: CostEvidence;
      readonly renderedPageCount: number;
    }
  | { readonly _tag: "Interrupted"; readonly cost: CostEvidence; readonly evidence: string };

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
  readonly artifactId: DocumentArtifact.ArtifactId;
  readonly authorization: AuthorizationContext;
}

/** Retained artifact bytes and recovery evidence hidden behind the Artifact Store seam. */
export interface StoredArtifact {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly artifact: DocumentArtifact.Artifact;
  readonly bytes: Uint8Array;
  readonly cost: CostEvidence;
  readonly format: DocumentArtifact.DocumentFormat;
  readonly intentDigest: DocumentIntentDigest;
  readonly owner: DocumentArtifact.DocumentOwner;
  readonly userId: UserId;
}

/** Expected failure when the Artifact Store cannot complete an immutable operation. */
export class ArtifactStoreUnavailable extends Schema.TaggedError<ArtifactStoreUnavailable>()(
  "ArtifactStoreUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: Schema.Literals(["delete", "get", "put"]),
  },
) {}

/** Expected failure when retained bytes or metadata no longer match their validated digest. */
export class ArtifactIntegrityFailure extends Schema.TaggedError<ArtifactIntegrityFailure>()(
  "ArtifactIntegrityFailure",
  {
    artifactId: DocumentArtifact.ArtifactId,
    message: Schema.String,
  },
) {}

/** Expected failure when one owning identity is retried with a changed document intent. */
export class DocumentIntentConflict extends Schema.TaggedError<DocumentIntentConflict>()(
  "DocumentIntentConflict",
  {
    artifactId: DocumentArtifact.ArtifactId,
    message: Schema.String,
  },
) {}

/** Expected failure after disposable compute stops before it returns a complete artifact. */
export class DocumentComputeInterrupted extends Schema.TaggedError<DocumentComputeInterrupted>()(
  "DocumentComputeInterrupted",
  {
    artifactId: DocumentArtifact.ArtifactId,
    evidence: Schema.String,
    message: Schema.String,
  },
) {}

/** Expected failure when incurred compute cost exceeds the admitted operation maximum. */
export class DocumentCostLimitExceeded extends Schema.TaggedError<DocumentCostLimitExceeded>()(
  "DocumentCostLimitExceeded",
  {
    admittedUsdMicros: Schema.BigInt,
    artifactId: DocumentArtifact.ArtifactId,
    incurredUsdMicros: Schema.BigInt,
    message: Schema.String,
  },
) {}

/** Expected failure when a requested retained document does not exist. */
export class DocumentArtifactNotFound extends Schema.TaggedError<DocumentArtifactNotFound>()(
  "DocumentArtifactNotFound",
  { artifactId: DocumentArtifact.ArtifactId, message: Schema.String },
) {}

/** Narrow immutable artifact persistence port implemented by R2. */
export interface ArtifactStore {
  readonly delete: (
    artifactId: DocumentArtifact.ArtifactId,
  ) => Effect.Effect<void, ArtifactStoreUnavailable>;
  readonly get: (
    artifactId: DocumentArtifact.ArtifactId,
  ) => Effect.Effect<StoredArtifact | null, ArtifactIntegrityFailure | ArtifactStoreUnavailable>;
  readonly put: (
    artifact: StoredArtifact,
  ) => Effect.Effect<
    void,
    ArtifactIntegrityFailure | ArtifactStoreUnavailable | DocumentIntentConflict
  >;
}

/** Narrow disposable document compute port. Calls are idempotent for one ArtifactId. */
export interface DisposableCompute {
  readonly dispose: (artifactId: DocumentArtifact.ArtifactId) => Effect.Effect<void>;
  readonly generate: (input: {
    readonly artifactId: DocumentArtifact.ArtifactId;
    readonly format: DocumentArtifact.DocumentFormat;
    readonly intentDigest: DocumentIntentDigest;
    readonly source: DocumentSource;
  }) => Effect.Effect<ComputeResult>;
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
  readonly artifacts: ArtifactStore;
  readonly authorization: Authorization;
  readonly compute: DisposableCompute;
}

/** Bounded document generation and retained artifact lifecycle. */
export interface Interface {
  readonly delete: (
    request: ArtifactRequest,
  ) => Effect.Effect<
    void,
    ArtifactIntegrityFailure | ArtifactStoreUnavailable | Denied | DocumentArtifactNotFound
  >;
  readonly export: (
    request: ArtifactRequest,
  ) => Effect.Effect<
    { readonly artifact: DocumentArtifact.Artifact; readonly bytes: Uint8Array },
    ArtifactIntegrityFailure | ArtifactStoreUnavailable | Denied | DocumentArtifactNotFound
  >;
  readonly generate: (
    request: GenerateRequest,
  ) => Effect.Effect<
    DocumentArtifact.Artifact,
    | AllowanceFailure
    | ArtifactIntegrityFailure
    | ArtifactStoreUnavailable
    | Denied
    | DocumentArtifact.InvalidGeneratedArtifact
    | DocumentComputeInterrupted
    | DocumentCostLimitExceeded
    | DocumentIntentConflict
  >;
}

/** Construct bounded document generation from Authorization, allowance, compute, and storage ports. */
export const make = (options: MakeOptions): Interface => ({
  delete: (request) =>
    Effect.gen(function* () {
      const stored = yield* readAuthorized(options, request, "file.delete");
      yield* options.artifacts.delete(stored.artifact.artifactId);
    }),
  export: (request) =>
    Effect.map(readAuthorized(options, request, "file.read"), (stored) => ({
      artifact: stored.artifact,
      bytes: stored.bytes,
    })),
  generate: (request) =>
    Effect.gen(function* () {
      const artifactId = artifactIdFor(request.owner);
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
      const existing = yield* options.artifacts.get(artifactId);
      if (existing !== null) {
        if (
          existing.userId !== userId ||
          existing.intentDigest !== intentDigest ||
          existing.format !== request.format ||
          !DocumentArtifact.sameOwner(existing.owner, request.owner)
        ) {
          return yield* new DocumentIntentConflict({
            artifactId,
            message: "The owning identity already names a different document intent",
          });
        }
        const permitted = options.authorization.recheck(request.authorization, operation);
        if (Predicate.isTagged(permitted, "Denied")) return yield* Effect.fail(permitted);
        yield* recordEvidence(options.allowances, existing);
        yield* options.compute.dispose(artifactId);
        return existing.artifact;
      }

      const admission = options.authorization.admit(request.authorization, operation);
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

      const computed = yield* options.compute.generate({
        artifactId,
        format: request.format,
        intentDigest,
        source: request.source,
      });
      const recordComputedCost = recordCost(
        options.allowances,
        admission.allowancePeriod.allowancePeriodId,
        computed.cost,
      );
      if (
        computed.cost._tag === "Incurred" &&
        computed.cost.usdMicros > request.authorization.requestVendorUsdMicros
      ) {
        yield* recordComputedCost;
        yield* options.compute.dispose(artifactId);
        return yield* new DocumentCostLimitExceeded({
          admittedUsdMicros: request.authorization.requestVendorUsdMicros,
          artifactId,
          incurredUsdMicros: computed.cost.usdMicros,
          message: "Disposable compute exceeded the admitted vendor-cost maximum",
        });
      }
      if (Predicate.isTagged(computed, "Interrupted")) {
        yield* recordComputedCost;
        yield* options.compute.dispose(artifactId);
        return yield* new DocumentComputeInterrupted({
          artifactId,
          evidence: computed.evidence,
          message: "Disposable document compute was interrupted",
        });
      }
      if (computed.renderedPageCount !== request.source.pages.length) {
        yield* recordComputedCost;
        yield* options.compute.dispose(artifactId);
        return yield* new DocumentArtifact.InvalidGeneratedArtifact({
          artifactId,
          message: "Rendered pagination does not match the bounded source",
          reason: "invalidDocument",
        });
      }

      const artifact = yield* DocumentArtifact.parse(
        artifactId,
        request.format,
        computed.bytes,
        computed.renderedPageCount,
      ).pipe(
        Effect.tapError(() => recordComputedCost),
        Effect.tapError(() => options.compute.dispose(artifactId)),
      );
      const retained: StoredArtifact = {
        allowancePeriodId: admission.allowancePeriod.allowancePeriodId,
        artifact,
        bytes: computed.bytes,
        cost: computed.cost,
        format: request.format,
        intentDigest,
        owner: request.owner,
        userId,
      };
      yield* options.artifacts.put(retained);
      yield* recordComputedCost;
      yield* recordDocument(options.allowances, retained);
      yield* options.compute.dispose(artifactId);
      return artifact;
    }),
});

const artifactIdFor = (owner: DocumentArtifact.DocumentOwner): DocumentArtifact.ArtifactId =>
  DocumentArtifact.ArtifactId.make(
    Predicate.isTagged(owner, "ToolCall")
      ? `toolCall:${owner.toolCallId}`
      : `workflow:${owner.workflowId}`,
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
  Schema.Struct({ format: DocumentArtifact.DocumentFormat, source: DocumentSource }),
);

const recordEvidence = (allowances: Allowances, stored: StoredArtifact) =>
  Effect.gen(function* () {
    yield* recordCost(allowances, stored.allowancePeriodId, stored.cost);
    yield* recordDocument(allowances, stored);
  });

const recordCost = (
  allowances: Allowances,
  allowancePeriodId: AllowancePeriodId,
  cost: CostEvidence,
) => {
  if (cost._tag === "ProvenNoUse") return Effect.void;
  return allowances.record(
    allowancePeriodId,
    { sourceId: cost.providerOperationId, sourceType: "documentProviderOperation" },
    [{ allowanceKind: "vendorUsdMicros", basis: cost.basis, quantity: cost.usdMicros }],
  );
};

const recordDocument = (allowances: Allowances, stored: StoredArtifact) => {
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
    const stored = yield* options.artifacts.get(request.artifactId);
    if (stored === null) {
      return yield* new DocumentArtifactNotFound({
        artifactId: request.artifactId,
        message: "The retained document does not exist",
      });
    }
    const authorization = {
      ...request.authorization,
      requestVendorUsdMicros: 0n,
      resourceOwnerUserId: stored.userId,
    };
    const permitted = options.authorization.recheck(authorization, {
      actionId: request.actionId,
      kind,
    });
    if (Predicate.isTagged(permitted, "Denied")) return yield* Effect.fail(permitted);
    if (kind === "file.read") {
      const documentPermitted = options.authorization.recheck(authorization, {
        actionId: request.actionId,
        artifactKind: "document",
        bytes: BigInt(stored.artifact.byteLength),
        kind: "document.generate",
        pages: BigInt(stored.artifact.pageCount),
        researchSearches: 0n,
      });
      if (Predicate.isTagged(documentPermitted, "Denied")) {
        return yield* Effect.fail(documentPermitted);
      }
    }
    return stored;
  });

export const DocumentOwner = DocumentArtifact.DocumentOwner;
export type DocumentOwner = DocumentArtifact.DocumentOwner;

export type { AllowanceItem, AllowanceSource } from "../domain/allowance";
