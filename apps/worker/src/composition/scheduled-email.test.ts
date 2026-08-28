/* oxlint-disable effecttsgo/global-date, vitest/no-standalone-expect -- Fixed Workflow boundary fixtures execute inside Effects. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { AgentId } from "../domain";
import { ScheduledEmail } from "../services/scheduled-email";
import { makeWorkflowPort, type WorkflowBinding } from "./scheduled-email";

const payload = ScheduledEmail.WorkflowPayload.make({
  agentId: AgentId.make("scheduled-email-agent"),
  dueAt: new Date("2026-08-28T12:00:00.000Z"),
  inputDigest: ScheduledEmail.InputDigest.make("a".repeat(64)),
  workflowId: ScheduledEmail.WorkflowId.make("scheduled-email:boundary"),
});
const instanceId = ScheduledEmail.CloudflareInstanceId.make("scheduled-email-boundary");

it.effect("encodes ISO Workflow params at the Cloudflare JSON boundary", () => {
  let retained: ScheduledEmail.EncodedWorkflowPayload | null = null;
  const binding: WorkflowBinding = {
    create: ({ params }) => {
      retained = params;
      return Promise.resolve(handle("queued"));
    },
    get: () => Promise.resolve(handle("unknown")),
  };
  return Effect.gen(function* () {
    yield* makeWorkflowPort(binding).create(instanceId, payload);
    expect(retained).toEqual({ ...payload, dueAt: payload.dueAt.toISOString() });
  });
});

it.effect("restarts errored or terminated instances instead of accepting dead hosts", () => {
  const restarted = new Array<string>();
  const binding = (status: "errored" | "terminated"): WorkflowBinding => ({
    create: () => Promise.reject(new Error("acknowledgement lost")),
    get: () =>
      Promise.resolve({
        restart: () => {
          restarted.push(status);
          return Promise.resolve();
        },
        status: () => Promise.resolve({ status }),
        terminate: () => Promise.resolve(),
      }),
  });
  return Effect.gen(function* () {
    yield* makeWorkflowPort(binding("errored")).create(instanceId, payload);
    yield* makeWorkflowPort(binding("terminated")).create(instanceId, payload);
    expect(restarted).toEqual(["errored", "terminated"]);
  });
});

const handle = (status: "queued" | "unknown") => ({
  restart: () => Promise.resolve(),
  status: () => Promise.resolve({ status }),
  terminate: () => Promise.resolve(),
});
