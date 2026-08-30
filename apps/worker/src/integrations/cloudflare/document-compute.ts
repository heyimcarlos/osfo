import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Clock, Effect, Random, Result, Schema } from "effect";

import { ContentId } from "../../domain/client-content";
import { AllowancePeriodId, UserId } from "../../domain";
import { DocumentArtifact } from "../../domain/document-artifact";
import { QualificationContext, sameQualificationContext } from "../../domain/qualification-context";
import type { QualificationContext as QualificationContextValue } from "../../domain/qualification-context";
import { qualificationChecksum } from "../../qualification/qualification-checksum";
import type { Denied } from "../../services/authorization";
import {
  DocumentSource,
  DocumentCleanupUnavailable,
  DocumentComputeInterrupted,
  type DocumentAuthorizationUnavailable,
  DocumentIntentDigest,
  DocumentIntentConflict,
  type CostEvidence,
  type ComputeResult,
  type DisposableCompute,
} from "../../services/document-generation";
import { attemptKeyFor, ownerKeyFor } from "./document-storage-keys";
import { DocumentOwnershipIndex } from "./document-ownership-index";

export interface ActiveAttemptEvidence {
  readonly cost: Extract<CostEvidence, { _tag: "Incurred" }>;
  readonly executionLeaseExpiresAt: number;
  /** Digest of the immutable document intent that owns this attempt. */
  readonly intentDigest: DocumentIntentDigest;
  readonly renderedPageCount: number | null;
  readonly status: "claimed" | "recovery" | "started" | "completed" | "failed";
  readonly qualification?: QualificationAttemptEvidence;
  readonly userId?: UserId;
}

/** Exact producer identity retained only for qualification-owned Document Compute work. */
export interface QualificationAttemptEvidence {
  readonly artifactChecksum: string;
  readonly claimedAtEpochMs: number;
  readonly completedAtEpochMs: number | null;
  readonly contentId: ContentId;
  readonly context: QualificationContextValue;
  readonly evidenceVersion: "document-compute-attempt-v2";
  readonly failedAtEpochMs: number | null;
  readonly startedAtEpochMs: number | null;
  readonly taskExecutionId: string;
  readonly taskOutcomeId: string | null;
  readonly workflowId: string;
}

export interface QualificationAttemptInput {
  readonly claimedAtEpochMs: number;
  readonly context: QualificationContextValue;
  readonly workflowId: string;
}

export interface QualificationNoComputeInput extends QualificationAttemptInput {
  readonly intentDigest: DocumentIntentDigest;
}

export interface DiscardedAttemptEvidence {
  readonly cost: Extract<CostEvidence, { _tag: "ProvenNoUse" }>;
  readonly status: "discarded";
  readonly userId: UserId;
}

export interface NoComputeAttemptEvidence {
  readonly cost: Extract<CostEvidence, { _tag: "ProvenNoUse" }>;
  readonly intentDigest: DocumentIntentDigest;
  readonly qualification: QualificationAttemptEvidence & {
    readonly completedAtEpochMs: null;
    readonly failedAtEpochMs: null;
    readonly startedAtEpochMs: null;
    readonly taskOutcomeId: string;
  };
  readonly status: "notRequired";
  readonly userId: UserId;
}

export type AttemptEvidence =
  | ActiveAttemptEvidence
  | DiscardedAttemptEvidence
  | NoComputeAttemptEvidence;

/** Expected failure when durable attempt evidence cannot be reconciled. */
export class DocumentAttemptEvidenceUnavailable extends Schema.TaggedError<DocumentAttemptEvidenceUnavailable>()(
  "DocumentAttemptEvidenceUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

/** Durable attempt evidence needed to prevent a retry from minting a new cost identity. */
export interface AttemptEvidenceStore {
  readonly claim: (
    contentId: ContentId,
    intentDigest: DocumentIntentDigest,
    cost: ActiveAttemptEvidence["cost"],
    executionLeaseExpiresAt: number,
    userId: UserId,
    qualification?: QualificationAttemptInput,
  ) => Promise<
    | {
        readonly _tag: "Claimed";
        readonly created: boolean;
        readonly evidence: ActiveAttemptEvidence;
        readonly revision: string;
      }
    | { readonly _tag: "Discarded" }
    | { readonly _tag: "IntentConflict" }
    | {
        readonly _tag: "Terminal";
        readonly evidence: ActiveAttemptEvidence | NoComputeAttemptEvidence;
      }
  >;
  readonly complete: (
    contentId: ContentId,
    evidence: ActiveAttemptEvidence & {
      readonly renderedPageCount: number;
      readonly status: "completed";
    },
    revision: string,
  ) => Promise<boolean>;
  readonly inspect: (contentId: ContentId) => Promise<AttemptEvidence | null>;
  readonly fail: (
    contentId: ContentId,
    evidence: ActiveAttemptEvidence & { readonly status: "failed" },
    revision: string,
  ) => Promise<boolean>;
  readonly reclaim: (
    contentId: ContentId,
    evidence: ActiveAttemptEvidence & { readonly status: "recovery" },
    revision: string,
  ) => Promise<string | null>;
  readonly start: (
    contentId: ContentId,
    evidence: ActiveAttemptEvidence & { readonly status: "started" },
    revision: string,
  ) => Promise<string | null>;
}

/** Narrow Sandbox SDK client needed by the generated-document adapter. */
export interface SandboxClient {
  readonly destroy: () => Promise<void>;
  readonly exec: (
    command: string,
    options: { readonly timeout: number },
  ) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly success: boolean;
  }>;
  readonly exists: (path: string) => Promise<{ readonly exists: boolean }>;
  readonly readStream: (path: string) => Promise<{
    readonly content: ReadableStream<Uint8Array>;
    readonly size: number;
  }>;
  readonly readText: (path: string) => Promise<string>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
}

