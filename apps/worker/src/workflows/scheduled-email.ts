import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Effect, Option, Result, Schema } from "effect";

import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import { ScheduledEmail } from "../services/scheduled-email";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, eslint/no-await-in-loop, osfo/no-unknown-parameters, osfo/no-unknown-returns -- Cloudflare Workflow and Directory callbacks are Promise-only; untrusted RPC results are decoded immediately, and reconciliation polling is sequential and durable. */

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
export const scheduledEmailReconciliationHorizonMilliseconds =
  reconciliationPollMilliseconds * maximumReconciliationPolls;
const EncodedExecutionResult = Schema.Struct({
  dueAt: Schema.String,
  sendStartedAt: Schema.NullOr(Schema.String),
  state: ScheduledEmail.State,
  terminalAt: Schema.NullOr(Schema.String),
  workflowId: ScheduledEmail.WorkflowId,
});

export const ScheduledEmailWorkflowEvidence = Schema.Struct({
  artifactChecksum: Schema.String,
  artifactId: Schema.String,
  completedAtUtc: Schema.String,
  dueAtUtc: Schema.String,
  instanceId: Schema.String,
  sendStartedAtUtc: Schema.NullOr(Schema.String),
  state: ScheduledEmail.State,
  terminalAtUtc: Schema.NullOr(Schema.String),
  version: Schema.Literal("scheduled-email-workflow-evidence-v1"),
  workflowId: ScheduledEmail.WorkflowId,
});
export type ScheduledEmailWorkflowEvidence = typeof ScheduledEmailWorkflowEvidence.Type;

export const scheduledEmailWorkflowEvidenceArtifactId = (instanceId: string): string =>
  `scheduled-email/workflow-evidence/${encodeURIComponent(instanceId)}.json`;

const decodeWorkflowEvidence = Schema.decodeUnknownOption(
  Schema.fromJsonString(ScheduledEmailWorkflowEvidence),
);

export interface ScheduledEmailDirectory {
  readonly beginScheduledEmail: (payload: ScheduledEmail.WorkflowPayload) => Promise<unknown>;
  readonly executeScheduledEmail: (payload: ScheduledEmail.WorkflowPayload) => Promise<unknown>;
}

export interface ScheduledEmailWorkflowStep {
  readonly do: <Value>(name: string, callback: () => Promise<Value>) => Promise<Value>;
  readonly sleep: (name: string, duration: number) => Promise<void>;
  readonly sleepUntil: (name: string, timestamp: Date | number) => Promise<void>;
}

export interface ScheduledEmailWorkflowEvidenceBucket {
  readonly get: (key: string) => Promise<{ readonly text: () => Promise<string> } | null>;
  readonly put: (
    key: string,
    value: string,
    options: {
      readonly customMetadata: Readonly<Record<string, string>>;
      readonly httpMetadata: { readonly contentType: "application/json" };
      readonly onlyIf: { readonly etagDoesNotMatch: "*" };
    },
  ) => Promise<object | null>;
}

export const runScheduledEmailHost = async (
  event: Readonly<{ instanceId: string; payload: ScheduledEmail.EncodedWorkflowPayload }>,
  step: ScheduledEmailWorkflowStep,
  directory: ScheduledEmailDirectory,
): Promise<ExecutionResult> => {
  const decoded = Schema.decodeResult(ScheduledEmail.EncodedWorkflowPayload)(event.payload);
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
    await step.sleep(
      `wait for scheduled email reconciliation ${attempt + 1}`,
      reconciliationPollMilliseconds,
    );
  }
  throw new Error("Scheduled Email reconciliation bound was not exhaustive");
};

/** Run the real Workflow and retain content-free execution truth from the owning runtime. */
export const runAndRetainScheduledEmailHost = async (
  event: Readonly<{ instanceId: string; payload: ScheduledEmail.EncodedWorkflowPayload }>,
  step: ScheduledEmailWorkflowStep,
  directory: ScheduledEmailDirectory,
  bucket: ScheduledEmailWorkflowEvidenceBucket,
  now: () => Date = () => new Date(),
): Promise<ExecutionResult> => {
  const result = await runScheduledEmailHost(event, step, directory);
  const completedAtUtc = await step.do("capture scheduled email workflow completion", async () =>
    now().toISOString(),
  );
  await step.do("retain scheduled email workflow evidence", async () => {
    const artifactId = scheduledEmailWorkflowEvidenceArtifactId(event.instanceId);
    const content = {
      artifactId,
      completedAtUtc,
      dueAtUtc: result.dueAt.toISOString(),
      instanceId: event.instanceId,
      sendStartedAtUtc: result.sendStartedAt?.toISOString() ?? null,
      state: result.state,
      terminalAtUtc: result.terminalAt?.toISOString() ?? null,
      version: "scheduled-email-workflow-evidence-v1" as const,
      workflowId: result.workflowId,
    };
    const evidence = { ...content, artifactChecksum: qualificationChecksum(content) };
    const encoded = canonicalQualificationJson(evidence);
    const retained = await bucket.put(artifactId, encoded, {
      customMetadata: {
        "osfo-artifact-checksum": evidence.artifactChecksum,
        "osfo-instance-id": event.instanceId,
        "osfo-kind": evidence.version,
        "osfo-workflow-id": result.workflowId,
      },
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (retained !== null) return { retained: true };
    const existing = await bucket.get(artifactId);
    if (existing === null) throw new Error("Scheduled Email Workflow evidence is unavailable");
    const decoded = decodeWorkflowEvidence(await existing.text());
    const decodedContent = Option.map(decoded, ({ artifactChecksum, ...retainedContent }) => ({
      artifactChecksum,
      content: retainedContent,
    }));
    if (
      Option.isNone(decoded) ||
      Option.isNone(decodedContent) ||
      decodedContent.value.artifactChecksum !== evidence.artifactChecksum ||
      qualificationChecksum(decodedContent.value.content) !== decodedContent.value.artifactChecksum
    ) {
      throw new Error("Scheduled Email Workflow evidence conflicts with retained authority");
    }
    return { retained: true };
  });
  return result;
};

/** Durable host for one exact future Gmail effect. */
export class ScheduledEmailWorkflow extends WorkflowEntrypoint<
  Env,
  ScheduledEmail.EncodedWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<ScheduledEmail.EncodedWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<ExecutionResult> {
    const directory = this.env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);
    return runAndRetainScheduledEmailHost(event, step, directory, this.env.ARTIFACTS);
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
