import type { Sandbox } from "@cloudflare/sandbox";
import { Clock, Effect, Random, Schema } from "effect";

import { AllowancePeriodId, UserId } from "../../domain";
import type { ContentId } from "../../domain/client-content";
import { DocumentArtifact } from "../../domain/document-artifact";
import {
  ArtifactCleanupUnavailable,
  ArtifactComputeInterrupted,
  ArtifactIntentConflict,
  ArtifactIntentDigest,
  type ArtifactIntent,
  type ArtifactInspection,
  type ComputeResult,
  type CostEvidence,
  type DisposableCompute,
} from "../../services/artifact-generation";
import { artifactAttemptKeyFor, artifactAttemptPrefix } from "./document-storage-keys";

/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/async-function -- Tagged unions and Promise adapters are owned at this external boundary. */

export class ArtifactAttemptEvidenceUnavailable extends Schema.TaggedError<ArtifactAttemptEvidenceUnavailable>()(
  "ArtifactAttemptEvidenceUnavailable",
  { cause: Schema.Defect(), message: Schema.String },
) {}

export interface SandboxClient {
  readonly destroy: () => Promise<void>;
  readonly exec: (
    command: string,
    options: { readonly timeout: number },
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly success: boolean }>;
  readonly readStream: (
    path: string,
  ) => Promise<{ readonly content: ReadableStream<Uint8Array>; readonly size: number }>;
  readonly writeFile: (path: string, content: string | ReadableStream<Uint8Array>) => Promise<void>;
}

export interface ImageProvider {
  readonly generate: (
    source: Extract<ArtifactIntent, { readonly _tag: "Image" }>["source"],
  ) => Promise<Uint8Array>;
}

interface AttemptEvidence {
  readonly cost: CostEvidence;
  readonly executionLeaseExpiresAt: number;
  readonly intentDigest: ArtifactIntentDigest;
  readonly status: "claimed" | "started" | "completed";
  readonly userId: UserId;
}

export interface AttemptStore {
  readonly claim: (
    contentId: ContentId,
    evidence: AttemptEvidence,
  ) => Promise<
    | { readonly _tag: "Claimed"; readonly evidence: AttemptEvidence }
    | { readonly _tag: "Existing"; readonly evidence: AttemptEvidence }
  >;
  readonly complete: (contentId: ContentId, evidence: AttemptEvidence) => Promise<void>;
  readonly inspect: (contentId: ContentId) => Promise<AttemptEvidence | null>;
  readonly start: (contentId: ContentId, evidence: AttemptEvidence) => Promise<boolean>;
}

const executionLeaseMs = 10 * 60_000;
const maximumComputeInputBytes = 25_000_000;
const defaultDeadlines = { cleanupMs: 30_000, execMs: 65_000, rpcMs: 30_000 };

interface Deadlines {
  readonly cleanupMs: number;
  readonly execMs: number;
  readonly rpcMs: number;
}

/** Construct the adapter at its Sandbox and provider seams for deterministic tests. */
export const makeWithPorts = (
  sandboxFor: (contentId: ContentId) => SandboxClient,
  attempts: AttemptStore,
  images: ImageProvider,
  conservativeVendorUsdMicros: bigint,
  deadlines: Deadlines = defaultDeadlines,
): DisposableCompute => ({
  dispose: (contentId) =>
    Effect.tryPromise({
      try: () => withDeadline(sandboxFor(contentId).destroy(), deadlines.cleanupMs),
      catch: (cause) =>
        new ArtifactCleanupUnavailable({
          cause,
          contentId,
          message: "Disposable artifact Sandbox cleanup could not be confirmed",
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
          images,
          conservativeVendorUsdMicros,
          input,
          `artifact:${input.contentId}:${high.toString(16)}${low.toString(16)}`,
          () => clock.currentTimeMillisUnsafe(),
          deadlines,
        ),
      );
    }),
  inspect: (contentId, intentDigest) =>
    Effect.tryPromise({
      try: () => attempts.inspect(contentId),
      catch: () =>
        new ArtifactComputeInterrupted({
          contentId,
          evidence: "Durable artifact attempt evidence could not be inspected",
          message: "Artifact attempt recovery is unavailable",
        }),
    }).pipe(
      Effect.flatMap((evidence) => {
        if (evidence === null) return Effect.succeed(null);
        if (evidence.intentDigest !== intentDigest) {
          return Effect.fail(
            new ArtifactIntentConflict({
              contentId,
              message: "The owning identity already names a different artifact attempt",
            }),
          );
        }
        if (evidence.cost._tag === "ProvenNoUse") return Effect.succeed(null);
        return Effect.succeed({ cost: evidence.cost, intentDigest });
      }),
    ),
});