const executionLeaseMs = 10 * 60_000;
const minimumProtectedWindowMs = 5 * 60_000;
const defaultDeadlines = { cleanupMs: 30_000, execMs: 65_000, rpcMs: 30_000 };

interface Deadlines {
  readonly cleanupMs: number;
  readonly execMs: number;
  readonly rpcMs: number;
}

/** Construct disposable Python document compute over Cloudflare Sandbox. */
export const make = (
  binding: DurableObjectNamespace<Sandbox>,
  bucket: R2Bucket,
  conservativeVendorUsdMicros: bigint,
): DisposableCompute =>
  makeWithSandbox(
    (contentId) =>
      adaptSandbox(
        getSandbox(binding, sandboxIdFor(contentId), {
          enableDefaultSession: false,
          keepAlive: false,
          normalizeId: true,
          sleepAfter: "2m",
          transport: "rpc",
        }),
      ),
    makeAttemptEvidenceStore(bucket),
    conservativeVendorUsdMicros,
  );

/** Derive one collision-resistant identity within the Sandbox SDK's 63-character limit. */
export const sandboxIdFor = (contentId: ContentId) =>
  `doc-${bytesToHex(sha256(new TextEncoder().encode(contentId))).slice(0, 59)}`;

/** Construct the adapter at its Sandbox SDK boundary for deterministic contract tests. */
export const makeWithSandbox = (
  sandboxFor: (contentId: ContentId) => SandboxClient,
  attempts: AttemptEvidenceStore,
  conservativeVendorUsdMicros: bigint,
  deadlines: Deadlines = defaultDeadlines,
): DisposableCompute => ({
  dispose: (contentId) =>
    Effect.tryPromise({
      try: () => withDeadline(sandboxFor(contentId).destroy(), deadlines.cleanupMs),
      catch: (cause) =>
        new DocumentCleanupUnavailable({
          cause,
          contentId,
          message: "Disposable document Sandbox cleanup could not be confirmed",
        }),
    }),
  generate: (input) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const context = yield* Effect.context();
      const runPromise = Effect.runPromiseWith(context);
      const [high, low] = yield* Effect.all([Random.next, Random.next]);
      return yield* Effect.promise(() =>
        render(
          sandboxFor(input.contentId),
          attempts,
          conservativeVendorUsdMicros,
          input,
          () =>
            runPromise(
              input.authorizeWrite.pipe(
                Effect.match({ onFailure: (failure) => failure, onSuccess: () => null }),
              ),
            ),
          `cloudflare-sandbox:${input.contentId}:${high.toString(16)}${low.toString(16)}`,
          () => clock.currentTimeMillisUnsafe(),
          deadlines,
        ),
      );
    }),
  inspect: (contentId, intentDigest) =>
    Effect.tryPromise({
      try: () => attempts.inspect(contentId),
      catch: () =>
        new DocumentComputeInterrupted({
          contentId,
          evidence: "Durable document attempt evidence could not be inspected",
          message: "Document attempt recovery is unavailable",
        }),
    }).pipe(
      Effect.flatMap((evidence) => {
        if (evidence === null) return Effect.succeed(null);
        if (evidence.status === "discarded" || evidence.status === "notRequired") {
          return Effect.succeed(null);
        }
        if (evidence.intentDigest !== intentDigest) {
          return Effect.fail(
            new DocumentIntentConflict({
              contentId,
              message: "The owning identity already names a different document attempt",
            }),
          );
        }
        return Effect.succeed({ cost: evidence.cost, intentDigest });
      }),
    ),
});

