/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the returned Effect. */
import type { PendingApproval } from "@cloudflare/think";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { presentOsfoAction, scheduledEmailStartActionName } from "./action-presentation";
import {
  decodeGmailActionInput,
  decodeScheduledEmailActionInput,
  sanitizePendingApproval,
} from "./action-registry";
import { UserId } from "../../domain";
import { decodeReminderActionInput } from "./reminder-tools";
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

it.effect("normalizes a pre-deploy parked Gmail Action through presentation and resume", () =>
  Effect.gen(function* () {
    const legacyInput = {
      body: "Legacy parked body",
      recipients: ["recipient@example.test"],
      subject: "Legacy parked subject",
    } as const;
    const pending = {
      descriptor: {
        action: "gmailSendEmail",
        input: legacyInput,
        kind: "durable-pause",
        permissions: ["integrations:gmail:send"],
        requestId: "request-legacy-gmail",
        risk: "high",
        summary: "Send one legacy parked Gmail Action",
        toolCallId: "tool-call-legacy-gmail",
      },
      executionId: "execution-legacy-gmail",
      source: "action",
    } satisfies PendingApproval;

    const sanitized = sanitizePendingApproval(pending);
    expect(sanitized.descriptor.input).toEqual({ ...legacyInput, gmailResource: "primary" });
    const presentation = yield* presentOsfoAction({
      descriptor: { ...sanitized.descriptor, kind: "durable-pause" },
      executionId: ActionPresentationId.make(sanitized.executionId),
      source: "action",
    });
    expect(presentation.fields).toEqual([
      { label: "Gmail mailbox", name: "gmailResource", value: "primary" },
      { label: "Integration manifest", name: "manifestVersion", value: "gmail-v1" },
      { label: "Recipients", name: "recipients", value: '["recipient@example.test"]' },
      { label: "Subject", name: "subject", value: "Legacy parked subject" },
      { label: "Message", name: "body", value: "Legacy parked body" },
    ]);
    expect(yield* decodeGmailActionInput(legacyInput)).toEqual({
      ...legacyInput,
      gmailResource: "primary",
    });
  }),
);

it.effect("preserves exact Reminder facts through pending sanitization and durable resume", () =>
  Effect.gen(function* () {
    const input = {
      _tag: "CreateOneTime",
      body: "Exact private Reminder body",
      firstDueAt: "2026-09-06T12:00:00.000Z",
    } as const;
    const pending = {
      descriptor: {
        action: "osfoManageReminder",
        input: { ...input, untrustedExtra: "excluded" },
        kind: "durable-pause",
        permissions: ["reminders:manage"],
        requestId: "reminder-rpc-request",
        risk: "medium",
        summary: "Create Reminder",
        toolCallId: "reminder-rpc-action",
      },
      executionId: "reminder-rpc-presentation",
      source: "action",
    } satisfies PendingApproval;
    const sanitized = sanitizePendingApproval(pending);
    expect(sanitized.descriptor.input).toEqual(input);
    const projected = yield* presentOsfoAction(
      {
        descriptor: { ...sanitized.descriptor, kind: "durable-pause" },
        executionId: ActionPresentationId.make(sanitized.executionId),
        source: "action",
      },
      undefined,
      UserId.make("reminder-rpc-owner"),
    );
    expect(projected.fields).toContainEqual({ label: "Body", name: "body", value: input.body });
    expect(projected.fields).toContainEqual({
      label: "First due",
      name: "firstDueAt",
      value: input.firstDueAt,
    });
    const resumed = yield* decodeReminderActionInput(sanitized.descriptor.input);
    expect(resumed.firstDueAt.toISOString()).toBe(input.firstDueAt);
    expect(yield* decodeReminderActionInput(resumed)).toEqual(resumed);
  }),
);
