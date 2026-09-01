import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import { runInvocationEffect } from "../adapters/host";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { ResearchReportComposition } from "../composition/research-report";
import { decodeOsfoStage } from "../config";
import { makeWorkflowRuntime } from "../layers";
import { ResearchReport } from "../services/research-report";
import { ResearchReportDocument } from "../services/research-report-document";
import { ResearchReportFollowUp } from "../services/research-report-follow-up";
import { settleDeadlineOutcome } from "./research-report-timer-outcome";

/* oxlint-disable effecttsgo/async-function -- Cloudflare WorkflowEntrypoint and WorkflowStep are Promise-only host APIs. */
/* oxlint-disable eslint/no-underscore-dangle -- Effect and product outcomes use the canonical _tag discriminator. */
/* oxlint-disable eslint/no-await-in-loop -- Durable source polling must be sequential and deadline-bounded; parallel sleeps would violate Workflow ordering. */

const milestoneDelayMilliseconds = 15 * 60 * 1_000;
const milestonePollMilliseconds = 60 * 1_000;
const maximumMilestonePolls = 45;

const TimerResult = Schema.Struct({
  deadline: Schema.Literals(["canceled", "notDue", "terminal"]),
  milestone: Schema.Literals(["claimed", "pending", "suppressed"]),
  terminalFollowUp: Schema.Literals(["claimed", "notTerminal"]),
  workflowId: ResearchReport.WorkflowId,
});
export type TimerResult = typeof TimerResult.Type;

/** Parent-derived durable timer for one Research Report milestone and deadline. */
export class ResearchReportTimerWorkflow extends WorkflowEntrypoint<
  Env,
  ResearchReport.WorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<ResearchReport.WorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<TimerResult> {
    const stage = decodeOsfoStage(this.env.OSFO_STAGE);
    if (stage._tag === "None") throw new Error("Research Report timer environment is invalid");
    const decoded = Schema.decodeResult(ResearchReport.WorkflowPayload)(event.payload);
    if (Result.isFailure(decoded)) throw new Error("Research Report timer payload is invalid");
    const payload = decoded.success;
    const schedule = await step.do("read admitted report schedule", () =>
      this.#run((followUps) => followUps.inspectSchedule(payload)),
    );
    const milestoneAt = schedule.admittedAt.getTime() + milestoneDelayMilliseconds;
    await step.sleepUntil("wait for sources-collected milestone guard", milestoneAt);

    let milestone: TimerResult["milestone"] = "pending";
    for (let poll = 0; poll < maximumMilestonePolls; poll += 1) {
      const claimed = await step.do(`claim sources-collected milestone ${poll + 1}`, () =>
        this.#run((followUps) => followUps.claimMilestone(payload)),
      );
      if (claimed._tag === "Claimed" || claimed._tag === "AlreadyClaimed") {
        if (claimed.notification === null) {
          milestone = "suppressed";
          break;
        }
        const notification = claimed.notification;
        await step.do("submit sources-collected Agent follow-up", () =>
          this.#submitFollowUp(notification.notificationId),
        );
        milestone = "claimed";
        break;
      }
      if (claimed._tag === "Suppressed") {
        milestone = "suppressed";
        break;
      }
      if (claimed._tag === "Terminal") {
        await this.#claimAndSubmitTerminal(step, payload);
        return {
          deadline: "terminal",
          milestone,
          terminalFollowUp: "claimed",
          workflowId: payload.workflowId,
        };
      }
      if (claimed._tag !== "AwaitingSources" && claimed._tag !== "NotDue") break;
      const nextPollAt = Math.min(
        milestoneAt + (poll + 1) * milestonePollMilliseconds,
        schedule.deadlineAt.getTime(),
      );
      if (nextPollAt >= schedule.deadlineAt.getTime()) break;
      await step.sleepUntil(`wait for sources before deadline ${poll + 1}`, nextPollAt);
    }

    const afterMilestone = await step.do("inspect report after milestone", () =>
      this.#run((followUps) => followUps.inspectSchedule(payload)),
    );
    if (ResearchReport.terminalStates.has(afterMilestone.state)) {
      await this.#claimAndSubmitTerminal(step, payload);
      return {
        deadline: "terminal",
        milestone,
        terminalFollowUp: "claimed",
        workflowId: payload.workflowId,
      };
    }

    await step.sleepUntil("wait for hard report deadline", schedule.deadlineAt);
    const deadline = await step.do("enforce hard report deadline", () =>
      this.#run((followUps) => followUps.enforceDeadline(payload)),
    );
    const terminalFollowUp = await settleDeadlineOutcome(
      deadline,
      (report) =>
        step.do("discard canceled report publication", () => this.#discardPublication(report)),
      () => this.#claimAndSubmitTerminal(step, payload),
    );
    return {
      deadline:
        deadline._tag === "Canceled"
          ? "canceled"
          : deadline._tag === "Terminal"
            ? "terminal"
            : "notDue",
      milestone,
      terminalFollowUp,
      workflowId: payload.workflowId,
    };
  }

  async #claimAndSubmitTerminal(
    step: WorkflowStep,
    payload: ResearchReport.WorkflowPayload,
  ): Promise<TimerResult["terminalFollowUp"]> {
    const terminal = await step.do("claim terminal report follow-up", () =>
      this.#run((followUps) => followUps.claimTerminal(payload)),
    );
    if (terminal._tag === "NotTerminal" || terminal._tag === "Suppressed") return "notTerminal";
    await step.do("submit terminal Agent follow-up", () =>
      this.#submitFollowUp(terminal.notification.notificationId),
    );
    return "claimed";
  }

  #discardPublication(report: ResearchReport.Record) {
    return runInvocationEffect(
      makeWorkflowRuntime(),
      ResearchReportComposition.executionEffect(
        ResearchReportComposition.bindingsFromEnv(this.env),
        Effect.gen(function* () {
          const documents = yield* ResearchReportDocument.Service;
          yield* documents.discard(report);
          return { state: report.state };
        }).pipe(Effect.orDie),
      ),
    );
  }

  #run<A>(
    operation: (
      followUps: ResearchReportFollowUp.Interface,
    ) => Effect.Effect<A, ResearchReportFollowUp.Conflict | ResearchReportFollowUp.Unavailable>,
  ) {
    return runInvocationEffect(
      makeWorkflowRuntime(),
      ResearchReportComposition.followUpEffect(
        { DB: this.env.DB },
        ResearchReportFollowUp.Service.pipe(Effect.flatMap(operation), Effect.orDie),
      ),
    );
  }

  async #submitFollowUp(notificationId: ResearchReportFollowUp.NotificationId) {
    const directory = this.env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    const result = await directory.submitResearchReportFollowUp(notificationId);
    if (result._tag !== "Accepted" && result._tag !== "Replayed") {
      throw new Error(`Research Report follow-up was not accepted: ${result._tag}`);
    }
    return { notificationId, submissionId: result.submissionId };
  }
}