// oxlint-disable-next-line effecttsgo/async-function -- Sandbox SDK is a Promise-based boundary.
const render = async (
  sandbox: SandboxClient,
  attempts: AttemptEvidenceStore,
  conservativeVendorUsdMicros: bigint,
  input: {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly contentId: ContentId;
    readonly format: DocumentArtifact.DocumentFormat;
    readonly intentDigest: DocumentIntentDigest;
    readonly qualification?: {
      readonly context: QualificationContextValue;
      readonly workflowId: string;
    };
    readonly source: DocumentSource;
    readonly supportingVisuals: ReadonlyArray<{
      readonly bytes: Uint8Array;
      readonly contentId: ContentId;
    }>;
    readonly userId: UserId;
  },
  authorizeWrite: () => Promise<Denied | DocumentAuthorizationUnavailable | null>,
  attemptOperationId: string,
  currentTimeMillis: () => number,
  deadlines: Deadlines,
): Promise<ComputeResult> => {
  const outputPath = `/workspace/document-${input.intentDigest}.${input.format}`;
  const sourcePath = `/workspace/source-${input.intentDigest}.json`;
  let providerOperationId = attemptOperationId;
  let durableAttemptClaimed = false;
  let providerUsePossible = false;
  try {
    const claimAuthorizationFailure = await authorizeWrite();
    if (claimAuthorizationFailure !== null) {
      return {
        _tag: "AuthorizationFailure",
        cost: { _tag: "ProvenNoUse" },
        failure: claimAuthorizationFailure,
      };
    }
    const proposedCost = incurred(
      input.allowancePeriodId,
      providerOperationId,
      conservativeVendorUsdMicros,
    );
    const claimedAtEpochMs = currentTimeMillis();
    const claimed = await attempts.claim(
      input.contentId,
      input.intentDigest,
      proposedCost,
      claimedAtEpochMs + executionLeaseMs,
      input.userId,
      input.qualification === undefined
        ? undefined
        : {
            claimedAtEpochMs,
            context: input.qualification.context,
            workflowId: input.qualification.workflowId,
          },
    );
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Persisted outcomes use _tag.
    if (claimed._tag === "IntentConflict") {
      return { _tag: "IntentConflict", cost: { _tag: "ProvenNoUse" } };
    }
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Persisted outcomes use _tag.
    if (claimed._tag === "Discarded") {
      return {
        _tag: "AttemptUnavailable",
        cost: { _tag: "ProvenNoUse" },
        evidence: "The terminal Workflow discarded its unused compute claim",
      };
    }
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Persisted outcomes use _tag.
    if (claimed._tag === "Terminal") {
      if (claimed.evidence.status === "notRequired") {
        return {
          _tag: "AttemptUnavailable",
          cost: { _tag: "ProvenNoUse" },
          evidence: "Document Compute retained an explicit no-work obligation",
        };
      }
      return interrupted(claimed.evidence.cost, "Document Compute retained a terminal failure");
    }
    durableAttemptClaimed = true;
    providerOperationId = claimed.evidence.cost.providerOperationId;
    const cost = claimed.evidence.cost;
    let renderedPageCount = claimed.evidence.renderedPageCount;
    let evidence = claimed.evidence;
    let revision = claimed.revision;
    if (evidence.status === "recovery") providerUsePossible = true;
    if (!claimed.created && claimed.evidence.status === "started") {
      if (claimed.evidence.executionLeaseExpiresAt > currentTimeMillis()) {
        return {
          _tag: "AttemptPending",
          cost,
          evidence: "Another caller owns the live Sandbox execution lease",
        };
      }
      providerUsePossible = true;
      const cachedOutput = await withDeadline(sandbox.exists(outputPath), deadlines.rpcMs);
      if (cachedOutput.exists) {
        const completedEvidence = transitionQualificationAttemptEvidence(
          {
            ...claimed.evidence,
            renderedPageCount: input.source.pages.length,
            status: "completed" as const,
          },
          { completedAtEpochMs: currentTimeMillis() },
        );
        const completed = await withDeadline(
          attempts.complete(input.contentId, completedEvidence, claimed.revision),
          deadlines.rpcMs,
        );
        if (!completed) {
          return {
            _tag: "AttemptPending",
            cost,
            evidence: "Another caller reconciled the expired Sandbox execution lease",
          };
        }
        evidence = completedEvidence;
        renderedPageCount = completedEvidence.renderedPageCount;
      } else {
        const reclaimedEvidence = transitionQualificationAttemptEvidence(
          {
            ...claimed.evidence,
            executionLeaseExpiresAt: currentTimeMillis() + executionLeaseMs,
            renderedPageCount: null,
            status: "recovery" as const,
          },
          {},
        );
        const reclaimed = await withDeadline(
          attempts.reclaim(input.contentId, reclaimedEvidence, claimed.revision),
          deadlines.rpcMs,
        );
        if (reclaimed === null) {
          return {
            _tag: "AttemptPending",
            cost,
            evidence: "Another caller reclaimed the expired Sandbox execution lease",
          };
        }
        return interrupted(
          cost,
          "The expired Sandbox execution was reclaimed after its output was missing",
        );
      }
    }

    if (evidence.status === "claimed" || evidence.status === "recovery") {
      const recoveringIncurredAttempt = evidence.status === "recovery";
      const startAuthorizationFailure = await authorizeWrite();
      if (startAuthorizationFailure !== null) {
        return {
          _tag: "AuthorizationFailure",
          cost: recoveringIncurredAttempt ? cost : { _tag: "ProvenNoUse" },
          failure: startAuthorizationFailure,
        };
      }
      const startedEvidence = transitionQualificationAttemptEvidence(
        { ...evidence, status: "started" as const },
        { startedAtEpochMs: currentTimeMillis() },
      );
      const started = await attempts.start(input.contentId, startedEvidence, revision);
      if (started === null) {
        return {
          _tag: "AttemptPending",
          cost: recoveringIncurredAttempt ? cost : { _tag: "ProvenNoUse" },
          evidence: "Another caller owns the atomic Sandbox execution transition",
        };
      }
      evidence = startedEvidence;
      revision = started;
    }
    if (
      renderedPageCount === null &&
      evidence.executionLeaseExpiresAt - currentTimeMillis() < minimumProtectedWindowMs
    ) {
      return {
        _tag: "AttemptPending",
        cost,
        evidence: "The durable execution lease has insufficient time for bounded Sandbox use",
      };
    }
    providerUsePossible = true;

    const cachedOutput = await withDeadline(sandbox.exists(outputPath), deadlines.rpcMs);
    if (renderedPageCount !== null && !cachedOutput.exists) {
      return interrupted(
        cost,
        "Completed compute evidence exists but its Sandbox output is unavailable",
      );
    }
    if (renderedPageCount === null) {
      await withDeadline(
        sandbox.writeFile(
          sourcePath,
          Schema.encodeSync(DocumentRendererInput)({
            pages: input.source.pages,
            supportingVisuals: input.supportingVisuals.map(({ bytes, contentId }) => ({
              base64: encodeBase64(bytes),
              contentId,
            })),
          }),
        ),
        deadlines.rpcMs,
      );
      const result = await withDeadline(
        sandbox.exec(
          `python3 /opt/osfo/render_document.py --format ${input.format} --input ${sourcePath} --output ${outputPath}`,
          { timeout: 60_000 },
        ),
        deadlines.execMs,
      );
      if (!result.success) {
        const failedEvidence = transitionQualificationAttemptEvidence(
          { ...evidence, status: "failed" as const },
          { failedAtEpochMs: currentTimeMillis() },
        );
        if (failedEvidence.qualification !== undefined) {
          const failed = await attempts.fail(input.contentId, failedEvidence, revision);
          if (!failed) {
            return {
              _tag: "AttemptPending",
              cost,
              evidence: "Another caller owns the atomic Sandbox failure transition",
            };
          }
        }
        return interrupted(cost, `The document renderer exited with code ${result.exitCode}`);
      }
      renderedPageCount = decodeRenderedPageCount(result.stdout);
      const completionAuthorizationFailure = await authorizeWrite();
      if (completionAuthorizationFailure !== null) {
        return { _tag: "AuthorizationFailure", cost, failure: completionAuthorizationFailure };
      }
      const completedEvidence = transitionQualificationAttemptEvidence(
        { ...evidence, renderedPageCount, status: "completed" as const },
        { completedAtEpochMs: currentTimeMillis() },
      );
      const completed = await withDeadline(
        attempts.complete(input.contentId, completedEvidence, revision),
        deadlines.rpcMs,
      );
      if (!completed) {
        return {
          _tag: "AttemptPending",
          cost,
          evidence: "Another caller owns the atomic Sandbox completion transition",
        };
      }
    }

    const file = await withDeadline(sandbox.readStream(outputPath), deadlines.rpcMs);
    if (file.size > DocumentArtifact.maximumDocumentBytes) {
      return {
        _tag: "RejectedOversize",
        cost,
        size: file.size,
      };
    }
    return {
      _tag: "Completed",
      bytes: await withDeadline(readBounded(file.content, file.size), deadlines.rpcMs),
      cost,
      renderedPageCount,
    };
  } catch {
    if (!durableAttemptClaimed || !providerUsePossible) {
      return {
        _tag: "AttemptUnavailable",
        cost: { _tag: "ProvenNoUse" },
        evidence: "Durable attempt evidence was unavailable before Sandbox use",
      };
    }
    return interrupted(
      incurred(input.allowancePeriodId, providerOperationId, conservativeVendorUsdMicros),
      "The disposable Sandbox stopped before verified output was available",
    );
  }
};

