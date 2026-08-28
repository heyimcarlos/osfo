import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Predicate, Result, Schema } from "effect";

import { runInvocationEffect } from "../adapters/host";
import { DocumentBuildComposition } from "../composition/document-build";
import { decodeOsfoStage } from "../config";
import { makeWorkflowRuntime } from "../layers";
import type { Denied } from "../services/authorization";
import { DocumentBuild } from "../services/document-build";
import { DocumentBuildDocument } from "../services/document-build-document";
import { matchesInstanceIdentity } from "./document-build-host-outcome";
import { runRecoverableMainOperation } from "./document-build-step";

/* oxlint-disable effecttsgo/async-function -- Cloudflare WorkflowEntrypoint and WorkflowStep are Promise-only host APIs. */
/* oxlint-disable eslint/no-underscore-dangle -- Product outcomes use Effect's standard tag. */

const ExecutionResult = Schema.Union([
  Schema.Struct({
    artifactContentId: Schema.NullOr(Schema.String),
    state: DocumentBuild.State,
    workflowId: DocumentBuild.WorkflowId,
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
  | DocumentBuild.Conflict
  | DocumentBuild.NotFound
  | DocumentBuild.Unavailable
  | DocumentBuildDocument.Unavailable;

/** Dedicated Cloudflare execution host for one admitted Document Build Workflow. */
export class DocumentBuildWorkflow extends WorkflowEntrypoint<Env, DocumentBuild.WorkflowPayload> {
  override async run(
    event: Readonly<WorkflowEvent<DocumentBuild.WorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<ExecutionResult> {
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    if (stage._tag === "None") return { failure: "invalidEnvironment" };
    const result: ExecutionResult = await step.do(
      "authorize, render, validate, and publish document",
      () =>
        runRecoverableMainOperation(async () => {
          const decoded = Schema.decodeResult(DocumentBuild.WorkflowPayload)(event.payload);
          if (Result.isFailure(decoded)) return { failure: "invalidPayload" } as const;
          const payload = decoded.success;
          if (
            !(await Effect.runPromise(matchesInstanceIdentity("main", event.instanceId, payload)))
          ) {
            return { failure: "invalidPayload" } as const;
          }
          const bindings = DocumentBuildComposition.bindingsFromEnv(this.env);
          const serviceEffect = Effect.gen(function* () {
            const builds = yield* DocumentBuild.Service;
            const documents = yield* DocumentBuildDocument.Service;
            const begun = yield* builds.beginExecution(payload);
            const completed = yield* documents.generate(begun);
            return projection(completed.build);
          }).pipe(
            settleTerminalOutcome(payload),
            Effect.match({
              onFailure: (failure) => ({ failure: failureKind(failure) }) as const,
              onSuccess: (build) => build,
            }),
          );
          return await runInvocationEffect(
            makeWorkflowRuntime(event.instanceId, stage.value),
            DocumentBuildComposition.executionEffect(
              bindings,
              DocumentBuildComposition.makePreviewReadyFollowUpCommitter(bindings),
              DocumentBuildComposition.makeTerminalFollowUpCommitter(bindings),
              serviceEffect,
            ),
          );
        }),
    );
    const settled = result;
    if (!("failure" in settled) && DocumentBuild.terminalStates.has(settled.state)) {
      await step.do("stop document timer after terminal product truth", async () => {
        const timer = await this.env.DOCUMENT_BUILD_TIMER_WORKFLOW.get(
          DocumentBuild.CloudflareInstanceId.make(`${event.instanceId}-timer`),
        );
        const status = await timer.status();
        if (
          status.status !== "complete" &&
          status.status !== "errored" &&
          status.status !== "terminated" &&
          status.status !== "unknown"
        ) {
          await timer.terminate();
        }
        return { status: status.status };
      });
    }
    return settled;
  }
}

const settleTerminalOutcome = (payload: DocumentBuild.WorkflowPayload) =>
  Effect.catch(
    (
      failure: WorkflowFailure,
    ): Effect.Effect<ReturnType<typeof projection>, WorkflowFailure, DocumentBuild.Service> => {
      if (Schema.is(DocumentBuildDocument.Unavailable)(failure)) {
        const disposition = DocumentBuildDocument.terminalDispositionFor(failure);
        if (disposition === null || disposition._tag === "RecoveryPending") {
          return Effect.fail(failure);
        }
        return DocumentBuild.Service.pipe(
          Effect.flatMap((builds) =>
            disposition._tag === "Canceled"
              ? builds.finishCanceled(payload, disposition.safeFailureCode)
              : builds.finishFailure(payload, disposition.safeFailureCode),
          ),
          Effect.map(projection),
        );
      }
      if (Predicate.hasProperty(failure, "_tag") && failure._tag === "Denied") {
        return DocumentBuild.Service.pipe(
          Effect.flatMap((builds) => builds.finishCanceled(payload, "authority-ended")),
          Effect.map(projection),
        );
      }
      if (Schema.is(DocumentBuild.Conflict)(failure)) {
        return DocumentBuild.Service.pipe(
          Effect.flatMap((builds) =>
            builds
              .inspectExecution(payload)
              .pipe(
                Effect.flatMap((build) =>
                  DocumentBuild.terminalStates.has(build.state)
                    ? builds.settleTerminal(build).pipe(Effect.map(projection))
                    : Effect.fail(failure),
                ),
              ),
          ),
        );
      }
      return Effect.fail(failure);
    },
  );

const projection = (build: DocumentBuild.Record) => ({
  artifactContentId: build.artifactContentId,
  state: build.state,
  workflowId: build.workflowId,
});

const failureKind = (
  failure: WorkflowFailure,
): Extract<ExecutionResult, { readonly failure: string }>["failure"] => {
  if (Schema.is(DocumentBuild.Conflict)(failure)) return "conflict";
  if (Schema.is(DocumentBuild.NotFound)(failure)) return "notFound";
  if (Schema.is(DocumentBuild.Unavailable)(failure)) return "unavailable";
  if (Schema.is(DocumentBuildDocument.Unavailable)(failure)) {
    return failure.reason === "recoveryPending" ? "recovery" : "unavailable";
  }
  return "unauthorized";
};