// oxlint-disable-next-line effecttsgo/async-function -- Sandbox and Workers AI are Promise boundaries.
const render = async (
  sandbox: SandboxClient,
  attempts: AttemptStore,
  images: ImageProvider,
  conservativeVendorUsdMicros: bigint,
  input: {
    readonly allowancePeriodId: AllowancePeriodId;
    readonly contentId: ContentId;
    readonly intent: ArtifactIntent;
    readonly intentDigest: ArtifactIntentDigest;
    readonly sourceArtifact: Uint8Array | null;
    readonly supportingVisuals: ReadonlyArray<{
      readonly bytes: Uint8Array;
      readonly contentId: ContentId;
    }>;
    readonly userId: UserId;
  },
  providerOperationId: string,
  currentTimeMillis: () => number,
  deadlines: Deadlines,
): Promise<ComputeResult> => {
  const cost = incurred(input.allowancePeriodId, providerOperationId, conservativeVendorUsdMicros);
  const proposed: AttemptEvidence = {
    cost: { _tag: "ProvenNoUse" },
    executionLeaseExpiresAt: currentTimeMillis() + executionLeaseMs,
    intentDigest: input.intentDigest,
    status: "claimed",
    userId: input.userId,
  };
  try {
    const claimed = await attempts.claim(input.contentId, proposed);
    if (
      claimed.evidence.intentDigest !== input.intentDigest ||
      claimed.evidence.userId !== input.userId
    ) {
      return { _tag: "IntentConflict", cost: { _tag: "ProvenNoUse" } };
    }
    if (claimed._tag === "Existing") {
      if (
        claimed.evidence.status !== "completed" &&
        claimed.evidence.executionLeaseExpiresAt > currentTimeMillis()
      ) {
        return {
          _tag: "AttemptPending",
          cost: claimed.evidence.cost,
          evidence: "Another caller owns the live artifact execution lease",
        };
      }
      if (claimed.evidence.status !== "claimed") {
        return interrupted(
          claimed.evidence.cost,
          "A prior artifact attempt has no retained verified terminal result",
        );
      }
    }

    const inputBytes =
      (input.sourceArtifact?.byteLength ?? 0) +
      input.supportingVisuals.reduce((total, visual) => total + visual.bytes.byteLength, 0);
    if (inputBytes > maximumComputeInputBytes) {
      return interrupted({ _tag: "ProvenNoUse" }, "Immutable artifact inputs exceed 25 MB");
    }

    const started = await attempts.start(input.contentId, {
      ...proposed,
      cost,
      status: "started",
    });
    if (!started) {
      return {
        _tag: "AttemptPending",
        cost: { _tag: "ProvenNoUse" },
        evidence: "Another caller changed the artifact execution claim",
      };
    }

    const extension = input.intent._tag === "Presentation" ? "pptx" : "png";
    const outputPath = `/workspace/artifact-${input.intentDigest}.${extension}`;
    const sourcePath = `/workspace/source-${input.intentDigest}.json`;
    const sourcePresentationPath = `/workspace/source-${input.intentDigest}.pptx`;
    const providerImage =
      input.intent._tag === "Image"
        ? await withDeadline(images.generate(input.intent.source), deadlines.rpcMs)
        : null;
    const envelope = {
      providerImageBase64: providerImage === null ? undefined : encodeBase64(providerImage),
      source: input.intent.source,
      supportingVisuals: input.supportingVisuals.map(({ bytes, contentId }) => ({
        base64: encodeBase64(bytes),
        contentId,
      })),
    };
    await withDeadline(sandbox.writeFile(sourcePath, JSON.stringify(envelope)), deadlines.rpcMs);
    if (input.sourceArtifact !== null) {
      await withDeadline(
        sandbox.writeFile(sourcePresentationPath, streamBytes(input.sourceArtifact)),
        deadlines.rpcMs,
      );
    }
    const kind = input.intent._tag.toLocaleLowerCase("en");
    const revisionArgument =
      input.sourceArtifact === null ? "" : ` --source-presentation ${sourcePresentationPath}`;
    const command =
      `python3 /opt/osfo/render_artifact.py --kind ${kind} --input ${sourcePath} --output ${outputPath}` +
      revisionArgument;
    const result = await withDeadline(sandbox.exec(command, { timeout: 60_000 }), deadlines.execMs);
    if (!result.success) {
      return interrupted(cost, `The artifact renderer exited with code ${result.exitCode}`);
    }
    const inspection = decodeInspection(result.stdout);
    const file = await withDeadline(sandbox.readStream(outputPath), deadlines.rpcMs);
    const maximumBytes =
      input.intent._tag === "Presentation"
        ? DocumentArtifact.maximumPresentationBytes
        : DocumentArtifact.maximumImageBytes;
    if (file.size > maximumBytes) return { _tag: "RejectedOversize", cost, size: file.size };
    const bytes = await withDeadline(readBounded(file.content, file.size), deadlines.rpcMs);
    await withDeadline(
      attempts.complete(input.contentId, { ...proposed, cost, status: "completed" }),
      deadlines.rpcMs,
    );
    return { _tag: "Completed", bytes, cost, inspection };
  } catch {
    return interrupted(
      cost,
      "Disposable artifact compute stopped before verified output was available",
    );
  }
};