const withDeadline = <Value>(operation: Promise<Value>, timeoutMs: number) =>
  Effect.runPromise(Effect.promise(() => operation).pipe(Effect.timeout(timeoutMs)));

const adaptSandbox = (sandbox: Sandbox): SandboxClient => ({
  destroy: () => sandbox.destroy(),
  exec: (command, options) => sandbox.exec(command, options),
  exists: (path) => sandbox.exists(path),
  readStream: (path) => sandbox.readFile(path, { encoding: "none" }),
  readText: (path) => sandbox.readFile(path).then((file) => file.content),
  writeFile: (path, content) => sandbox.writeFile(path, content).then(() => undefined),
});

const AttemptEvidenceMetadata = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      cost: Schema.TaggedStruct("ProvenNoUse", {}),
      status: Schema.Literal("discarded"),
      userId: UserId,
    }),
    Schema.Struct({
      cost: Schema.TaggedStruct("ProvenNoUse", {}),
      intentDigest: DocumentIntentDigest,
      qualification: Schema.Struct({
        artifactChecksum: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
        claimedAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        completedAtEpochMs: Schema.Null,
        contentId: ContentId,
        context: QualificationContext,
        evidenceVersion: Schema.Literal("document-compute-attempt-v2"),
        failedAtEpochMs: Schema.Null,
        startedAtEpochMs: Schema.Null,
        taskExecutionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
        taskOutcomeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
        workflowId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
      }),
      status: Schema.Literal("notRequired"),
      userId: UserId,
    }),
    Schema.Struct({
      cost: Schema.TaggedStruct("Incurred", {
        allowancePeriodId: AllowancePeriodId,
        basis: Schema.Literals(["conservative", "observed"]),
        providerOperationId: Schema.String.check(Schema.isMinLength(1)),
        usdMicros: Schema.BigIntFromString,
      }),
      executionLeaseExpiresAt: Schema.Int,
      intentDigest: DocumentIntentDigest,
      qualification: Schema.optionalKey(
        Schema.Struct({
          artifactChecksum: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
          claimedAtEpochMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          completedAtEpochMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          contentId: ContentId,
          context: QualificationContext,
          evidenceVersion: Schema.Literal("document-compute-attempt-v2"),
          failedAtEpochMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          startedAtEpochMs: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
          taskExecutionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
          taskOutcomeId: Schema.NullOr(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
          ),
          workflowId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
        }),
      ),
      renderedPageCount: Schema.NullOr(
        Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20)),
      ),
      status: Schema.Literals(["claimed", "recovery", "started", "completed", "failed"]),
      userId: Schema.optionalKey(UserId),
    }),
  ]),
);

