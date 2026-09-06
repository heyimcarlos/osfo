import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Predicate, Result, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { ResearchReportComposition } from "../composition/research-report";
import { decodeOsfoStage } from "../config";
import { ResearchCollector } from "../services/research-collector";
import type { Denied } from "../services/authorization";
import { ResearchReport } from "../services/research-report";
import { ResearchReportDocument } from "../services/research-report-document";
import { ResearchReportFollowUp } from "../services/research-report-follow-up";
import { ResearchSynthesis } from "../services/research-synthesis";
import { requireRetryForRecoverableResult } from "./research-report-host-outcome";
import { recoverableResearchReportStepConfig } from "./research-report-step";

/* oxlint-disable effecttsgo/async-function -- Cloudflare WorkflowEntrypoint and WorkflowStep are Promise-only host APIs. */
/* oxlint-disable eslint/no-underscore-dangle -- Option uses the standard Effect _tag discriminator. */

const ExecutionResult = Schema.Union([
  Schema.Struct({
    artifactContentId: Schema.NullOr(Schema.String),
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
      "recovery",
      "unauthorized",
      "unavailable",
    ]),
  }),
]);
export type ExecutionResult = typeof ExecutionResult.Type;

type WorkflowFailure =
  | Denied
  | ResearchCollector.Conflict
  | ResearchCollector.Unavailable
  | ResearchReport.Conflict
  | ResearchReport.NotFound
  | ResearchReport.Unavailable
  | ResearchReportDocument.Unavailable;

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
        Effect.flatMap((reports) => reports.beginExecution(payload.success)),
        Effect.match({
          onFailure: (failure) => ({ failure: failureKind(failure) }) as const,
          onSuccess: (report) =>
            ({
              artifactContentId: report.artifactContentId,
              sourceCount: 0,
              sourceManifestKey: report.sourceManifestKey,
              state: report.state,
              workflowId: report.workflowId,
            }) as const,
        }),
      );
      const result = await Effect.runPromise(
        ResearchReportComposition.executionEffect(
          ResearchReportComposition.bindingsFromEnv(this.env),
          serviceEffect,
        ),
      );
      return requireRetryForRecoverableResult(result);
    });
    if ("failure" in admission) {
      if (admission.failure === "unauthorized") {
        await this.#claimAndSubmitTerminalFollowUp(
          step,
          event.instanceId,
          event.payload,
          "after admission cancellation",
        );
      }
      return admission;
    }
    const collected = await step.do("collect and commit public evidence", async () => {
      const payload = Schema.decodeResult(ResearchReport.WorkflowPayload)(event.payload);
      if (Result.isFailure(payload)) return { failure: "invalidPayload" } as const;
      const serviceEffect = Effect.gen(function* () {
        const reports = yield* ResearchReport.Service;
        const collector = yield* ResearchCollector.Service;
        const report = yield* reports.authorizeExecution(payload.success);
        const collection = yield* collector.collect(report);
        const committed = yield* reports
          .commitSources(payload.success, collection.manifestKey, collection.manifestDigest)
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
          artifactContentId: committed.artifactContentId,
          sourceCount: collection.manifest.sources.length,
          sourceManifestKey: committed.sourceManifestKey,
          state: committed.state,
          workflowId: committed.workflowId,
        } as const;
      }).pipe(
        commitTerminalOutcome(payload.success),
        Effect.match({
          onFailure: (failure) => ({ failure: failureKind(failure) }) as const,
          onSuccess: (result) => result,
        }),
      );
      const result = await Effect.runPromise(
        ResearchReportComposition.executionEffect(
          ResearchReportComposition.bindingsFromEnv(this.env),
          serviceEffect,
        ),
      );
      return requireRetryForRecoverableResult(result);
    });
    if ("failure" in collected) return collected;
    if (ResearchReport.terminalStates.has(collected.state)) {
      await this.#claimAndSubmitTerminalFollowUp(
        step,
        event.instanceId,
        event.payload,
        "after source collection",
      );
      return collected;
    }
    const published = await step.do(
      "synthesize and publish cited report",
      recoverableResearchReportStepConfig,
      async () => {
        const payload = Schema.decodeResult(ResearchReport.WorkflowPayload)(event.payload);
        if (Result.isFailure(payload)) return { failure: "invalidPayload" } as const;
        const serviceEffect = Effect.gen(function* () {
          const reports = yield* ResearchReport.Service;
          const collector = yield* ResearchCollector.Service;
          const documents = yield* ResearchReportDocument.Service;
          const report = yield* reports.authorizeExecution(payload.success);
          const collection = yield* collector.collect(report);
          const committed = yield* reports.commitSources(
            payload.success,
            collection.manifestKey,
            collection.manifestDigest,
          );
          const completed = yield* documents.generate(committed, collection);
          return {
            artifactContentId: completed.artifact.content.contentId,
            sourceCount: collection.manifest.sources.length,
            sourceManifestKey: completed.report.sourceManifestKey,
            state: completed.report.state,
            workflowId: completed.report.workflowId,
          } as const;
        }).pipe(
          commitTerminalOutcome(payload.success),
          Effect.match({
            onFailure: (failure) => ({ failure: failureKind(failure) }) as const,
            onSuccess: (result) => result,
          }),
        );
        const result = await Effect.runPromise(
          ResearchReportComposition.executionEffect(
            ResearchReportComposition.bindingsFromEnv(this.env),
            serviceEffect,
          ),
        );
        return requireRetryForRecoverableResult(result);
      },
    );
    if (!("failure" in published) && ResearchReport.terminalStates.has(published.state)) {
      await this.#claimAndSubmitTerminalFollowUp(
        step,
        event.instanceId,
        event.payload,
        "after report publication",
      );
    }
    return published;
  }

  async #claimAndSubmitTerminalFollowUp(
    step: WorkflowStep,
    instanceId: string,
    encodedPayload: ResearchReport.WorkflowPayload,
    phase: string,
  ) {
    const payload = Schema.decodeResult(ResearchReport.WorkflowPayload)(encodedPayload);
    if (Result.isFailure(payload)) return;
    const terminal = await step.do(`claim terminal follow-up ${phase}`, () =>
      Effect.runPromise(
        ResearchReportComposition.followUpEffect(
          { DB: this.env.DB },
          ResearchReportFollowUp.Service.pipe(
            Effect.flatMap((followUps) => followUps.claimTerminal(payload.success)),
            Effect.orDie,
          ),
        ),
      ),
    );
    if (terminal._tag === "NotTerminal" || terminal._tag === "Suppressed") return;
    await step.do(`submit terminal Agent follow-up ${phase}`, async () => {
      const directory = this.env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
      const result = await directory.submitResearchReportFollowUp(
        terminal.notification.notificationId,
      );
      if (result._tag !== "Accepted" && result._tag !== "Replayed") {
        throw new Error(`Research Report follow-up was not accepted: ${result._tag}`);
      }
      return {
        notificationId: terminal.notification.notificationId,
        submissionId: result.submissionId,
      };
    });
    await step.do(`stop report timer ${phase}`, async () => {
      const timer = await this.env.RESEARCH_REPORT_TIMER_WORKFLOW.get(`${instanceId}-timer`);
      const status = await timer.status();
      if (status.status !== "unknown" && status.status !== "terminated") {
        await timer.terminate();
      }
      return { status: status.status };
    });
  }
}

