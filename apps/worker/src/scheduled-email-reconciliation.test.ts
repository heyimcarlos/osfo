/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Promise-only Directory stubs model the Cloudflare RPC boundary. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AgentId } from "./domain";
import { ScheduledEmail } from "./services/scheduled-email";
import { repair } from "./scheduled-email-reconciliation";

const candidate = (identity: string, kind: ScheduledEmail.ReconciliationCandidate["kind"]) =>
  ScheduledEmail.ReconciliationCandidate.make({
    agentId: AgentId.make(`scheduled-email-agent-${identity}`),
    dueAt: new Date("2026-08-28T12:00:00.000Z"),
    inputDigest: ScheduledEmail.InputDigest.make(identity.repeat(64)),
    kind,
    workflowId: ScheduledEmail.WorkflowId.make(`scheduled-email:${identity}`),
  });

const result = (payload: ScheduledEmail.WorkflowPayload, state: ScheduledEmail.State) => ({
  dueAt: payload.dueAt.toISOString(),
  sendStartedAt: state === "waiting" ? null : payload.dueAt.toISOString(),
  state,
  terminalAt: null,
  workflowId: payload.workflowId,
});

it.effect("keeps due recovery fenced and routes claimed recovery through the narrow bypass", () => {
  const calls = new Array<string>();
  const directory = {
    executeScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(`execute:${payload.workflowId}`);
      return result(payload, "waiting");
    },
    recoverScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(`recover:${payload.workflowId}`);
      return result(payload, "send_pending_reconciliation");
    },
  };
  return Effect.gen(function* () {
    yield* repair([candidate("a", "due"), candidate("b", "claimed")], directory);
    expect(calls).toEqual(["execute:scheduled-email:a", "recover:scheduled-email:b"]);
  });
});

it.effect("attempts the complete bounded batch before reporting invalid recovery results", () => {
  const calls = new Array<string>();
  const directory = {
    executeScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(payload.workflowId);
      return { state: "not-a-state" };
    },
    recoverScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(payload.workflowId);
      return result(payload, "sending");
    },
  };
  return Effect.gen(function* () {
    const result = yield* repair(
      [candidate("c", "due"), candidate("d", "claimed")],
      directory,
    ).pipe(Effect.result);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      failure: { message: "Scheduled Email reconciliation is unavailable", operation: "batch" },
    });
  });
});
