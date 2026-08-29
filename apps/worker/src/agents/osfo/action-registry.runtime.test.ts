/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the returned Effect. */
import type { PendingApproval } from "@cloudflare/think";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { presentOsfoAction, scheduledEmailStartActionName } from "./action-presentation";
import { decodeScheduledEmailActionInput, sanitizePendingApproval } from "./action-registry";
import { ActionPresentationId } from "./think-action-approvals";

it.effect("preserves encoded Scheduled Email input through the pending Approval boundary", () =>
  Effect.gen(function* () {
    const pending = {
      descriptor: {
        action: scheduledEmailStartActionName,
        input: {
          body: "Exact scheduled body",
          gmailResource: "primary",
          recipients: ["recipient@example.test"],
          scheduledAt: "2026-09-01T16:00:00.000Z",
          subject: "Exact scheduled subject",
        },
        kind: "durable-pause",
        permissions: ["workflows:start", "integrations:gmail:send"],
        requestId: "request-scheduled-email-rpc",
        risk: "high",
        summary: "Schedule the exact Gmail message shown",
        toolCallId: "tool-call-scheduled-email-rpc",
      },
      executionId: "execution-scheduled-email-rpc",
      source: "action",
    } satisfies PendingApproval;

    const sanitized = sanitizePendingApproval(pending);
    expect(sanitized.descriptor.input).toEqual(pending.descriptor.input);
    expect(sanitized).toMatchObject({ descriptor: { kind: "durable-pause" }, source: "action" });
    const projected = yield* presentOsfoAction({
      descriptor: { ...sanitized.descriptor, kind: "durable-pause" },
      executionId: ActionPresentationId.make(sanitized.executionId),
      source: "action",
    });

    expect(projected).toMatchObject({
      actionDefinitionVersion: "osfo-scheduled-email-start-v1",
      operation: "integration.effect",
      title: "Schedule Gmail message",
    });
  }),
);

it.effect("decodes retained Scheduled Email input before approved Action execution", () =>
  Effect.gen(function* () {
    const retained = {
      body: "Exact scheduled body",
      gmailResource: "primary",
      recipients: ["recipient@example.test"],
      scheduledAt: "2026-09-01T16:00:00.000Z",
      subject: "Exact scheduled subject",
    } as const;
    const resumed = yield* decodeScheduledEmailActionInput(retained);
    const initial = yield* decodeScheduledEmailActionInput({
      ...retained,
      scheduledAt: resumed.scheduledAt,
    });

    expect(resumed).toEqual(initial);
    expect(resumed.scheduledAt.toISOString()).toBe(retained.scheduledAt);
  }),
);
