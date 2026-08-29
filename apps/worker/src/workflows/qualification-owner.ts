import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";

import { qualificationAuthoritySources } from "../qualification/authority-sources";
import {
  QualificationProductAuthorityMissing,
  QualificationProductAuthorityPreflight,
  QualificationProductAuthoritySourceChunkComplete,
  QualificationProductAuthoritySourceChunkInvocation,
  QualificationProductAuthoritySourceChunkPending,
  type QualificationProductAuthorityInvocation,
  type QualificationProductAuthoritySourceChunkSource,
} from "../qualification/product-authority-contract";
import { qualificationChecksum } from "../qualification/qualification-checksum";
import type { QualificationOwnerWorkflowPayload } from "../workflow-contracts";
import { retainMissingQualificationReport } from "./qualification-owner-report";

/* oxlint-disable effecttsgo/async-function, eslint/no-await-in-loop, eslint/no-underscore-dangle -- Cloudflare Workflow APIs are Promise-only host boundaries; source polling must run as ordered, durable, uniquely named tagged steps. */

interface QualificationOwnerWorkflowEnv {
  readonly ARTIFACTS: R2Bucket;
  readonly PRODUCT_AUTHORITY: Fetcher;
}

const RetainedOwnerRequest = Schema.Struct({
  artifactChecksum: Schema.String,
  authoritySources: Schema.Array(Schema.String),
  cohortArtifactChecksum: Schema.String,
  cohortArtifactId: Schema.String,
  executionId: Schema.String,
  manifest: Schema.Unknown,
  manifestChecksum: Schema.String,
  plan: Schema.Unknown,
  planChecksum: Schema.String,
  protocolVersion: Schema.Literal("qualification-owner-v1"),
  shardRecordLimit: Schema.Literal(256),
});
const decodeRetainedOwnerRequest = Schema.decodeUnknownPromise(
  Schema.fromJsonString(RetainedOwnerRequest),
);

const decodePreflight = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthorityPreflight),
);
const decodeSourceComplete = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthoritySourceChunkComplete),
);
const decodeSourceMissing = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthorityMissing),
);
const decodeSourcePending = Schema.decodeUnknownPromise(
  Schema.fromJsonString(QualificationProductAuthoritySourceChunkPending),
);
const QualificationSourceCollectionStepResult = Schema.TaggedUnion({
  Complete: { outcome: QualificationProductAuthoritySourceChunkComplete },
  Missing: { outcome: QualificationProductAuthorityMissing },
  Pending: { outcome: QualificationProductAuthoritySourceChunkPending },
});
type QualificationSourceCollectionStepResult = typeof QualificationSourceCollectionStepResult.Type;
const decodeSourceStepResult = Schema.decodePromise(QualificationSourceCollectionStepResult);

const maximumSourceCollectionPolls = 100;

