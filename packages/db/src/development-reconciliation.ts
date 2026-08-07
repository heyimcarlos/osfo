import { PgClient } from "@effect/sql-pg";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export interface DevelopmentAgentRunEvidence {
  readonly agentRunId: string;
  readonly assistantOutputCount: string;
  readonly claimEpoch: string;
  readonly completedAssistantOutputCount: string;
  readonly confirmedProviderRequestCount: string;
  readonly deliveryId: string;
  readonly distinctProviderRequestCount: string;
  readonly executionProfileRef: string;
  readonly fragmentCount: string;
  readonly modelBinding: string | null;
  readonly modelCallCount: string;
  readonly modelCallAttemptCount: string;
  readonly openModelCallAttemptCount: string;
  readonly positiveReasoningUsageAttemptCount: string;
  readonly receiptCount: string;
  readonly relayConfirmedAttemptCount: string;
  readonly relayOpenAttemptCount: string;
  readonly relayTaskCount: string;
  readonly reservationCount: string;
  readonly releasedReservationCount: string;
  readonly reportedUsageAttemptCount: string;
  readonly runState: string;
  readonly succeededModelCallCount: string;
  readonly terminalModelCallAttemptCount: string;
  readonly threadEventCount: string;
  readonly threadId: string;
  readonly unpublishedOutboxCount: string;
  readonly userMessageCount: string;
}

export type AssessedDevelopmentAgentRunEvidence = DevelopmentAgentRunEvidence & {
  readonly verdict: "PASS" | "FAIL";
};

export class DevelopmentAgentRunEvidenceUnavailable extends Data.TaggedError(
  "DevelopmentAgentRunEvidenceUnavailable",
)<{ readonly cause: unknown }> {}

export class DevelopmentAgentRunEvidenceMissing extends Data.TaggedError(
  "DevelopmentAgentRunEvidenceMissing",
)<{ readonly agentRunId: string }> {}

export const assessDevelopmentAgentRunEvidence = (
  evidence: DevelopmentAgentRunEvidence,
): AssessedDevelopmentAgentRunEvidence => ({
  ...evidence,
  verdict:
    evidence.runState === "succeeded" &&
    evidence.receiptCount === "1" &&
    evidence.userMessageCount === "1" &&
    evidence.unpublishedOutboxCount === "0" &&
    evidence.relayTaskCount === "0" &&
    evidence.relayConfirmedAttemptCount !== "0" &&
    evidence.relayOpenAttemptCount === "0" &&
    evidence.assistantOutputCount === "1" &&
    evidence.completedAssistantOutputCount === "1" &&
    evidence.executionProfileRef === "oz.openrouter.minimax.minimax-m3.chat-completions.v1" &&
    evidence.modelCallCount === "1" &&
    evidence.modelBinding === "openrouter.chat-completions.minimax.minimax-m3.v1" &&
    evidence.succeededModelCallCount === "1" &&
    evidence.modelCallAttemptCount === "1" &&
    evidence.terminalModelCallAttemptCount === "1" &&
    evidence.openModelCallAttemptCount === "0" &&
    evidence.confirmedProviderRequestCount === "1" &&
    evidence.distinctProviderRequestCount === "1" &&
    evidence.reportedUsageAttemptCount === "1" &&
    evidence.positiveReasoningUsageAttemptCount === "1" &&
    evidence.fragmentCount !== "0" &&
    Number(evidence.threadEventCount) >= 4 &&
    evidence.reservationCount === "1" &&
    evidence.releasedReservationCount === "1"
      ? "PASS"
      : "FAIL",
});

