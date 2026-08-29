import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Schema } from "effect";

import { qualificationAuthoritySources } from "../qualification/authority-sources";
import { QualificationProductAuthorityPreflight } from "../qualification/product-authority-contract";
import { qualificationChecksum } from "../qualification/qualification-checksum";
import type { QualificationOwnerWorkflowPayload } from "../workflow-contracts";
import { retainMissingQualificationReport } from "./qualification-owner-report";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow APIs are Promise-only host boundaries. */

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