const failureKind = (
  failure: WorkflowFailure,
): Extract<ExecutionResult, { readonly failure: string }>["failure"] => {
  if (Schema.is(ResearchReport.Conflict)(failure)) return "conflict";
  if (Schema.is(ResearchReport.NotFound)(failure)) return "notFound";
  if (Schema.is(ResearchReport.Unavailable)(failure)) return "unavailable";
  if (Schema.is(ResearchCollector.Conflict)(failure)) return "conflict";
  if (Schema.is(ResearchCollector.Unavailable)(failure)) {
    return failure.reason === "ambiguousOperation" ? "recovery" : "unavailable";
  }
  if (Schema.is(ResearchReportDocument.Unavailable)(failure)) {
    return isRecoveryPending(failure) ? "recovery" : "unavailable";
  }
  if (Predicate.hasProperty(failure, "_tag") && failure._tag === "Denied") return "unauthorized";
  return "unavailable";
};

const commitTerminalOutcome = (payload: ResearchReport.WorkflowPayload) =>
  Effect.catch((failure: WorkflowFailure) => {
    const disposition = terminalDisposition(failure);
    if (disposition === null || disposition._tag === "RecoveryPending") {
      return Effect.fail(failure);
    }
    return ResearchReport.Service.pipe(
      Effect.flatMap((reports) =>
        disposition._tag === "Canceled"
          ? reports.finishCanceled(payload, disposition.safeFailureCode)
          : reports.finishFailure(payload, disposition.safeFailureCode),
      ),
      Effect.map((report) => ({
        artifactContentId: report.artifactContentId,
        sourceCount: 0,
        sourceManifestKey: report.sourceManifestKey,
        state: report.state,
        workflowId: report.workflowId,
      })),
    );
  });

const terminalDisposition = (failure: WorkflowFailure) => {
  if (Schema.is(ResearchCollector.Unavailable)(failure)) {
    if (failure.reason === "ambiguousOperation") return { _tag: "RecoveryPending" as const };
    if (failure.reason === "authorizationDenied") {
      return { _tag: "Canceled" as const, safeFailureCode: "authority-ended" };
    }
    if (failure.reason === "insufficientEvidence") {
      return { _tag: "Failure" as const, safeFailureCode: "insufficient-citation-evidence" };
    }
    return null;
  }
  if (!Schema.is(ResearchReportDocument.Unavailable)(failure)) return null;
  if (isRecoveryPending(failure)) {
    return { _tag: "RecoveryPending" as const };
  }
  if (Schema.is(ResearchSynthesis.Unavailable)(failure.cause)) {
    if (failure.cause.reason === "authorizationDenied") {
      return { _tag: "Canceled" as const, safeFailureCode: "authority-ended" };
    }
    if (failure.cause.reason === "fabricatedEvidence") {
      return { _tag: "Failure" as const, safeFailureCode: "invalid-synthesis-evidence" };
    }
  }
  if (Schema.is(ResearchCollector.Unavailable)(failure.cause)) {
    if (failure.cause.reason === "authorizationDenied") {
      return { _tag: "Canceled" as const, safeFailureCode: "authority-ended" };
    }
    if (failure.cause.reason === "insufficientEvidence") {
      return { _tag: "Failure" as const, safeFailureCode: "insufficient-citation-evidence" };
    }
  }
  return ResearchReportDocument.terminalDispositionFor(failure);
};

const isRecoveryPending = (failure: ResearchReportDocument.Unavailable) =>
  Schema.is(ResearchSynthesis.Unavailable)(failure.cause) &&
  failure.cause.reason === "ambiguousOperation";
