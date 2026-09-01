import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import { runInvocationEffect } from "../adapters/host";
import { DocumentBuildComposition } from "../composition/document-build";
import { decodeOsfoStage } from "../config";
import { makeWorkflowRuntime } from "../layers";
import { DocumentBuild } from "../services/document-build";
import { DocumentBuildDocument } from "../services/document-build-document";
import { DocumentBuildFollowUp } from "../services/document-build-follow-up";
import { matchesInstanceIdentity } from "./document-build-host-outcome";
import {
  postPreviewDisposition,
  previewFollowUpDisposition,
  terminalFollowUpAccepted,
} from "./document-build-timer-outcome";
import { recoverableDocumentBuildStepConfig } from "./document-build-step";

/* oxlint-disable effecttsgo/async-function -- Cloudflare WorkflowEntrypoint and WorkflowStep are Promise-only host APIs. */
/* oxlint-disable eslint/no-underscore-dangle -- Product outcomes use Effect's standard tag. */
/* oxlint-disable eslint/no-await-in-loop -- Sequential durable polling preserves milestone/deadline ordering. */

const previewDelayMilliseconds = 15 * 60 * 1_000;
const previewPollMilliseconds = 60 * 1_000;
const maximumPreviewPolls = 45;

const TimerResult = Schema.Struct({
  deadline: Schema.Literals(["canceled", "notDue", "terminal"]),
  preview: Schema.Literals(["claimed", "pending", "suppressed"]),
  terminalFollowUp: Schema.Literals(["claimed", "notTerminal"]),
  workflowId: DocumentBuild.WorkflowId,
});
export type TimerResult = typeof TimerResult.Type;

