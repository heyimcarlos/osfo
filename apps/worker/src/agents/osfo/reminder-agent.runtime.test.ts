/* oxlint-disable effecttsgo/async-function -- Durable Object and Agents scheduler test boundaries are Promise APIs. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Effect, Schema } from "effect";

import { AgentId, ThinkSubmissionId, UserId } from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { IncidentControlsPostgres } from "../../integrations/postgres/incident-controls";
import { IncidentControls } from "../../services/incident-controls";
import { OsfoAgent } from "./agent";

// This runtime has no PostgreSQL authority; keep optional provider recall unavailable.
beforeEach(() => {
  vi.spyOn(IncidentControlsPostgres, "check").mockReturnValue(
    Effect.fail(
      new IncidentControls.Unavailable({ cause: new Error("No runtime PostgreSQL authority") }),
    ),
  );
});
afterEach(() => vi.restoreAllMocks());

it("registers Reminder Action/tools and decodes only the public scheduler payload", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Generated production Env types omit the checked test binding.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("reminder-runtime-agent"),
  );

  await runInDurableObject(stub, async (_boundAgent, state) => {
    const agent = new OsfoAgent(state, runtimeEnv);
    await agent.initialize({
      agentId: AgentId.make("reminder-runtime-agent"),
      initializationId: "reminder-runtime-initialization",
      initializedAt: "2026-08-27T12:00:00.000Z",
      routeId: "reminder-runtime-route",
      sessionId: "reminder-runtime-session",
    });
    await agent.onStart();

    expect(agent.getActions()).toHaveProperty("osfoManageReminder");
    expect(agent.getTools()).toEqual(
      expect.objectContaining({
        osfoCancelReminder: expect.any(Object),
        osfoInspectReminder: expect.any(Object),
      }),
    );
    await expect(
      agent.deliverReminder({ body: "private content must never be accepted" }),
    ).rejects.toBeDefined();
    await expect(
      agent.deliverReminder({
        nominalDueAt: "2026-08-28T12:00:00.000Z",
        reminderId: "absent-reminder",
        revision: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(agent.pendingReminderWakeUpSources("runtime-user")).resolves.toEqual([]);

    state.storage.sql.exec(
      `INSERT INTO osfo_reminders (
         reminder_id, owner_user_id, creation_action_id, created_at, revision,
         schedule_kind, body, first_due_at, next_due_at, interval_milliseconds,
         state, callback_capability, scheduler_id, original_period_id,
         policy_version, plan, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'oneTime', ?, ?, ?, NULL,
                 'active', ?, ?, ?, 'launch-v1', 'free', ?)`,
      "runtime-direct-rpc",
      "runtime-user",
      "runtime-direct-rpc-action",
      "2026-08-27T11:00:00.000Z",
      "Direct RPC must not deliver this body.",
      "2026-08-27T12:00:00.000Z",
      "2026-08-27T12:00:00.000Z",
      "0000000000000000000000000000000000000000000000000000000000000002",
      "runtime-direct-rpc-schedule",
      "runtime-period",
      "2026-08-27T11:00:00.000Z",
    );
    await expect(
      agent.deliverReminder({
        nominalDueAt: "2026-08-27T12:00:00.000Z",
        reminderId: "runtime-direct-rpc",
        revision: 1,
      }),
    ).resolves.toBeUndefined();
    expect(
      state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM osfo_reminder_occurrences
            WHERE reminder_id = 'runtime-direct-rpc'`,
        )
        .one().count,
    ).toBe(0);

    state.storage.sql.exec(
      `INSERT INTO osfo_reminders (
         reminder_id, owner_user_id, creation_action_id, created_at, revision,
         schedule_kind, body, first_due_at, next_due_at, interval_milliseconds,
         state, scheduler_id, original_period_id, policy_version, plan, updated_at
       ) VALUES (?, ?, ?, ?, 1, 'oneTime', ?, ?, NULL, NULL,
                 'completed', NULL, ?, 'launch-v1', 'free', ?)`,
      "runtime-reminder",
      "runtime-user",
      "runtime-reminder-action",
      "2026-08-27T11:00:00.000Z",
      "private authority body",
      "2026-08-27T12:00:00.000Z",
      "runtime-period",
      "2026-08-27T12:00:01.000Z",
    );
    state.storage.sql.exec(
      `INSERT INTO osfo_reminder_occurrences (
         reminder_id, revision, nominal_due_at, owner_user_id, channel_link_id,
         source_identity, body_snapshot, schedule_kind, original_period_id,
         policy_version, callback_capability, committed_at
       ) VALUES (?, 1, ?, ?, ?, ?, ?, 'oneTime', ?, 'launch-v1', ?, ?)`,
      "runtime-reminder",
      "2026-08-27T12:00:00.000Z",
      "runtime-user",
      "runtime-whatsapp-link",
      "reminder:runtime:first",
      "Pay the electricity bill.",
      "runtime-period",
      "0000000000000000000000000000000000000000000000000000000000000001",
      "2026-08-27T12:00:01.000Z",
    );
    await agent.exposeReminderWakeUpSources("runtime-user", [
      {
        committedAt: "2026-08-27T12:00:01.000Z",
        sourceIdentity: "reminder:runtime:first",
      },
    ]);
    const metadata = reminderTurnMetadata();
    const userMessage: UIMessage = {
      id: "reminder-runtime-message",
      metadata: { turnMetadata: metadata },
      parts: [{ text: "I am back", type: "text" }],
      role: "user",
    };
    await agent.addMessages([userMessage]);
    const turn = await agent.beforeTurn({
      continuation: false,
      messages: [{ content: "I am back", role: "user" }] satisfies Array<ModelMessage>,
      model: new MockLanguageModelV4(),
      system: "",
      tools: agent.getTools(),
    });
    expect(turn.instructions).toContain("## Due Reminder facts");
    expect(turn.instructions).toContain("Pay the electricity bill.");
    expect(turn.instructions).not.toContain("reminder:runtime:first");
    expect(turn.instructions).not.toContain("2026-08-27T12:00:01.000Z");
    expect(turn.messages).toEqual([{ content: "I am back", role: "user" }]);
    const continuation = await agent.beforeTurn({
      continuation: true,
      messages: [{ content: "I am back", role: "user" }] satisfies Array<ModelMessage>,
      model: new MockLanguageModelV4(),
      system: "",
      tools: agent.getTools(),
    });
    expect(continuation.instructions).toContain("Pay the electricity bill.");
    await expect(agent.inspectReminderVerificationState("runtime-user")).resolves.toEqual(
      expect.objectContaining({
        activeScheduleBindingCount: 1,
        agentScheduleCount: 0,
        occurrenceCount: 1,
        occurrences: [
          expect.objectContaining({
            callbackCapabilityRevokedAt: null,
            committedAt: "2026-08-27T12:00:01.000Z",
            exposedAt: expect.any(String),
            nominalDueAt: "2026-08-27T12:00:00.000Z",
            sourceIdentity: "reminder:runtime:first",
            sourceRevokedAt: null,
            thinkPresentedAt: expect.any(String),
            thinkSubmissionId: "reminder-runtime-submission",
          }),
        ],
        reminderCount: 2,
      }),
    );
  });
});

const reminderTurnMetadata = (): ManagedTurnMetadata =>
  Schema.decodeSync(ManagedTurnMetadata)({
    _tag: "OsfoManagedTurn",
    allowancePeriodId: "runtime-period",
    authorityIdentity: {
      _tag: "AuthSession",
      authSessionId: "reminder-runtime-auth-session",
      userId: UserId.make("runtime-user"),
    },
    capabilityCatalogVersion: "governed-capabilities-v1",
    conservativeVendorUsdMicros: 100,
    coreMemoryAuthorization: {
      authority: {
        _tag: "AuthSession",
        authSessionId: "reminder-runtime-auth-session",
        expiresAt: "2026-08-27T13:00:00.000Z",
        userId: "runtime-user",
      },
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: "2026-08-27T12:00:00.000Z",
      originatingAuthority: {
        _tag: "AuthSession",
        authSessionId: "reminder-runtime-auth-session",
      },
      resourceOwnerUserId: "runtime-user",
      subscription: { plan: "free", planPolicyVersion: "launch-v1" },
      user: { _tag: "ActiveUser", userId: "runtime-user" },
    },
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    maxSteps: 5,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "reminder-runtime-auth-session",
    },
    plan: "free",
    planPolicyVersion: "launch-v1",
    route: "@cf/test/model",
    routeId: "reminder-runtime-route",
    sessionId: "reminder-runtime-session",
    submissionId: ThinkSubmissionId.make("reminder-runtime-submission"),
    targetInputTokens: 18_000,
  });
