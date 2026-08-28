/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, vitest/no-standalone-expect -- Promise-only Directory stubs model the Cloudflare RPC boundary with fixed timestamps. */
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

const encodedResult = (payload: ScheduledEmail.WorkflowPayload, state: ScheduledEmail.State) => ({
  dueAt: payload.dueAt.toISOString(),
  sendStartedAt: state === "waiting" ? null : payload.dueAt.toISOString(),
  state,
  terminalAt: null,
  workflowId: payload.workflowId,
});

it.effect("keeps due recovery fenced and routes claimed recovery through the narrow bypass", () => {
  const calls = new Array<string>();
  const directory = {
    beginScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(`begin:${payload.workflowId}`);
      return encodedResult(payload, "waiting");
    },
    executeScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(`execute:${payload.workflowId}`);
      return encodedResult(payload, "waiting");
    },
    recoverScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(`recover:${payload.workflowId}`);
      return encodedResult(payload, "send_pending_reconciliation");
    },
  };
  return Effect.gen(function* () {
    yield* repair(
      [
        candidate("a", "due"),
        candidate("b", "claimed"),
        candidate("c", "host"),
        candidate("d", "settlement"),
      ],
      directory,
    );
    expect(calls).toHaveLength(4);
    expect(calls).toEqual(
      expect.arrayContaining([
        "execute:scheduled-email:a",
        "recover:scheduled-email:b",
        "begin:scheduled-email:c",
        "recover:scheduled-email:d",
      ]),
    );
  });
});

it.effect("attempts the complete bounded batch before reporting invalid recovery results", () => {
  const calls = new Array<string>();
  const directory = {
    beginScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) =>
      encodedResult(payload, "waiting"),
    executeScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(payload.workflowId);
      return { state: "not-a-state" };
    },
    recoverScheduledEmail: async (payload: ScheduledEmail.WorkflowPayload) => {
      calls.push(payload.workflowId);
      return encodedResult(payload, "sending");
    },
  };
  return Effect.gen(function* () {
    const repairResult = yield* repair(
      [candidate("c", "due"), candidate("d", "claimed")],
      directory,
    ).pipe(Effect.result);
    expect(calls).toHaveLength(2);
    expect(repairResult).toMatchObject({
      failure: { message: "Scheduled Email reconciliation is unavailable", operation: "batch" },
    });
  });
});
