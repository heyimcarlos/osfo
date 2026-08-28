import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import { runInvocationEffect } from "../adapters/host";
import { ResearchReportComposition } from "../composition/research-report";
import { decodeOsfoStage } from "../config";
import { makeWorkflowRuntime } from "../layers";
import { ResearchCollector } from "../services/research-collector";
import type { Denied } from "../services/authorization";
import { ResearchReport } from "../services/research-report";

/* oxlint-disable effecttsgo/async-function -- Cloudflare WorkflowEntrypoint and WorkflowStep are Promise-only host APIs. */
/* oxlint-disable eslint/no-underscore-dangle -- Option uses the standard Effect _tag discriminator. */

const ExecutionResult = Schema.Union([
  Schema.Struct({
    sourceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    sourceManifestKey: Schema.NullOr(Schema.String),
    state: ResearchReport.State,
    workflowId: ResearchReport.WorkflowId,
  }),
  Schema.Struct({
    failure: Schema.Literals([
      "conflict",
      "invalidEnvironment",
      "invalidPayload",
      "notFound",
      "unauthorized",
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
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    if (stage._tag === "None") return { failure: "invalidEnvironment" };
    const admission = await step.do("authorize product admission", async () => {
      const payload = Schema.decodeResult(ResearchReport.WorkflowPayload)(event.payload);
      if (Result.isFailure(payload)) return { failure: "invalidPayload" } as const;
      const serviceEffect = ResearchReport.Service.pipe(
        Effect.flatMap((reports) => reports.authorizeExecution(payload.success)),
        Effect.match({
          onFailure: (failure) => ({ failure: failureKind(failure) }) as const,
          onSuccess: (report) =>
            ({
              sourceCount: 0,
              sourceManifestKey: report.sourceManifestKey,
              state: report.state,
              workflowId: report.workflowId,
            }) as const,
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
    if ("failure" in admission) return admission;
    return step.do("collect and commit public evidence", async () => {
      const payload = Schema.decodeResult(ResearchReport.WorkflowPayload)(event.payload);
      if (Result.isFailure(payload)) return { failure: "invalidPayload" } as const;
      const serviceEffect = Effect.gen(function* () {
        const reports = yield* ResearchReport.Service;
        const collector = yield* ResearchCollector.Service;
        const report = yield* reports.authorizeExecution(payload.success);
        const collection = yield* collector.collect(report);
        const committed = yield* reports
          .commitSources(payload.success, collection.manifestKey)
          .pipe(
            Effect.catch(
              (
                failure,
              ): Effect.Effect<
                never,
                | ResearchCollector.Unavailable
                | ResearchReport.Conflict
                | Denied
                | ResearchReport.NotFound
                | ResearchReport.Unavailable
              > => {
                if (Schema.is(ResearchReport.Unavailable)(failure)) return Effect.fail(failure);
                return collector
                  .discard(report, collection)
                  .pipe(Effect.andThen(Effect.fail(failure)));
              },
            ),
          );
        return {
          sourceCount: collection.manifest.sources.length,
          sourceManifestKey: committed.sourceManifestKey,
          state: committed.state,
          workflowId: committed.workflowId,
        } as const;
      }).pipe(
        Effect.match({
          onFailure: (failure) => ({ failure: failureKind(failure) }) as const,
          onSuccess: (result) => result,
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
  failure:
    | ResearchCollector.Conflict
    | ResearchCollector.Unavailable
    | ResearchReport.Conflict
    | Denied
    | ResearchReport.NotFound
    | ResearchReport.Unavailable,
): Extract<ExecutionResult, { readonly failure: string }>["failure"] => {
  if (Schema.is(ResearchReport.Conflict)(failure)) return "conflict";
  if (Schema.is(ResearchReport.NotFound)(failure)) return "notFound";
  if (Schema.is(ResearchReport.Unavailable)(failure)) return "unavailable";
  if (Schema.is(ResearchCollector.Conflict)(failure)) return "conflict";
  if (Schema.is(ResearchCollector.Unavailable)(failure)) return "unavailable";
  if (failure._tag === "Denied") return "unauthorized";
  return "unavailable";
};