const DocumentRendererInput = Schema.fromJsonString(
  Schema.Struct({
    pages: DocumentSource.fields.pages,
    supportingVisuals: Schema.Array(
      Schema.Struct({ base64: Schema.String, contentId: ContentId }),
    ).check(Schema.isMaxLength(20)),
  }),
);

const RendererOutput = Schema.fromJsonString(
  Schema.Struct({
    renderedPageCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20)),
  }),
);

const decodeAttemptEvidenceBoundary = Schema.decodeSync(AttemptEvidenceMetadata);
const encodeAttemptEvidence = Schema.encodeSync(AttemptEvidenceMetadata);
const decodeRenderedPageCount = (output: string) =>
  Schema.decodeSync(RendererOutput)(output.trim()).renderedPageCount;

// oxlint-disable-next-line effecttsgo/async-function -- ReadableStream is a Promise-based boundary.
const readBounded = async (stream: ReadableStream<Uint8Array>, size: number) => {
  const bytes = new Uint8Array(size);
  const reader = stream.getReader();
  let offset = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A stream must be consumed in order.
    const next = await reader.read();
    if (next.done) break;
    if (offset + next.value.byteLength > size) throw new Error("Sandbox file exceeded its size");
    bytes.set(next.value, offset);
    offset += next.value.byteLength;
  }
  if (offset !== size) throw new Error("Sandbox file did not match its size");
  return bytes;
};

const encodeBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};

const incurred = (
  allowancePeriodId: AllowancePeriodId,
  providerOperationId: string,
  conservativeVendorUsdMicros: bigint,
) => ({
  _tag: "Incurred" as const,
  allowancePeriodId,
  basis: "conservative" as const,
  providerOperationId,
  usdMicros: conservativeVendorUsdMicros,
});

const interrupted = (cost: ActiveAttemptEvidence["cost"], evidence: string): ComputeResult => ({
  _tag: "Interrupted",
  cost,
  evidence,
});