const Inspection = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      issues: Schema.Array(Schema.String),
      kind: Schema.Literal("presentation"),
      renderedSlideCount: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
    Schema.Struct({
      height: Schema.Int.check(Schema.isGreaterThan(0)),
      kind: Schema.Literal("visual"),
      width: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  ]),
);

const decodeInspection = (output: string): ArtifactInspection => {
  const decoded = Schema.decodeSync(Inspection)(output.trim());
  return decoded.kind === "presentation"
    ? {
        _tag: "Presentation",
        issues: decoded.issues,
        renderedSlideCount: decoded.renderedSlideCount,
      }
    : { _tag: "Visual", height: decoded.height, width: decoded.width };
};

const AttemptMetadata = Schema.fromJsonString(
  Schema.Struct({
    cost: Schema.Union([
      Schema.TaggedStruct("ProvenNoUse", {}),
      Schema.TaggedStruct("Incurred", {
        allowancePeriodId: AllowancePeriodId,
        basis: Schema.Literals(["conservative", "observed"]),
        providerOperationId: Schema.String,
        usdMicros: Schema.BigIntFromString,
      }),
    ]),
    executionLeaseExpiresAt: Schema.Int,
    intentDigest: ArtifactIntentDigest,
    status: Schema.Literals(["claimed", "started", "completed"]),
    userId: UserId,
  }),
);