export interface QualificationSourceCollectionStep {
  readonly do: (
    name: string,
    callback: () => Promise<QualificationSourceCollectionStepResult>,
  ) => Promise<QualificationSourceCollectionStepResult>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

export type QualificationSourceCollectionOutcome =
  | typeof QualificationProductAuthorityMissing.Type
  | typeof QualificationProductAuthoritySourceChunkComplete.Type;

/** Poll one frozen source shard through its owning service without holding a Worker request open. */
export const collectQualificationSourceChunk = async (input: {
  readonly chunkIndex: number;
  readonly fetcher: Pick<Fetcher, "fetch">;
  readonly invocation: QualificationProductAuthorityInvocation;
  readonly runId: string;
  readonly source: QualificationProductAuthoritySourceChunkSource;
  readonly step: QualificationSourceCollectionStep;
  readonly streamChunkIndex: number;
}): Promise<QualificationSourceCollectionOutcome> => {
  let lastRetryAtEpochMs = -1;
  for (let attempt = 0; attempt < maximumSourceCollectionPolls; attempt += 1) {
    const result = await decodeSourceStepResult(
      await input.step.do(
        `collect ${input.source} chunk ${input.chunkIndex} attempt ${attempt + 1}`,
        async () => {
          const response = await input.fetcher.fetch(
            "https://qualification-product-authority.internal/v1/executions/source-chunks",
            {
              body: JSON.stringify(
                QualificationProductAuthoritySourceChunkInvocation.make({
                  ...input.invocation,
                  chunkIndex: input.chunkIndex,
                  runId: input.runId,
                  source: input.source,
                }),
              ),
              headers: { "content-type": "application/json" },
              method: "POST",
            },
          );
          if (response.status === 200) {
            return QualificationSourceCollectionStepResult.cases.Complete.make({
              outcome: await decodeSourceComplete(await response.text()),
            });
          }
          if (response.status === 424) {
            return QualificationSourceCollectionStepResult.cases.Missing.make({
              outcome: await decodeSourceMissing(await response.text()),
            });
          }
          if (response.status === 202) {
            return QualificationSourceCollectionStepResult.cases.Pending.make({
              outcome: await decodeSourcePending(await response.text()),
            });
          }
          throw new Error(`Product authority source collection returned ${response.status}`);
        },
      ),
    );
    if (result._tag === "Complete") {
      if (
        result.outcome.source !== input.source ||
        result.outcome.streamChunkIndex !== input.streamChunkIndex
      ) {
        throw new Error("Product authority source completion conflicts with the frozen source");
      }
      return result.outcome;
    }
    if (result._tag === "Missing") {
      if (!result.outcome.missingSources.some(({ source }) => source === input.source)) {
        throw new Error("Product authority missing result conflicts with the frozen source");
      }
      return result.outcome;
    }
    const pending = result.outcome;
    if (pending.source !== input.source || pending.retryAtEpochMs <= lastRetryAtEpochMs) {
      throw new Error("Product authority source retry conflicts with the frozen source");
    }
    lastRetryAtEpochMs = pending.retryAtEpochMs;
    await input.step.sleepUntil(
      `wait for ${input.source} chunk ${input.chunkIndex} attempt ${attempt + 1}`,
      pending.retryAtEpochMs,
    );
  }
  return QualificationProductAuthorityMissing.make({
    missingSources: [
      {
        detail: `${input.source} did not settle within the bounded collector`,
        source: input.source,
      },
    ],
    status: "MISSING",
  });
};

/** Durable owner that records exact unavailable authority sources instead of inventing evidence. */
export class QualificationOwnerWorkflow extends WorkflowEntrypoint<
  QualificationOwnerWorkflowEnv,
  QualificationOwnerWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationOwnerWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{ readonly status: "MISSING" }> {
    const authoritySources = await step.do("validate frozen qualification request", async () => {
      const retained = await this.env.ARTIFACTS.get(event.payload.requestArtifactId);
      if (retained === null) throw new Error("Frozen qualification request is missing");
      const decoded = await decodeRetainedOwnerRequest(await retained.text());
      const { artifactChecksum, ...content } = decoded;
      if (
        artifactChecksum !== event.payload.requestArtifactChecksum ||
        artifactChecksum !== qualificationChecksum(content) ||
        decoded.executionId !== event.payload.executionId ||
        decoded.manifestChecksum !== event.payload.manifestChecksum ||
        decoded.planChecksum !== event.payload.planChecksum
      ) {
        throw new Error("Frozen qualification request conflicts with the Workflow identity");
      }
      return [...decoded.authoritySources];
    });
    const preflight = await step.do("attempt product authority sources", async () => {
      if (
        authoritySources.length !== qualificationAuthoritySources.length ||
        qualificationAuthoritySources.some((source) => !authoritySources.includes(source))
      ) {
        throw new Error("Frozen qualification request omits a required authority source");
      }
      const response = await this.env.PRODUCT_AUTHORITY.fetch(
        "https://qualification-product-authority.internal/v1/executions/preflight",
        {
          body: JSON.stringify(event.payload),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      if (response.status !== 200 && response.status !== 424) {
        throw new Error(`Product authority preflight returned ${response.status}`);
      }
      return decodePreflight(await response.text());
    });
    if (preflight.status === "READY") {
      throw new Error(
        "Product authority sources are ready but the bounded evaluator did not produce a report",
      );
    }
    await step.do("retain attempted missing qualification authority report", async () => {
      await retainMissingQualificationReport(
        this.env.ARTIFACTS,
        event.payload,
        preflight.missingSources.map(({ source }) => source),
      );
      return { retained: true };
    });
    return { status: "MISSING" };
  }
}