/** Parent-derived durable timer for one preview milestone and hard deadline. */
export class DocumentBuildTimerWorkflow extends WorkflowEntrypoint<
  Env,
  DocumentBuild.WorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<DocumentBuild.WorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<TimerResult> {
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    if (stage._tag === "None") throw new Error("Document Build timer environment is invalid");
    const decoded = Schema.decodeResult(DocumentBuild.WorkflowPayload)(event.payload);
    if (Result.isFailure(decoded)) throw new Error("Document Build timer payload is invalid");
    const payload = decoded.success;
    if (!(await Effect.runPromise(matchesInstanceIdentity("timer", event.instanceId, payload)))) {
      throw new Error("Document Build timer instance identity is invalid");
    }
    const schedule = await step.do(
      "read admitted document schedule",
      recoverableDocumentBuildStepConfig,
      () => this.#run((followUps) => followUps.inspectSchedule(payload)),
    );
    const previewAt = schedule.admittedAt.getTime() + previewDelayMilliseconds;
    await step.sleepUntil("wait for validated preview milestone guard", previewAt);

    let preview: TimerResult["preview"] = "pending";
    let nextPollOffset = 1;
    for (let poll = 0; poll < maximumPreviewPolls; poll += 1) {
      const claimed = await step.do(
        `claim validated preview milestone ${poll + 1}`,
        recoverableDocumentBuildStepConfig,
        () => this.#run((followUps) => followUps.claimPreview(payload)),
      );
      if (claimed._tag === "Claimed" || claimed._tag === "AlreadyClaimed") {
        if (claimed.notification === null) {
          preview = "suppressed";
          break;
        }
        const notification = claimed.notification;
        const submission = await step.do(
          "submit validated preview Agent follow-up",
          recoverableDocumentBuildStepConfig,
          () => this.#submitFollowUp(notification.notificationId),
        );
        if (previewFollowUpDisposition(submission) === "terminal") {
          const recovered = await step.do(
            "recover preview-superseded publication",
            recoverableDocumentBuildStepConfig,
            () => this.#recoverPublication(payload),
          );
          const terminalFollowUp = await this.#claimAndSubmitTerminal(step, payload);
          return {
            deadline: DocumentBuild.terminalStates.has(recovered.state) ? "terminal" : "notDue",
            preview: "suppressed",
            terminalFollowUp,
            workflowId: payload.workflowId,
          };
        }
        preview = "claimed";
        nextPollOffset = poll + 1;
        break;
      }
      if (claimed._tag === "Suppressed") {
        preview = "suppressed";
        break;
      }
      if (claimed._tag === "Terminal") {
        const terminalSchedule = await step.do(
          "recover committed document publication",
          recoverableDocumentBuildStepConfig,
          () => this.#recoverPublication(payload),
        );
        const terminalFollowUp = await this.#claimAndSubmitTerminal(step, payload);
        return {
          deadline: DocumentBuild.terminalStates.has(terminalSchedule.state)
            ? "terminal"
            : "notDue",
          preview: "suppressed",
          terminalFollowUp,
          workflowId: payload.workflowId,
        };
      }
      const nextPollAt = Math.min(
        previewAt + (poll + 1) * previewPollMilliseconds,
        schedule.deadlineAt.getTime(),
      );
      if (nextPollAt >= schedule.deadlineAt.getTime()) break;
      nextPollOffset = poll + 2;
      await step.sleepUntil(`wait for validated preview ${poll + 1}`, nextPollAt);
    }

    for (let poll = nextPollOffset; poll <= maximumPreviewPolls; poll += 1) {
      const afterPreview = await step.do(
        `inspect document after preview ${poll}`,
        recoverableDocumentBuildStepConfig,
        () => this.#run((followUps) => followUps.inspectSchedule(payload)),
      );
      if (postPreviewDisposition(afterPreview.state) !== "continue") {
        if (afterPreview.state === "publication_committed") {
          await step.do(
            "recover committed document publication",
            recoverableDocumentBuildStepConfig,
            () => this.#recoverPublication(payload),
          );
        }
        const terminalFollowUp = await this.#claimAndSubmitTerminal(step, payload);
        return { deadline: "terminal", preview, terminalFollowUp, workflowId: payload.workflowId };
      }
      const nextPollAt = Math.min(
        previewAt + poll * previewPollMilliseconds,
        schedule.deadlineAt.getTime(),
      );
      if (nextPollAt >= schedule.deadlineAt.getTime()) break;
      await step.sleepUntil(`wait for terminal document ${poll}`, nextPollAt);
    }

    await step.sleepUntil("wait for hard document deadline", schedule.deadlineAt);
    const deadline = await step.do(
      "enforce hard document deadline",
      recoverableDocumentBuildStepConfig,
      () => this.#run((followUps) => followUps.enforceDeadline(payload)),
    );
    if (deadline._tag === "Canceled") {
      await step.do(
        "discard canceled document and commit terminal follow-up",
        recoverableDocumentBuildStepConfig,
        () => this.#settleCanceled(payload),
      );
    }
    if (deadline._tag === "Terminal" && deadline.build.state === "publication_committed") {
      await step.do("recover deadline publication winner", recoverableDocumentBuildStepConfig, () =>
        this.#recoverPublication(payload),
      );
    }
    const terminalFollowUp =
      deadline._tag === "Canceled" || deadline._tag === "Terminal"
        ? await this.#claimAndSubmitTerminal(step, payload)
        : "notTerminal";
    return {
      deadline:
        deadline._tag === "Canceled"
          ? "canceled"
          : deadline._tag === "Terminal"
            ? "terminal"
            : "notDue",
      preview,
      terminalFollowUp,
      workflowId: payload.workflowId,
    };
  }

  #settleCanceled(payload: DocumentBuild.WorkflowPayload) {
    const bindings = DocumentBuildComposition.bindingsFromEnv(this.env);
    return runInvocationEffect(
      makeWorkflowRuntime(),
      DocumentBuildComposition.executionEffect(
        bindings,
        DocumentBuildComposition.makePreviewReadyFollowUpCommitter(bindings),
        DocumentBuildComposition.makeTerminalFollowUpCommitter(bindings),
        Effect.gen(function* () {
          const builds = yield* DocumentBuild.Service;
          const canceled = yield* builds.finishCanceled(payload, "deadline-exceeded");
          return { state: canceled.state };
        }),
      ),
    );
  }

  #recoverPublication(payload: DocumentBuild.WorkflowPayload) {
    const bindings = DocumentBuildComposition.bindingsFromEnv(this.env);
    return runInvocationEffect(
      makeWorkflowRuntime(),
      DocumentBuildComposition.executionEffect(
        bindings,
        DocumentBuildComposition.makePreviewReadyFollowUpCommitter(bindings),
        DocumentBuildComposition.makeTerminalFollowUpCommitter(bindings),
        Effect.gen(function* () {
          const builds = yield* DocumentBuild.Service;
          const documents = yield* DocumentBuildDocument.Service;
          const build = yield* builds.inspectExecution(payload);
          if (build.state === "publication_committed") {
            return yield* documents
              .recoverPublication(build)
              .pipe(Effect.map(({ build: completed }) => completed));
          }
          return build;
        }),
      ),
    );
  }

  async #claimAndSubmitTerminal(
    step: WorkflowStep,
    payload: DocumentBuild.WorkflowPayload,
  ): Promise<TimerResult["terminalFollowUp"]> {
    const claimed = await step.do(
      "claim terminal document follow-up",
      recoverableDocumentBuildStepConfig,
      () => this.#run((followUps) => followUps.claimTerminal(payload)),
    );
    if (claimed._tag === "NotTerminal" || claimed._tag === "Suppressed") return "notTerminal";
    const submitted = await step.do(
      "submit terminal document Agent follow-up",
      recoverableDocumentBuildStepConfig,
      () => this.#submitFollowUp(claimed.notification.notificationId),
    );
    if (!terminalFollowUpAccepted(submitted)) {
      throw new Error("A terminal Document Build follow-up was not accepted");
    }
    return "claimed";
  }

  #run<A>(
    operation: (
      followUps: DocumentBuildFollowUp.Interface,
    ) => Effect.Effect<A, DocumentBuildFollowUp.Conflict | DocumentBuildFollowUp.Unavailable>,
  ) {
    return runInvocationEffect(
      makeWorkflowRuntime(),
      DocumentBuildComposition.followUpEffect(
        { DB: this.env.DB },
        DocumentBuildFollowUp.Service.pipe(
          Effect.flatMap(operation),
          Effect.mapError(
            (cause) =>
              new DocumentBuild.Unavailable({
                cause,
                message: "Document Build follow-up persistence is unavailable",
                operation: "followUp.timer",
              }),
          ),
        ),
      ),
    );
  }

  async #submitFollowUp(notificationId: DocumentBuildFollowUp.NotificationId) {
    const result = await Effect.runPromise(
      DocumentBuildComposition.submitFollowUp(
        { OSFO_DIRECTORY: this.env.OSFO_DIRECTORY },
        notificationId,
      ),
    );
    return result;
  }
}
