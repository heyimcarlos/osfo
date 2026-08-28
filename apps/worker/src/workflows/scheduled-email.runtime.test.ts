/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, vitest/no-standalone-expect -- Promise-only fakes model the Cloudflare Workflow host with fixed timestamps. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AgentId } from "../domain";
import { ScheduledEmail } from "../services/scheduled-email";
import { runScheduledEmailHost, type ScheduledEmailWorkflowStep } from "./scheduled-email";

const payload = ScheduledEmail.WorkflowPayload.make({
  agentId: AgentId.make("scheduled-email-agent"),
  dueAt: new Date("2026-08-28T12:00:00.000Z"),
  inputDigest: ScheduledEmail.InputDigest.make("a".repeat(64)),
  workflowId: ScheduledEmail.WorkflowId.make("scheduled-email:workflow-host"),
});
const encodedPayload = {
  ...payload,
  dueAt: payload.dueAt.toISOString(),
};

const encodedResult = (state: ScheduledEmail.State, dueAt = payload.dueAt) => ({
  dueAt: dueAt.toISOString(),
  sendStartedAt: state === "waiting" ? null : new Date("2026-08-28T13:00:00.000Z").toISOString(),
  state,
  terminalAt: ScheduledEmail.terminalStates.has(state)
    ? new Date("2026-08-28T13:00:01.000Z").toISOString()
    : null,
  workflowId: payload.workflowId,
});

const makeStep = (sleeps: Array<Date | number>): ScheduledEmailWorkflowStep => ({
  do: (_name, callback) => callback(),
  sleepUntil: async (_name, timestamp) => {
    sleeps.push(timestamp);
  },
});

it("sleeps on authoritative PostgreSQL dueAt when the Workflow payload is stale", async () => {
  const sleeps = new Array<Date | number>();
  const storedDueAt = new Date("2026-08-28T13:00:00.000Z");
  const instanceId = await Effect.runPromise(
    ScheduledEmail.cloudflareInstanceIdFor(payload.workflowId),
  );
  const result = await runScheduledEmailHost(
    { instanceId, payload: encodedPayload },
    makeStep(sleeps),
    {
      beginScheduledEmail: async () => encodedResult("waiting", storedDueAt),
      executeScheduledEmail: async () => encodedResult("success", storedDueAt),
    },
  );

  expect(sleeps[0]).toEqual(storedDueAt);
  expect(result).toMatchObject({ dueAt: storedDueAt, state: "success" });
});

it("bounds in-host ambiguity polling and leaves truthful nonterminal state for minute repair", async () => {
  const sleeps = new Array<Date | number>();
  let executions = 0;
  const instanceId = await Effect.runPromise(
    ScheduledEmail.cloudflareInstanceIdFor(payload.workflowId),
  );
  const result = await runScheduledEmailHost(
    { instanceId, payload: encodedPayload },
    makeStep(sleeps),
    {
      beginScheduledEmail: async () => encodedResult("waiting"),
      executeScheduledEmail: async () => {
        executions += 1;
        return encodedResult("send_pending_reconciliation");
      },
    },
  );

  expect(executions).toBe(5);
  expect(sleeps).toHaveLength(5);
  expect(result).toMatchObject({ state: "send_pending_reconciliation", terminalAt: null });
});

it("rejects a Workflow instance that does not match the durable Workflow identity", async () => {
  const directory = {
    beginScheduledEmail: async () => encodedResult("waiting"),
    executeScheduledEmail: async () => encodedResult("success"),
  };
  await expect(
    runScheduledEmailHost(
      { instanceId: "scheduled-email-wrong", payload: encodedPayload },
      makeStep([]),
      directory,
    ),
  ).rejects.toThrow("instance identity is invalid");
});