export const makeAttemptStore = (bucket: R2Bucket): AttemptStore => ({
  claim: async (contentId, evidence) => {
    const key = artifactAttemptKeyFor(contentId);
    const created = await bucket.put(key, new Uint8Array(), {
      customMetadata: { osfo: Schema.encodeSync(AttemptMetadata)(evidence) },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (created !== null) return { _tag: "Claimed", evidence };
    const existing = await bucket.head(key);
    if (existing?.customMetadata?.osfo === undefined) throw new Error("attempt metadata missing");
    return {
      _tag: "Existing",
      evidence: decodeAttempt(existing.customMetadata.osfo),
    };
  },
  complete: async (contentId, evidence) => {
    const key = artifactAttemptKeyFor(contentId);
    const current = await bucket.head(key);
    if (current === null) throw new Error("attempt evidence missing");
    const encoded = current.customMetadata?.osfo;
    if (encoded === undefined || !sameAttempt(decodeAttempt(encoded), evidence, "started")) {
      throw new Error("attempt evidence changed");
    }
    const completed = await bucket.put(key, new Uint8Array(), {
      customMetadata: { osfo: Schema.encodeSync(AttemptMetadata)(evidence) },
      onlyIf: { etagMatches: current.etag },
    });
    if (completed === null) throw new Error("attempt evidence changed");
  },
  inspect: async (contentId) => {
    const object = await bucket.head(artifactAttemptKeyFor(contentId));
    if (object === null) return null;
    if (object.customMetadata?.osfo === undefined) throw new Error("attempt metadata missing");
    return decodeAttempt(object.customMetadata.osfo);
  },
  start: async (contentId, evidence) => {
    const key = artifactAttemptKeyFor(contentId);
    const current = await bucket.head(key);
    if (current === null) throw new Error("attempt evidence missing");
    const decoded = current.customMetadata?.osfo;
    if (decoded === undefined || !sameAttempt(decodeAttempt(decoded), evidence, "claimed")) {
      return false;
    }
    const started = await bucket.put(key, new Uint8Array(), {
      customMetadata: { osfo: Schema.encodeSync(AttemptMetadata)(evidence) },
      onlyIf: { etagMatches: current.etag },
    });
    return started !== null;
  },
});

const decodeAttempt = (encoded: string): AttemptEvidence => {
  const decoded = Schema.decodeSync(AttemptMetadata)(encoded);
  return decoded;
};

const sameAttempt = (
  current: AttemptEvidence,
  proposed: AttemptEvidence,
  expectedStatus: AttemptEvidence["status"],
) =>
  current.status === expectedStatus &&
  current.intentDigest === proposed.intentDigest &&
  current.userId === proposed.userId &&
  (expectedStatus === "claimed" ||
    (current.cost._tag === proposed.cost._tag &&
      current.cost._tag === "Incurred" &&
      proposed.cost._tag === "Incurred" &&
      current.cost.providerOperationId === proposed.cost.providerOperationId));

const reconciliationCheckpointKey = "artifact-reconciliation/checkpoint";

/** Read one bounded batch of incurred visual-artifact costs for scheduled reconciliation. */
export const readReconciliationBatch = (bucket: R2Bucket) =>
  Effect.tryPromise({
    try: async () => {
      const checkpoint = await bucket.get(reconciliationCheckpointKey);
      const startAfter = checkpoint === null ? undefined : await checkpoint.text();
      const listed = await bucket.list(
        startAfter === undefined
          ? { include: ["customMetadata"], limit: 100, prefix: artifactAttemptPrefix }
          : {
              include: ["customMetadata"],
              limit: 100,
              prefix: artifactAttemptPrefix,
              startAfter,
            },
      );
      const costs = listed.objects.flatMap((object) => {
        const encoded = object.customMetadata?.osfo;
        if (encoded === undefined) return [];
        const evidence = decodeAttempt(encoded);
        return evidence.cost._tag === "Incurred" ? [evidence.cost] : [];
      });
      const last = listed.objects.at(-1)?.key;
      return { checkpoint: listed.truncated && last !== undefined ? last : null, costs };
    },
    catch: (cause) =>
      new ArtifactAttemptEvidenceUnavailable({
        cause,
        message: "R2 artifact attempt reconciliation could not read durable evidence",
      }),
  });

/** Advance reconciliation only after every artifact cost was recorded. */
export const advanceReconciliation = (bucket: R2Bucket, checkpoint: string | null) =>
  Effect.tryPromise({
    try: () =>
      checkpoint === null
        ? bucket.delete(reconciliationCheckpointKey)
        : bucket.put(reconciliationCheckpointKey, checkpoint).then(() => undefined),
    catch: (cause) =>
      new ArtifactAttemptEvidenceUnavailable({
        cause,
        message: "R2 artifact attempt reconciliation could not advance its checkpoint",
      }),
  });

export const workersAiImageProvider = (ai: Ai): ImageProvider => ({
  generate: async (source) => {
    const result = await ai.run("@cf/bytedance/stable-diffusion-xl-lightning", {
      height: source.height,
      num_steps: 4,
      prompt: source.prompt,
      width: source.width,
    });
    return readBounded(result, DocumentArtifact.maximumImageBytes);
  },
});

export const adaptSandbox = (sandbox: Sandbox): SandboxClient => ({
  destroy: () => sandbox.destroy(),
  exec: (command, options) => sandbox.exec(command, options),
  readStream: (path) => sandbox.readFile(path, { encoding: "none" }),
  writeFile: (path, content) => sandbox.writeFile(path, content).then(() => undefined),
});

const withDeadline = <Value>(operation: Promise<Value>, timeoutMs: number) =>
  Effect.runPromise(Effect.promise(() => operation).pipe(Effect.timeout(timeoutMs)));

const streamBytes = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

// oxlint-disable-next-line effecttsgo/async-function -- ReadableStream is a Promise boundary.
const readBounded = async (stream: ReadableStream<Uint8Array>, maximum: number) => {
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Streams must be read in order.
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maximum) throw new Error("stream exceeded its bounded size");
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
  usdMicros: bigint,
) => ({
  _tag: "Incurred" as const,
  allowancePeriodId,
  basis: "conservative" as const,
  providerOperationId,
  usdMicros,
});

const interrupted = (cost: CostEvidence, evidence: string): ComputeResult => ({
  _tag: "Interrupted",
  cost,
  evidence,
});

export * as ArtifactCompute from "./artifact-compute";
