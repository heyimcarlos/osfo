import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import type { QualificationOwnerWorkflowPayload } from "../workflow-contracts";
import { retainMissingQualificationReport } from "./qualification-owner-report";

/* oxlint-disable effecttsgo/async-function -- Cloudflare Workflow APIs are Promise-only host boundaries. */

interface QualificationOwnerWorkflowEnv {
  readonly ARTIFACTS: R2Bucket;
}

/** Durable owner that records exact unavailable authority sources instead of inventing evidence. */
export class QualificationOwnerWorkflow extends WorkflowEntrypoint<
  QualificationOwnerWorkflowEnv,
  QualificationOwnerWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<QualificationOwnerWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<{ readonly status: "MISSING" }> {
    await step.do("retain missing qualification authority report", async () => {
      await retainMissingQualificationReport(this.env.ARTIFACTS, event.payload);
      return { retained: true };
    });
    return { status: "MISSING" };
  }
}
