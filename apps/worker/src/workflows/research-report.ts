import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import { runInvocationEffect } from "../adapters/host";
import { ResearchReportComposition } from "../composition/research-report";
import { decodeOsfoStage } from "../config";
import { makeWorkflowRuntime } from "../layers";
import { ResearchReport } from "../services/research-report";

/* oxlint-disable effecttsgo/async-function -- Cloudflare WorkflowEntrypoint and WorkflowStep are Promise-only host APIs. */
/* oxlint-disable eslint/no-underscore-dangle -- Option uses the standard Effect _tag discriminator. */

const ExecutionResult = Schema.Union([
  Schema.Struct({
    state: ResearchReport.State,
    workflowId: ResearchReport.WorkflowId,
  }),
  Schema.Struct({
    failure: Schema.Literals([
      "conflict",
      "invalidEnvironment",
      "invalidPayload",
      "notFound",
      "unavailable",
    ]),
  }),
]);
export type ExecutionResult = typeof ExecutionResult.Type;

/** Dedicated Cloudflare execution host for one admitted Research Report Workflow. */
export class ResearchReportWorkflow extends WorkflowEntrypoint<
  Env,
  ResearchReport.WorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<ResearchReport.WorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<ExecutionResult> {
    return step.do("authorize product admission", async () => {
      const stage = decodeOsfoStage(this.env.OSFO_STAGE);
      if (stage._tag === "None") return { failure: "invalidEnvironment" } as const;
      const payload = Schema.decodeResult(ResearchReport.WorkflowPayload)(event.payload);
      if (Result.isFailure(payload)) return { failure: "invalidPayload" } as const;
      const serviceEffect = ResearchReport.Service.pipe(
        Effect.flatMap((reports) => reports.authorizeExecution(payload.success)),
        Effect.match({
          onFailure: (failure) => ({ failure: failureKind(failure) }) as const,
          onSuccess: (report) => ({ state: report.state, workflowId: report.workflowId }) as const,
        }),
      );
      return runInvocationEffect(
        makeWorkflowRuntime(event.instanceId, stage.value),
        ResearchReportComposition.executionEffect(
          ResearchReportComposition.bindingsFromEnv(this.env),
          serviceEffect,
        ),
      );
    });
  }
}

const failureKind = (
  failure: ResearchReport.Conflict | ResearchReport.NotFound | ResearchReport.Unavailable,
): Extract<ExecutionResult, { readonly failure: string }>["failure"] => {
  if (Schema.is(ResearchReport.Conflict)(failure)) return "conflict";
  if (Schema.is(ResearchReport.NotFound)(failure)) return "notFound";
  if (Schema.is(ResearchReport.Unavailable)(failure)) return "unavailable";
  return "unavailable";
};
