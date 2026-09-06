import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Clock, Effect, Random, Result, Schema } from "effect";

import { ContentId } from "../../domain/client-content";
import { AllowancePeriodId, UserId } from "../../domain";
import { DocumentArtifact } from "../../domain/document-artifact";
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
  readonly status: "claimed" | "recovery" | "started" | "completed";
  readonly userId?: UserId;
}

export interface DiscardedAttemptEvidence {
  readonly cost: Extract<CostEvidence, { _tag: "ProvenNoUse" }>;
  readonly status: "discarded";
  readonly userId: UserId;
}

export type AttemptEvidence = ActiveAttemptEvidence | DiscardedAttemptEvidence;

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
  ) => Promise<
    | {
        readonly _tag: "Claimed";
        readonly created: boolean;
        readonly evidence: ActiveAttemptEvidence;
        readonly revision: string;
      }
    | { readonly _tag: "Discarded" }
    | { readonly _tag: "IntentConflict" }
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

/** Durable render ownership must expire before another invocation can reclaim it. */
export const documentExecutionLeaseMs = 10 * 60_000;
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
        if (evidence.status === "discarded") return Effect.succeed(null);
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
    const claimed = await attempts.claim(
      input.contentId,
      input.intentDigest,
      proposedCost,
      currentTimeMillis() + documentExecutionLeaseMs,
      input.userId,
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
        const completedEvidence = {
          ...claimed.evidence,
          renderedPageCount: input.source.pages.length,
          status: "completed" as const,
        };
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
        const reclaimedEvidence = {
          ...claimed.evidence,
          executionLeaseExpiresAt: currentTimeMillis() + documentExecutionLeaseMs,
          renderedPageCount: null,
          status: "recovery" as const,
        };
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
      const started = await attempts.start(
        input.contentId,
        { ...evidence, status: "started" },
        revision,
      );
      if (started === null) {
        return {
          _tag: "AttemptPending",
          cost: recoveringIncurredAttempt ? cost : { _tag: "ProvenNoUse" },
          evidence: "Another caller owns the atomic Sandbox execution transition",
        };
      }
      evidence = { ...evidence, status: "started" };
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
        return interrupted(cost, `The document renderer exited with code ${result.exitCode}`);
      }
      renderedPageCount = decodeRenderedPageCount(result.stdout);
      const completionAuthorizationFailure = await authorizeWrite();
      if (completionAuthorizationFailure !== null) {
        return { _tag: "AuthorizationFailure", cost, failure: completionAuthorizationFailure };
      }
      const completed = await withDeadline(
        attempts.complete(
          input.contentId,
          { ...evidence, renderedPageCount, status: "completed" },
          revision,
        ),
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
      cost: Schema.TaggedStruct("Incurred", {
        allowancePeriodId: AllowancePeriodId,
        basis: Schema.Literals(["conservative", "observed"]),
        providerOperationId: Schema.String.check(Schema.isMinLength(1)),
        usdMicros: Schema.BigIntFromString,
      }),
      executionLeaseExpiresAt: Schema.Int,
      intentDigest: DocumentIntentDigest,
      renderedPageCount: Schema.NullOr(
        Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(20)),
      ),
      status: Schema.Literals(["claimed", "recovery", "started", "completed"]),
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

const decodeAttemptEvidence = Schema.decodeSync(AttemptEvidenceMetadata);
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
  claim: async (contentId, intentDigest, cost, executionLeaseExpiresAt, userId) => {
    await DocumentOwnershipIndex.ensure(bucket, userId, contentId);
    const key = attemptKeyFor(contentId);
    const proposed = {
      cost,
      executionLeaseExpiresAt,
      intentDigest,
      renderedPageCount: null,
      status: "claimed" as const,
      userId,
    };
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
    if (evidence.intentDigest !== intentDigest) {
      return { _tag: "IntentConflict" };
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

/**
 * Remove only proven no-use ownership after terminal cleanup. Recovery, started, and completed
 * attempts remain durable until the scheduled allowance reconciler has consumed their incurred cost.
 */
/* oxlint-disable eslint/no-await-in-loop -- Each CAS attempt must observe the revision produced by the preceding race. */
export const settleAttemptEvidenceForTerminalCleanup = (
  bucket: R2Bucket,
  contentId: ContentId,
  userId: UserId,
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
          const discarded = await bucket.put(attemptKey, new Uint8Array(), {
            customMetadata: {
              osfo: encodeAttemptEvidence({
                cost: { _tag: "ProvenNoUse" },
                status: "discarded",
                userId,
              }),
            },
            onlyIf: { etagDoesNotMatch: "*" },
          });
          if (discarded === null) continue;
          await bucket.delete(ownerKey);
          return "discarded" as const;
        }
        const encoded = attempt.customMetadata?.osfo;
        const evidence = encoded === undefined ? null : decodeAttemptEvidence(encoded);
        if (evidence === null || evidence.userId !== userId) {
          throw new Error("Document attempt ownership does not match the canceled Workflow");
        }
        if (
          evidence.status === "recovery" ||
          evidence.status === "started" ||
          evidence.status === "completed"
        ) {
          return "preserved" as const;
        }
        if (evidence.status === "discarded") {
          await bucket.delete(ownerKey);
          return "discarded" as const;
        }
        const discarded = await bucket.put(attemptKey, new Uint8Array(), {
          customMetadata: {
            osfo: encodeAttemptEvidence({
              cost: { _tag: "ProvenNoUse" },
              status: "discarded",
              userId,
            }),
          },
          onlyIf: { etagMatches: attempt.etag },
        });
        if (discarded !== null) {
          await bucket.delete(ownerKey);
          return "discarded" as const;
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
