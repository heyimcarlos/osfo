import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Clock, Effect, Random, Schema } from "effect";

import type { ContentId } from "../../domain/client-content";
import { AllowancePeriodId } from "../../domain";
import * as DocumentArtifact from "../../domain/document-artifact";
import {
  DocumentSource,
  DocumentCleanupUnavailable,
  DocumentComputeInterrupted,
  DocumentIntentDigest,
  DocumentIntentConflict,
  type CostEvidence,
  type ComputeResult,
  type DisposableCompute,
} from "../../services/document-generation";
import { attemptKeyFor } from "./document-storage-keys";

export interface AttemptEvidence {
  readonly cost: Extract<CostEvidence, { _tag: "Incurred" }>;
  readonly executionLeaseExpiresAt: number;
  /** Digest of the immutable document intent that owns this attempt. */
  readonly intentDigest: DocumentIntentDigest;
  readonly renderedPageCount: number | null;
  readonly status: "claimed" | "started" | "completed";
}

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
    cost: AttemptEvidence["cost"],
    executionLeaseExpiresAt: number,
  ) => Promise<
    | {
        readonly _tag: "Claimed";
        readonly created: boolean;
        readonly evidence: AttemptEvidence;
        readonly revision: string;
      }
    | { readonly _tag: "IntentConflict" }
  >;
  readonly complete: (
    contentId: ContentId,
    evidence: AttemptEvidence & {
      readonly renderedPageCount: number;
      readonly status: "completed";
    },
  ) => Promise<void>;
  readonly inspect: (contentId: ContentId) => Promise<AttemptEvidence | null>;
  readonly start: (
    contentId: ContentId,
    evidence: AttemptEvidence & { readonly status: "started" },
    revision: string,
  ) => Promise<boolean>;
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
        getSandbox(binding, contentId, {
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
      const [high, low] = yield* Effect.all([Random.next, Random.next]);
      return yield* Effect.promise(() =>
        render(
          sandboxFor(input.contentId),
          attempts,
          conservativeVendorUsdMicros,
          input,
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
  },
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
    const proposedCost = incurred(
      input.allowancePeriodId,
      providerOperationId,
      conservativeVendorUsdMicros,
    );
    const claimed = await attempts.claim(
      input.contentId,
      input.intentDigest,
      proposedCost,
      currentTimeMillis() + executionLeaseMs,
    );
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Persisted outcomes use _tag.
    if (claimed._tag === "IntentConflict") {
      return { _tag: "IntentConflict", cost: { _tag: "ProvenNoUse" } };
    }
    durableAttemptClaimed = true;
    providerOperationId = claimed.evidence.cost.providerOperationId;
    const cost = claimed.evidence.cost;
    let renderedPageCount = claimed.evidence.renderedPageCount;
    if (!claimed.created && claimed.evidence.status === "started") {
      return claimed.evidence.executionLeaseExpiresAt > currentTimeMillis()
        ? {
            _tag: "AttemptPending",
            cost,
            evidence: "Another caller owns the live Sandbox execution lease",
          }
        : interrupted(cost, "The prior Sandbox execution has no verified terminal result");
    }

    if (claimed.evidence.status === "claimed") {
      if (!claimed.created) {
        return {
          _tag: "AttemptPending",
          cost,
          evidence: "Another caller owns the durable Sandbox execution transition",
        };
      }
      const started = await attempts.start(
        input.contentId,
        { ...claimed.evidence, status: "started" },
        claimed.revision,
      );
      if (!started) {
        return {
          _tag: "AttemptPending",
          cost,
          evidence: "Another caller owns the atomic Sandbox execution transition",
        };
      }
    }
    if (claimed.evidence.executionLeaseExpiresAt - currentTimeMillis() < minimumProtectedWindowMs) {
      return {
        _tag: "AttemptPending",
        cost,
        evidence: "The durable execution lease has insufficient time for bounded Sandbox use",
      };
    }
    providerUsePossible = true;

    const cachedOutput = await withDeadline(sandbox.exists(outputPath), deadlines.rpcMs);
    if (!claimed.created && renderedPageCount !== null && !cachedOutput.exists) {
      return interrupted(
        cost,
        "Completed compute evidence exists but its Sandbox output is unavailable",
      );
    }
    if (renderedPageCount === null) {
      await withDeadline(
        sandbox.writeFile(
          sourcePath,
          Schema.encodeSync(Schema.fromJsonString(DocumentSource))(input.source),
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
      await withDeadline(
        attempts.complete(input.contentId, {
          ...claimed.evidence,
          renderedPageCount,
          status: "completed",
        }),
        deadlines.rpcMs,
      );
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
    status: Schema.Literals(["claimed", "started", "completed"]),
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

const interrupted = (cost: AttemptEvidence["cost"], evidence: string): ComputeResult => ({
  _tag: "Interrupted",
  cost,
  evidence,
});

/** Construct durable R2-backed execution identity evidence. */
export const makeAttemptEvidenceStore = (bucket: R2Bucket): AttemptEvidenceStore => ({
  // oxlint-disable-next-line effecttsgo/async-function -- R2 is a Promise-based boundary.
  claim: async (contentId, intentDigest, cost, executionLeaseExpiresAt) => {
    const key = attemptKeyFor(contentId);
    const proposed = {
      cost,
      executionLeaseExpiresAt,
      intentDigest,
      renderedPageCount: null,
      status: "claimed" as const,
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
  complete: async (contentId, evidence) => {
    await bucket.put(attemptKeyFor(contentId), new Uint8Array(), {
      customMetadata: { osfo: encodeAttemptEvidence(evidence) },
    });
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
  start: async (contentId, evidence, revision) => {
    const started = await bucket.put(attemptKeyFor(contentId), new Uint8Array(), {
      customMetadata: { osfo: encodeAttemptEvidence(evidence) },
      onlyIf: { etagMatches: revision },
    });
    return started !== null;
  },
});

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
        return evidence.status === "claimed" ? [] : [evidence.cost];
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