export const readDevelopmentAgentRunEvidence = (options: {
  readonly agentRunId: string;
  readonly databaseUrl: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const rows = yield* sql<DevelopmentAgentRunEvidence>`SELECT
      run.agent_run_id::text AS "agentRunId",
      outbox.outbox_id::text AS "deliveryId",
      run.thread_id::text AS "threadId",
      run.execution_profile_ref AS "executionProfileRef",
      run.state AS "runState",
      run.claim_epoch::text AS "claimEpoch",
      (SELECT count(*)::text FROM acceptance_receipts receipt
        WHERE receipt.agent_run_id = run.agent_run_id) AS "receiptCount",
      (SELECT count(*)::text FROM user_messages message
        WHERE message.user_message_id = run.user_message_id) AS "userMessageCount",
      (SELECT count(*)::text FROM outbox_obligations obligation
        WHERE obligation.agent_run_id = run.agent_run_id
          AND obligation.published_at IS NULL) AS "unpublishedOutboxCount",
      (SELECT count(*)::text FROM relay_publication_tasks task
        WHERE task.outbox_id = outbox.outbox_id) AS "relayTaskCount",
      (SELECT count(*)::text FROM relay_publication_attempts attempt
        WHERE attempt.outbox_id = outbox.outbox_id
          AND attempt.state = 'confirmed') AS "relayConfirmedAttemptCount",
      (SELECT count(*)::text FROM relay_publication_attempts attempt
        WHERE attempt.outbox_id = outbox.outbox_id
          AND attempt.state = 'started') AS "relayOpenAttemptCount",
      (SELECT count(*)::text FROM assistant_outputs output
        WHERE output.agent_run_id = run.agent_run_id) AS "assistantOutputCount",
      (SELECT count(*)::text FROM assistant_outputs output
        WHERE output.agent_run_id = run.agent_run_id
          AND output.state = 'completed') AS "completedAssistantOutputCount",
      (SELECT count(*)::text FROM model_calls call
        WHERE call.agent_run_id = run.agent_run_id) AS "modelCallCount",
      (SELECT count(*)::text FROM model_calls call
        WHERE call.agent_run_id = run.agent_run_id
          AND call.state = 'succeeded') AS "succeededModelCallCount",
      (SELECT count(*)::text FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id) AS "modelCallAttemptCount",
      (SELECT min(attempt.model_binding) FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id) AS "modelBinding",
      (SELECT count(*)::text FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id
          AND attempt.state <> 'started') AS "terminalModelCallAttemptCount",
      (SELECT count(*)::text FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id
          AND attempt.state = 'started') AS "openModelCallAttemptCount",
      (SELECT count(*)::text FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id
          AND attempt.dispatch_state = 'confirmed'
          AND attempt.provider_request_id IS NOT NULL) AS "confirmedProviderRequestCount",
      (SELECT count(DISTINCT attempt.provider_request_id)::text
        FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id
          AND attempt.provider_request_id IS NOT NULL) AS "distinctProviderRequestCount",
      (SELECT count(*)::text FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id
          AND attempt.usage_type = 'reported') AS "reportedUsageAttemptCount",
      (SELECT count(*)::text FROM model_call_attempts attempt
        WHERE attempt.agent_run_id = run.agent_run_id
          AND attempt.usage_type = 'reported'
          AND attempt.reasoning_units > 0) AS "positiveReasoningUsageAttemptCount",
      (SELECT count(*)::text FROM model_call_fragments fragment
        WHERE fragment.agent_run_id = run.agent_run_id) AS "fragmentCount",
      (SELECT count(*)::text FROM thread_events event
        WHERE event.agent_run_id = run.agent_run_id) AS "threadEventCount",
      (SELECT count(*)::text FROM agent_run_capacity_reservations reservation
        WHERE reservation.agent_run_id = run.agent_run_id) AS "reservationCount",
      (SELECT count(*)::text FROM agent_run_capacity_reservations reservation
        WHERE reservation.agent_run_id = run.agent_run_id
          AND reservation.state = 'released') AS "releasedReservationCount"
    FROM agent_runs run
    JOIN outbox_obligations outbox USING (agent_run_id)
    WHERE run.agent_run_id = ${options.agentRunId}::uuid`;
    const evidence = rows[0];
    if (evidence === undefined) {
      return yield* new DevelopmentAgentRunEvidenceMissing({ agentRunId: options.agentRunId });
    }
    return assessDevelopmentAgentRunEvidence(evidence);
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DevelopmentAgentRunEvidenceMissing
        ? cause
        : new DevelopmentAgentRunEvidenceUnavailable({ cause }),
    ),
    Effect.provide(
      PgClient.layer({
        applicationName: "osfo-development-reconciliation",
        maxConnections: 1,
        url: Redacted.make(options.databaseUrl),
      }),
    ),
  );