/** Construct durable R2-backed execution identity evidence. */
export const makeAttemptEvidenceStore = (bucket: R2Bucket): AttemptEvidenceStore => ({
  // oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-based boundary.
  claim: async (contentId, intentDigest, cost, executionLeaseExpiresAt, userId, qualification) => {
    await DocumentOwnershipIndex.ensure(bucket, userId, contentId);
    const key = attemptKeyFor(contentId);
    const proposed = qualificationAttemptEvidence(
      {
        cost,
        executionLeaseExpiresAt,
        intentDigest,
        renderedPageCount: null,
        status: "claimed" as const,
        userId,
      },
      contentId,
      qualification,
    );
    const created = await bucket.put(key, new Uint8Array(), {
      customMetadata: { osfo: encodeAttemptEvidence(proposed) },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (created !== null) {
      return {
        _tag: "Claimed",
        created: true,
        evidence: proposed,
        revision: created.etag,
      };
    }
    const existing = await bucket.head(key);
    const encoded = existing?.customMetadata?.osfo;
    if (existing === null || encoded === undefined) {
      throw new Error("Durable document attempt evidence is missing");
    }
    const evidence = decodeAttemptEvidence(encoded);
    if (evidence.status === "discarded") {
      await bucket.delete(ownerKeyFor(userId, contentId));
      return evidence.userId === userId ? { _tag: "Discarded" } : { _tag: "IntentConflict" };
    }
    if (evidence.status === "notRequired") {
      return evidence.intentDigest === intentDigest &&
        evidence.userId === userId &&
        sameQualificationIdentity(evidence.qualification, proposed.qualification)
        ? { _tag: "Terminal", evidence }
        : { _tag: "IntentConflict" };
    }
    if (
      evidence.intentDigest !== intentDigest ||
      evidence.userId !== userId ||
      !sameQualificationAttempt(evidence, proposed)
    ) {
      return { _tag: "IntentConflict" };
    }
    if (evidence.status === "failed") {
      return { _tag: "Terminal", evidence };
    }
    return {
      _tag: "Claimed",
      created: false,
      evidence,
      revision: existing.etag,
    };
  },
  // oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-based boundary.
  complete: async (contentId, evidence, revision) => {
    const completed = await bucket.put(attemptKeyFor(contentId), new Uint8Array(), {
      customMetadata: { osfo: encodeAttemptEvidence(evidence) },
      onlyIf: { etagMatches: revision },
    });
    return completed !== null;
  },
  // oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-based boundary.
  fail: async (contentId, evidence, revision) => {
    const failed = await bucket.put(attemptKeyFor(contentId), new Uint8Array(), {
      customMetadata: { osfo: encodeAttemptEvidence(evidence) },
      onlyIf: { etagMatches: revision },
    });
    return failed !== null;
  },
  // oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-based boundary.
  inspect: async (contentId) => {
    const existing = await bucket.head(attemptKeyFor(contentId));
    if (existing === null) return null;
    const encoded = existing.customMetadata?.osfo;
    if (encoded === undefined) throw new Error("Durable document attempt evidence is missing");
    return decodeAttemptEvidence(encoded);
  },
  // oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-based boundary.
  reclaim: async (contentId, evidence, revision) => {
    const reclaimed = await bucket.put(attemptKeyFor(contentId), new Uint8Array(), {
      customMetadata: { osfo: encodeAttemptEvidence(evidence) },
      onlyIf: { etagMatches: revision },
    });
    return reclaimed?.etag ?? null;
  },
  // oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-based boundary.
  start: async (contentId, evidence, revision) => {
    const started = await bucket.put(attemptKeyFor(contentId), new Uint8Array(), {
      customMetadata: { osfo: encodeAttemptEvidence(evidence) },
      onlyIf: { etagMatches: revision },
    });
    return started?.etag ?? null;
  },
});

const qualificationAttemptEvidence = (
  evidence: ActiveAttemptEvidence,
  contentId: ContentId,
  input: QualificationAttemptInput | undefined,
): ActiveAttemptEvidence => {
  if (input === undefined) return evidence;
  return transitionQualificationAttemptEvidence(
    {
      ...evidence,
      qualification: {
        artifactChecksum: `sha256:${"0".repeat(64)}`,
        claimedAtEpochMs: input.claimedAtEpochMs,
        completedAtEpochMs: null,
        contentId,
        context: input.context,
        evidenceVersion: "document-compute-attempt-v2",
        failedAtEpochMs: null,
        startedAtEpochMs: null,
        taskExecutionId: `document-compute:${contentId}`,
        taskOutcomeId: null,
        workflowId: input.workflowId,
      },
    },
    {},
  );
};

/** Recompute the body-authenticated identity after an owned CAS state transition. */
export const transitionQualificationAttemptEvidence = <Evidence extends ActiveAttemptEvidence>(
  evidence: Evidence,
  timestamps: {
    readonly completedAtEpochMs?: number;
    readonly failedAtEpochMs?: number;
    readonly startedAtEpochMs?: number;
  },
) => {
  const retained = evidence.qualification;
  if (retained === undefined) return evidence;
  const qualification = {
    ...retained,
    completedAtEpochMs: timestamps.completedAtEpochMs ?? retained.completedAtEpochMs,
    failedAtEpochMs: timestamps.failedAtEpochMs ?? retained.failedAtEpochMs,
    startedAtEpochMs: timestamps.startedAtEpochMs ?? retained.startedAtEpochMs,
    taskOutcomeId:
      evidence.status === "completed"
        ? `${retained.taskExecutionId}:completed`
        : evidence.status === "failed"
          ? `${retained.taskExecutionId}:failed`
          : retained.taskOutcomeId,
  };
  const { artifactChecksum: _artifactChecksum, ...qualificationContent } = qualification;
  return {
    ...evidence,
    qualification: {
      ...qualificationContent,
      artifactChecksum: qualificationChecksum({ ...evidence, qualification: qualificationContent }),
    },
  };
};

const sameQualificationAttempt = (
  existing: ActiveAttemptEvidence,
  proposed: ActiveAttemptEvidence,
) => {
  const left = existing.qualification;
  const right = proposed.qualification;
  if (left === undefined || right === undefined) return left === right;
  return (
    left.contentId === right.contentId &&
    left.evidenceVersion === right.evidenceVersion &&
    left.taskExecutionId === right.taskExecutionId &&
    left.workflowId === right.workflowId &&
    sameQualificationContext(left.context, right.context) &&
    existing.cost.allowancePeriodId === proposed.cost.allowancePeriodId &&
    existing.cost.basis === proposed.cost.basis &&
    existing.cost.usdMicros === proposed.cost.usdMicros
  );
};

const sameQualificationIdentity = (
  left: QualificationAttemptEvidence | undefined,
  right: QualificationAttemptEvidence | undefined,
) => {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.contentId === right.contentId &&
    left.evidenceVersion === right.evidenceVersion &&
    left.taskExecutionId === right.taskExecutionId &&
    left.workflowId === right.workflowId &&
    sameQualificationContext(left.context, right.context)
  );
};

const decodeAttemptEvidence = (encoded: string): AttemptEvidence => {
  const evidence = decodeAttemptEvidenceBoundary(encoded);
  if (evidence.status === "discarded") return evidence;
  if (evidence.status === "notRequired") {
    const { artifactChecksum, ...qualification } = evidence.qualification;
    if (
      artifactChecksum !== qualificationChecksum({ ...evidence, qualification }) ||
      qualification.taskOutcomeId !== `${qualification.taskExecutionId}:not-required`
    ) {
      throw new Error("Qualification no-compute evidence does not match its retained body");
    }
    return evidence;
  }
  if (evidence.status === "failed" && evidence.qualification === undefined) {
    throw new Error("Only qualification-owned Document Compute can retain terminal failure");
  }
  if (evidence.qualification === undefined) return evidence;
  const { artifactChecksum, ...qualification } = evidence.qualification;
  if (artifactChecksum !== qualificationChecksum({ ...evidence, qualification })) {
    throw new Error("Qualification document attempt checksum does not match its retained body");
  }
  const terminalTimes = [qualification.completedAtEpochMs, qualification.failedAtEpochMs].filter(
    (timestamp) => timestamp !== null,
  );
  const validStatus =
    (evidence.status === "claimed" &&
      qualification.startedAtEpochMs === null &&
      terminalTimes.length === 0 &&
      qualification.taskOutcomeId === null) ||
    ((evidence.status === "started" || evidence.status === "recovery") &&
      qualification.startedAtEpochMs !== null &&
      terminalTimes.length === 0 &&
      qualification.taskOutcomeId === null) ||
    (evidence.status === "completed" &&
      qualification.startedAtEpochMs !== null &&
      qualification.completedAtEpochMs !== null &&
      qualification.failedAtEpochMs === null &&
      qualification.taskOutcomeId === `${qualification.taskExecutionId}:completed`) ||
    (evidence.status === "failed" &&
      qualification.startedAtEpochMs !== null &&
      qualification.completedAtEpochMs === null &&
      qualification.failedAtEpochMs !== null &&
      qualification.taskOutcomeId === `${qualification.taskExecutionId}:failed`);
  if (!validStatus) {
    throw new Error("Qualification document attempt state does not match its retained timeline");
  }
  return evidence;
};

const qualificationNoComputeEvidence = (
  contentId: ContentId,
  userId: UserId,
  input: QualificationNoComputeInput,
): NoComputeAttemptEvidence => {
  const taskExecutionId = `document-compute:${contentId}`;
  const qualification = {
    claimedAtEpochMs: input.claimedAtEpochMs,
    completedAtEpochMs: null,
    contentId,
    context: input.context,
    evidenceVersion: "document-compute-attempt-v2" as const,
    failedAtEpochMs: null,
    startedAtEpochMs: null,
    taskExecutionId,
    taskOutcomeId: `${taskExecutionId}:not-required`,
    workflowId: input.workflowId,
  };
  const content = {
    cost: { _tag: "ProvenNoUse" as const },
    intentDigest: input.intentDigest,
    qualification,
    status: "notRequired" as const,
    userId,
  };
  return {
    ...content,
    qualification: {
      ...qualification,
      artifactChecksum: qualificationChecksum(content),
    },
  };
};

/**
 * Remove only proven no-use ownership after terminal cleanup. Recovery, started, and completed
 * attempts remain durable until the scheduled allowance reconciler has consumed their incurred cost.
 */
/* oxlint-disable eslint/no-await-in-loop -- Each CAS attempt must observe the revision produced by the preceding race. */
export const settleAttemptEvidenceForTerminalCleanup = (
  bucket: R2Bucket,
  contentId: ContentId,
  userId: UserId,
  qualification?: QualificationNoComputeInput,
) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- R2 ownership checks and deletion share one Promise boundary.
    try: async () => {
      const attemptKey = attemptKeyFor(contentId);
      const ownerKey = ownerKeyFor(userId, contentId);
      for (;;) {
        const [attempt, owner] = await Promise.all([
          bucket.head(attemptKey),
          bucket.head(ownerKey),
        ]);
        if (owner !== null) {
          const ownership = DocumentOwnershipIndex.decode(owner);
          if (
            Result.isFailure(ownership) ||
            ownership.success.userId !== userId ||
            ownership.success.contentId !== contentId
          ) {
            throw new Error("Document ownership marker does not match the canceled Workflow");
          }
        }
        if (attempt === null) {
          const terminalEvidence =
            qualification === undefined
              ? {
                  cost: { _tag: "ProvenNoUse" as const },
                  status: "discarded" as const,
                  userId,
                }
              : qualificationNoComputeEvidence(contentId, userId, qualification);
          const discarded = await bucket.put(attemptKey, new Uint8Array(), {
            customMetadata: {
              osfo: encodeAttemptEvidence(terminalEvidence),
            },
            onlyIf: { etagDoesNotMatch: "*" },
          });
          if (discarded === null) continue;
          if (qualification === undefined) await bucket.delete(ownerKey);
          return qualification === undefined ? ("discarded" as const) : ("notRequired" as const);
        }
        const encoded = attempt.customMetadata?.osfo;
        const evidence = encoded === undefined ? null : decodeAttemptEvidence(encoded);
        if (evidence === null || evidence.userId !== userId) {
          throw new Error("Document attempt ownership does not match the canceled Workflow");
        }
        if (
          evidence.status === "recovery" ||
          evidence.status === "started" ||
          evidence.status === "completed" ||
          evidence.status === "failed"
        ) {
          return "preserved" as const;
        }
        if (evidence.status === "notRequired") {
          if (
            qualification !== undefined &&
            (!sameQualificationContext(evidence.qualification.context, qualification.context) ||
              evidence.qualification.workflowId !== qualification.workflowId ||
              evidence.intentDigest !== qualification.intentDigest)
          ) {
            throw new Error("Qualification no-compute identity conflicts with terminal cleanup");
          }
          return "notRequired" as const;
        }
        if (evidence.status === "discarded") {
          await bucket.delete(ownerKey);
          return "discarded" as const;
        }
        if (evidence.qualification !== undefined) {
          if (
            qualification === undefined ||
            !sameQualificationContext(evidence.qualification.context, qualification.context) ||
            evidence.qualification.workflowId !== qualification.workflowId ||
            evidence.intentDigest !== qualification.intentDigest
          ) {
            throw new Error(
              "Document attempt qualification identity conflicts with terminal cleanup",
            );
          }
          // A durable claim is already producer truth, even before provider start. Do not replace
          // its original cost, claim timestamp, or execution identity with a no-work assertion.
          return "preserved" as const;
        }
        if (qualification !== undefined) {
          throw new Error(
            "Document attempt qualification identity conflicts with terminal cleanup",
          );
        }
        const terminalEvidence =
          qualification === undefined
            ? {
                cost: { _tag: "ProvenNoUse" as const },
                status: "discarded" as const,
                userId,
              }
            : qualificationNoComputeEvidence(contentId, userId, qualification);
        const discarded = await bucket.put(attemptKey, new Uint8Array(), {
          customMetadata: {
            osfo: encodeAttemptEvidence(terminalEvidence),
          },
          onlyIf: { etagMatches: attempt.etag },
        });
        if (discarded !== null) {
          await bucket.delete(ownerKey);
          return qualification === undefined ? ("discarded" as const) : ("notRequired" as const);
        }
        // A compute claimant won the revision race. Re-read before deciding whether evidence is
        // incurred and must be retained, or remains an unused claim that can be tombstoned.
      }
    },
    catch: (cause) =>
      new DocumentAttemptEvidenceUnavailable({
        cause,
        message: "R2 document attempt cleanup could not prove and settle owned evidence",
      }),
  });
