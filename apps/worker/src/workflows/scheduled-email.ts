import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { ScheduledEmail } from "../services/scheduled-email";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, eslint/no-await-in-loop -- Cloudflare Workflow callbacks are Promise-only; reconciliation polling is sequential and durable. */

export const ExecutionResult = Schema.Struct({
  dueAt: Schema.DateFromString,
  sendStartedAt: Schema.NullOr(Schema.DateFromString),
  state: ScheduledEmail.State,
  terminalAt: Schema.NullOr(Schema.DateFromString),
  workflowId: ScheduledEmail.WorkflowId,
});
export type ExecutionResult = typeof ExecutionResult.Type;

const reconciliationPollMilliseconds = 30_000;
const maximumReconciliationPolls = 4;
const EncodedExecutionResult = Schema.Struct({
  dueAt: Schema.String,
  sendStartedAt: Schema.NullOr(Schema.String),
  state: ScheduledEmail.State,
  terminalAt: Schema.NullOr(Schema.String),
  workflowId: ScheduledEmail.WorkflowId,
});

export interface ScheduledEmailDirectory {
  readonly beginScheduledEmail: (payload: ScheduledEmail.WorkflowPayload) => Promise<unknown>;
  readonly executeScheduledEmail: (payload: ScheduledEmail.WorkflowPayload) => Promise<unknown>;
}

export interface ScheduledEmailWorkflowStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

export const runScheduledEmailHost = async (
  event: Readonly<{ instanceId: string; payload: ScheduledEmail.WorkflowPayload }>,
  step: ScheduledEmailWorkflowStep,
  directory: ScheduledEmailDirectory,
): Promise<ExecutionResult> => {
  const decoded = Schema.decodeResult(ScheduledEmail.WorkflowPayload)(event.payload);
  if (Result.isFailure(decoded)) throw new Error("Scheduled Email Workflow payload is invalid");
  const payload = decoded.success;
  const expectedInstanceId = await Effect.runPromise(
    ScheduledEmail.cloudflareInstanceIdFor(payload.workflowId),
  );
  if (event.instanceId !== expectedInstanceId) {
    throw new Error("Scheduled Email Workflow instance identity is invalid");
  }
  const waiting = await step.do("retain exact scheduled email wait", async () =>
    decodeEncodedResult(await directory.beginScheduledEmail(payload)),
  );
  const decodedWaiting = decodeResult(waiting);
  if (ScheduledEmail.terminalStates.has(decodedWaiting.state)) return decodedWaiting;
  await step.sleepUntil("wait for exact scheduled email instant", decodedWaiting.dueAt);
  for (let attempt = 0; attempt <= maximumReconciliationPolls; attempt += 1) {
    const result = decodeResult(
      await step.do(`execute or reconcile scheduled email ${attempt + 1}`, async () =>
        decodeEncodedResult(await directory.executeScheduledEmail(payload)),
      ),
    );
    if (result.state !== "sending" && result.state !== "send_pending_reconciliation") {
      return result;
    }
    if (attempt === maximumReconciliationPolls) return result;
    await step.sleepUntil(
      `wait for scheduled email reconciliation ${attempt + 1}`,
      Date.now() + reconciliationPollMilliseconds,
    );
  }
  throw new Error("Scheduled Email reconciliation bound was not exhaustive");
};

/** Durable host for one exact future Gmail effect. */
export class ScheduledEmailWorkflow extends WorkflowEntrypoint<
  Env,
  ScheduledEmail.WorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<ScheduledEmail.WorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<ExecutionResult> {
    const directory = this.env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    return runScheduledEmailHost(event, step, directory);
  }
}

const decodeResult = (value: unknown) => {
  try {
    return Schema.decodeUnknownSync(ExecutionResult)(value);
  } catch {
    throw new Error("Scheduled Email Agent result is invalid");
  }
};

const decodeEncodedResult = (value: unknown) => {
  const decoded = Schema.decodeUnknownResult(EncodedExecutionResult)(value);
  if (Result.isFailure(decoded)) throw new Error("Scheduled Email Agent result is invalid");
  return decoded.success;
};
