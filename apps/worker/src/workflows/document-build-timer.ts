import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import { runInvocationEffect } from "../adapters/host";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { DocumentBuildComposition } from "../composition/document-build";
import { decodeOsfoStage, type OsfoStage } from "../config";
import { makeWorkflowRuntime } from "../layers";
import { DocumentBuild } from "../services/document-build";
import { DocumentBuildDocument } from "../services/document-build-document";
import { DocumentBuildFollowUp } from "../services/document-build-follow-up";
import { matchesInstanceIdentity } from "./document-build-host-outcome";

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
    const schedule = await step.do("read admitted document schedule", () =>
      this.#run(event.instanceId, stage.value, (followUps) => followUps.inspectSchedule(payload)),
    );
    const previewAt = schedule.admittedAt.getTime() + previewDelayMilliseconds;
    await step.sleepUntil("wait for validated preview milestone guard", previewAt);

    let preview: TimerResult["preview"] = "pending";
    for (let poll = 0; poll < maximumPreviewPolls; poll += 1) {
      const claimed = await step.do(`claim validated preview milestone ${poll + 1}`, () =>
        this.#run(event.instanceId, stage.value, (followUps) => followUps.claimPreview(payload)),
      );
      if (claimed._tag === "Claimed" || claimed._tag === "AlreadyClaimed") {
        if (claimed.notification === null) {
          preview = "suppressed";
          break;
        }
        const notification = claimed.notification;
        await step.do("submit validated preview Agent follow-up", () =>
          this.#submitFollowUp(notification.notificationId),
        );
        preview = "claimed";
        break;
      }
      if (claimed._tag === "Suppressed") {
        preview = "suppressed";
        break;
      }
      if (claimed._tag === "Terminal") {
        const terminalFollowUp = await this.#claimAndSubmitTerminal(
          step,
          event.instanceId,
          stage.value,
          payload,
        );
        return {
          deadline: "terminal",
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
      await step.sleepUntil(`wait for validated preview ${poll + 1}`, nextPollAt);
    }

    const afterPreview = await step.do("inspect document after preview window", () =>
      this.#run(event.instanceId, stage.value, (followUps) => followUps.inspectSchedule(payload)),
    );
    if (
      DocumentBuild.terminalStates.has(afterPreview.state) ||
      afterPreview.state === "publication_committed"
    ) {
      const terminalFollowUp = DocumentBuild.terminalStates.has(afterPreview.state)
        ? await this.#claimAndSubmitTerminal(step, event.instanceId, stage.value, payload)
        : "notTerminal";
      return { deadline: "terminal", preview, terminalFollowUp, workflowId: payload.workflowId };
    }

    await step.sleepUntil("wait for hard document deadline", schedule.deadlineAt);
    const deadline = await step.do("enforce hard document deadline", () =>
      this.#run(event.instanceId, stage.value, (followUps) => followUps.enforceDeadline(payload)),
    );
    if (deadline._tag === "Canceled") {
      await step.do("discard canceled document and commit terminal follow-up", () =>
        this.#settleCanceled(event.instanceId, stage.value, payload),
      );
    }
    const terminalFollowUp =
      deadline._tag === "Canceled" || deadline._tag === "Terminal"
        ? await this.#claimAndSubmitTerminal(step, event.instanceId, stage.value, payload)
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

  #settleCanceled(instanceId: string, stage: OsfoStage, payload: DocumentBuild.WorkflowPayload) {
    const bindings = DocumentBuildComposition.bindingsFromEnv(this.env);
    return runInvocationEffect(
      makeWorkflowRuntime(instanceId, stage),
      DocumentBuildComposition.executionEffect(
        bindings,
        DocumentBuildComposition.makePreviewReadyFollowUpCommitter(bindings),
        DocumentBuildComposition.makeTerminalFollowUpCommitter(bindings),
        Effect.gen(function* () {
          const builds = yield* DocumentBuild.Service;
          const documents = yield* DocumentBuildDocument.Service;
          const canceled = yield* builds.finishCanceled(payload, "deadline-exceeded");
          yield* documents.discard(canceled);
          return { state: canceled.state };
        }).pipe(Effect.orDie),
      ),
    );
  }

  async #claimAndSubmitTerminal(
    step: WorkflowStep,
    instanceId: string,
    stage: OsfoStage,
    payload: DocumentBuild.WorkflowPayload,
  ): Promise<TimerResult["terminalFollowUp"]> {
    const claimed = await step.do("claim terminal document follow-up", () =>
      this.#run(instanceId, stage, (followUps) => followUps.claimTerminal(payload)),
    );
    if (claimed._tag === "NotTerminal" || claimed._tag === "Suppressed") return "notTerminal";
    await step.do("submit terminal document Agent follow-up", () =>
      this.#submitFollowUp(claimed.notification.notificationId),
    );
    return "claimed";
  }

  #run<A>(
    instanceId: string,
    stage: OsfoStage,
    operation: (
      followUps: DocumentBuildFollowUp.Interface,
    ) => Effect.Effect<A, DocumentBuildFollowUp.Conflict | DocumentBuildFollowUp.Unavailable>,
  ) {
    return runInvocationEffect(
      makeWorkflowRuntime(instanceId, stage),
      DocumentBuildComposition.followUpEffect(
        { DB: this.env.DB },
        DocumentBuildFollowUp.Service.pipe(Effect.flatMap(operation), Effect.orDie),
      ),
    );
  }

  async #submitFollowUp(notificationId: DocumentBuildFollowUp.NotificationId) {
    const directory = this.env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    const result = await directory.submitDocumentBuildFollowUp(notificationId);
    if (result._tag !== "Accepted" && result._tag !== "Replayed") {
      throw new Error(`Document Build follow-up was not accepted: ${result._tag}`);
    }
    return { notificationId, submissionId: result.submissionId };
  }
}