/* oxlint-enable eslint/no-await-in-loop */

const reconciliationCheckpointKey = "document-reconciliation/checkpoint";

/** Read one bounded batch of incurred document costs for idempotent scheduled reconciliation. */
export const readReconciliationBatch = (bucket: R2Bucket) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- R2 list is a Promise-based boundary.
    try: async () => {
      const checkpoint = await bucket.get(reconciliationCheckpointKey);
      const startAfter = checkpoint === null ? undefined : await checkpoint.text();
      const listed = await bucket.list(
        startAfter === undefined
          ? {
              include: ["customMetadata"],
              limit: 100,
              prefix: "document-attempts/",
            }
          : {
              include: ["customMetadata"],
              limit: 100,
              prefix: "document-attempts/",
              startAfter,
            },
      );
      const costs = listed.objects.flatMap((object) => {
        const encoded = object.customMetadata?.osfo;
        if (encoded === undefined) return [];
        const evidence = decodeAttemptEvidence(encoded);
        return evidence.status === "recovery" ||
          evidence.status === "started" ||
          evidence.status === "completed"
          ? [evidence.cost]
          : [];
      });
      const last = listed.objects.at(-1)?.key;
      return {
        checkpoint: listed.truncated && last !== undefined ? last : null,
        costs,
      };
    },
    catch: (cause) =>
      new DocumentAttemptEvidenceUnavailable({
        cause,
        message: "R2 document attempt reconciliation could not read durable evidence",
      }),
  });

/** Advance reconciliation only after every cost in the batch was recorded successfully. */
export const advanceReconciliation = (bucket: R2Bucket, checkpoint: string | null) =>
  Effect.tryPromise({
    try: () =>
      checkpoint === null
        ? bucket.delete(reconciliationCheckpointKey)
        : bucket.put(reconciliationCheckpointKey, checkpoint).then(() => undefined),
    catch: (cause) =>
      new DocumentAttemptEvidenceUnavailable({
        cause,
        message: "R2 document attempt reconciliation could not advance its checkpoint",
      }),
  });

export * as DocumentCompute from "./document-compute";
