/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/strict-effect-provide, vitest/no-standalone-expect -- These tests own native PostgreSQL clients and deterministic lifecycle timestamps. */
/* oxlint-disable eslint/no-underscore-dangle -- Assertions inspect canonical tagged outcomes. */
import { createDb, type Database } from "@osfo/db";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { sessions, users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelLinks } from "@osfo/db/schema/channel-links";
import { documentBuilds } from "@osfo/db/schema/document-builds";
import { researchReports } from "@osfo/db/schema/research-reports";
import { scheduledEmails } from "@osfo/db/schema/scheduled-emails";
import { deletionCases } from "@osfo/db/schema/user-lifecycle";
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { Effect, Layer, Result } from "effect";
import { TestClock } from "effect/testing";
import postgres from "postgres";

import {
  AgentId,
  AllowancePeriodId,
  ChannelLinkId,
  ManifestVersion,
  SessionId,
  ThinkSubmissionId,
  UserId,
} from "../../src/domain";
import { ActionId } from "../../src/domain/action-execution";
import { AuthSessionId } from "../../src/domain/auth-session";
import { quiesceWorkflows } from "../../src/composition/account-deletion";
import type { Bindings } from "../../src/composition/account-deletion";
import { scheduledEmailSourceAuthority } from "../../src/composition/whatsapp-wakeups";
import { ScheduledEmailFollowUpPostgres } from "../../src/integrations/postgres/scheduled-email-follow-up";
import { ScheduledEmailPostgres } from "../../src/integrations/postgres/scheduled-email";
import { ScheduledEmail } from "../../src/services/scheduled-email";
import { ScheduledEmailFollowUp } from "../../src/services/scheduled-email-follow-up";
import type { IntegrationEffectCompleted } from "../../src/services/integrations";
import { makeRecord } from "../../src/services/scheduled-email-test-fixture";
import { WhatsAppWakeUps } from "../../src/services/whatsapp-wakeups";

const admittedAt = new Date("2026-08-28T11:00:00.000Z");
const dueAt = new Date("2026-08-28T12:00:00.000Z");
const sendAt = new Date("2026-08-28T12:00:01.000Z");

it.effect("counts Research, Document, and Scheduled Email under one serialized active limit", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const identity = "shared-active";
      const seeded = yield* seedUser(database, identity);
      yield* Effect.promise(() =>
        database.insert(researchReports).values(researchRow(seeded, identity)),
      );
      yield* Effect.promise(() =>
        database.insert(documentBuilds).values(documentRow(seeded, identity)),
      );
      const result = yield* ScheduledEmailPostgres.make(database)
        .admit(record(seeded, identity), 2n)
        .pipe(Effect.result);
      expect(result).toMatchObject({
        failure: { _tag: "Denied", reason: "liveResourceLimitReached" },
      });
    }),
  ),
);

it.effect("serializes cancel against the irreversible beginSend claim", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "cancel-race");
      const email = record(seeded, "cancel-race");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* TestClock.setTime(sendAt.getTime());
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      const [send, cancel] = yield* Effect.all(
        [
          persistence.beginSend(email.workflowId, email.inputDigest, sendAt).pipe(Effect.result),
          persistence.requestCancel(email.workflowId, email.userId, sendAt).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      const retained = yield* persistence.inspect(email.workflowId);
      expect(retained?.cancelRequestedAt).not.toBeNull();
      expect(retained?.state === "waiting" || retained?.state === "sending").toBe(true);
      if (retained?.state === "waiting") {
        expect(send).toMatchObject({ failure: { _tag: "ScheduledEmailConflict" } });
      } else {
        expect(send).toMatchObject({ success: { state: "sending" } });
      }
      expect(cancel).toMatchObject({ success: { cancelRequestedAt: sendAt } });
      yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "canceled",
        null,
        "test-cleanup",
        sendAt,
      );
    }),
  ),
);

it.effect("continues claimed reconciliation after deletion fencing and unblocks quiescence", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "fenced-recovery");
      const claimedCandidate = record(seeded, "fenced-claimed");
      const claimed = {
        ...claimedCandidate,
        cloudflareInstanceId: yield* ScheduledEmail.cloudflareInstanceIdFor(
          claimedCandidate.workflowId,
        ),
      };
      const due = record(seeded, "fenced-due");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* TestClock.setTime(sendAt.getTime());
      yield* persistence.admit(claimed, 5n);
      yield* persistence.markWaiting(claimed.workflowId, claimed.inputDigest, admittedAt);
      yield* persistence.beginSend(claimed.workflowId, claimed.inputDigest, sendAt);
      yield* persistence.admit(due, 5n);
      yield* persistence.markWaiting(due.workflowId, due.inputDigest, admittedAt);
      yield* insertDeletionFence(database, seeded, "fenced-recovery");

      const terminated = new Array<string>();
      const bindings = deletionBindings(terminated);
      const { SCHEDULED_EMAIL_WORKFLOW: omittedScheduledEmailWorkflow, ...missingBindings } =
        bindings;
      expect(omittedScheduledEmailWorkflow).toBeDefined();
      const missingScheduled = yield* quiesceWorkflows(
        missingBindings,
        database,
        seeded.userId,
      ).pipe(Effect.result);
      expect(missingScheduled).toMatchObject({
        failure: { operation: "quiesceWorkflows" },
      });
      const firstQuiescence = yield* quiesceWorkflows(bindings, database, seeded.userId).pipe(
        Effect.result,
      );
      expect(Result.isFailure(firstQuiescence)).toBe(true);
      if (Result.isFailure(firstQuiescence)) {
        expect(firstQuiescence.failure.message).toBe(
          "A claimed Scheduled Email send is still reconciling",
        );
        expect(firstQuiescence.failure.operation).toBe("quiesceWorkflows");
      }
      expect(terminated).toContain(due.cloudflareInstanceId);
      const candidates = yield* ScheduledEmailPostgres.reconciliationBatch(
        database,
        new Date("2026-08-28T12:01:00.000Z"),
        20,
      );
      expect(candidates).toContainEqual(
        expect.objectContaining({ kind: "claimed", workflowId: claimed.workflowId }),
      );
      expect(candidates.some(({ workflowId }) => workflowId === due.workflowId)).toBe(false);

      let providerCalls = 0;
      const port = ScheduledEmail.Port.of({
        commitTerminalFollowUp: () => Effect.void,
        currentAuthorization: ScheduledEmailPostgres.makeCurrentAuthorization(database),
        persistence,
        reconcileSend: () => Effect.succeed({ _tag: "NotStarted" }),
        recordSendOutcome: () => Effect.void,
        recordWorkflowStart: () => Effect.void,
        send: (_email, authorize) =>
          authorize.pipe(
            Effect.andThen(
              Effect.sync(() => {
                providerCalls += 1;
                return applied;
              }),
            ),
          ),
        workflow: { create: () => Effect.void, terminate: () => Effect.void },
      });
      const recovered = yield* ScheduledEmail.Service.pipe(
        Effect.flatMap((emails) => emails.recoverClaimed(payloadFor(claimed))),
        Effect.provide(
          ScheduledEmail.layerWithoutDependencies.pipe(
            Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
          ),
        ),
      );
      expect(recovered).toMatchObject({ safeFailureCode: "authority-ended", state: "canceled" });
      expect(providerCalls).toBe(0);
      expect(
        yield* ScheduledEmailPostgres.quiesceForAccountDeletion(database, seeded.userId, sendAt),
      ).toMatchObject({ _tag: "Ready" });
    }),
  ),
);

it.effect("retargets terminal delivery before acceptance and fences every later write", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "follow-up-locking");
      const email = record(seeded, "follow-up-locking");
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      const terminal = yield* persistence.finishTerminal(
        email.workflowId,
        email.inputDigest,
        "failure",
        "notApplied",
        "send-not-applied",
        sendAt,
      );
      const followUps = ScheduledEmailFollowUpPostgres.make(database);
      const notificationId = ScheduledEmailFollowUp.NotificationId.make(
        `${email.workflowId}-terminal`,
      );
      expect(yield* followUps.claimTerminal(terminal, notificationId, sendAt)).toMatchObject({
        _tag: "Claimed",
      });
      expect(
        (yield* followUps.selectDeliverySession(notificationId, SessionId.make("first-session")))
          .deliverySessionId,
      ).toBe("first-session");
      expect(
        (yield* followUps.selectDeliverySession(notificationId, SessionId.make("current-session")))
          .deliverySessionId,
      ).toBe("current-session");
      yield* followUps.markAccepted(
        notificationId,
        ThinkSubmissionId.make("scheduled-email-terminal-submission"),
        sendAt,
      );
      expect(
        yield* followUps
          .selectDeliverySession(notificationId, SessionId.make("too-late-session"))
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ScheduledEmailFollowUpUnavailable" } });
      yield* insertDeletionFence(database, seeded, "follow-up-locking");
      expect(
        yield* followUps
          .markAccepted(
            notificationId,
            ThinkSubmissionId.make("scheduled-email-terminal-submission"),
            sendAt,
          )
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "ScheduledEmailFollowUpUnavailable" } });
    }),
  ),
);

it.effect("retains one exact WhatsApp terminal source and rejects revoked or deleted links", () =>
  withDatabase((database) =>
    Effect.gen(function* () {
      const seeded = yield* seedUser(database, "whatsapp-source");
      const channelLinkId = ChannelLinkId.make("scheduled-email-whatsapp-source");
      yield* Effect.promise(() =>
        database.insert(channelLinks).values({
          author_id: "whatsapp-source-author",
          channel_id: "whatsapp",
          channel_link_id: channelLinkId,
          user_id: seeded.userId,
        }),
      );
      const email = {
        ...record(seeded, "whatsapp-source"),
        originatingAuthority: { _tag: "ChannelLink" as const, channelLinkId },
      };
      const persistence = ScheduledEmailPostgres.make(database);
      yield* persistence.admit(email, 5n);
      yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
      yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
      const terminal = yield* persistence.finishApplied(
        email.workflowId,
        email.inputDigest,
        applied,
        sendAt,
      );
      const followUps = ScheduledEmailFollowUpPostgres.make(database);
      const notificationId = ScheduledEmailFollowUp.NotificationId.make(
        `${email.workflowId}-terminal`,
      );
      const firstClaim = yield* followUps.claimTerminal(terminal, notificationId, sendAt);
      const replayedClaim = yield* followUps.claimTerminal(terminal, notificationId, sendAt);
      expect(firstClaim).toEqual(replayedClaim);
      expect(firstClaim).toMatchObject({
        _tag: "Claimed",
        notification: { whatsAppChannelLinkId: channelLinkId },
      });
      const submissionId = ThinkSubmissionId.make("scheduled-email-whatsapp-submission");
      const accepted = yield* followUps.markAccepted(notificationId, submissionId, sendAt);
      expect(yield* followUps.markAccepted(notificationId, submissionId, sendAt)).toEqual(accepted);

      const source = WhatsAppWakeUps.Source.cases.ScheduledEmail.make({
        identity: WhatsAppWakeUps.SourceIdentity.make(notificationId),
      });
      const authority = scheduledEmailSourceAuthority(database);
      const retained = yield* authority.inspect(seeded.userId, source);
      expect(retained).toEqual({ committedAt: sendAt, source });
      expect(yield* authority.inspect(seeded.userId, source)).toEqual(retained);

      yield* Effect.promise(() =>
        database
          .update(channelLinks)
          .set({
            revocation_reason: "User disconnected WhatsApp",
            revoked_at: sendAt,
            revoked_by: `user:${seeded.userId}`,
          })
          .where(eq(channelLinks.channel_link_id, channelLinkId)),
      );
      expect(yield* authority.inspect(seeded.userId, source)).toBeNull();
      expect(yield* authority.pendingForUser(seeded.userId)).toEqual([]);
      yield* Effect.promise(() =>
        database.delete(channelLinks).where(eq(channelLinks.channel_link_id, channelLinkId)),
      );
      expect(yield* authority.inspect(seeded.userId, source)).toBeNull();
    }),
  ),
);

it.effect(
  "rotates a bounded reconciliation batch so the twenty-first claimed send is not starved",
  () =>
    withDatabase((database) =>
      Effect.gen(function* () {
        const seeded = yield* seedUser(database, "repair-fairness");
        const persistence = ScheduledEmailPostgres.make(database);
        const emails = Array.from({ length: 21 }, (_, index) =>
          record(seeded, `repair-fairness-${index + 1}`),
        );
        for (const [index, email] of emails.entries()) {
          yield* persistence.admit(email, 30n);
          yield* persistence.markWaiting(email.workflowId, email.inputDigest, admittedAt);
          yield* persistence.beginSend(email.workflowId, email.inputDigest, sendAt);
          yield* Effect.promise(() =>
            database
              .update(scheduledEmails)
              .set({ updated_at: new Date(`2026-08-27T${String(index).padStart(2, "0")}:00:00Z`) })
              .where(eq(scheduledEmails.workflow_id, email.workflowId)),
          );
        }
        const first = yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date("2026-08-28T12:01:00.000Z"),
          20,
        );
        const second = yield* ScheduledEmailPostgres.reconciliationBatch(
          database,
          new Date("2026-08-28T12:02:00.000Z"),
          20,
        );
        expect(first).toHaveLength(20);
        expect(first.some(({ workflowId }) => workflowId === emails[20]?.workflowId)).toBe(false);
        expect(second.some(({ workflowId }) => workflowId === emails[20]?.workflowId)).toBe(true);
        expect(second.every(({ kind }) => kind === "claimed")).toBe(true);
      }),
    ),
);

interface SeededUser {
  readonly agentId: AgentId;
  readonly allowancePeriodId: AllowancePeriodId;
  readonly authSessionId: AuthSessionId;
  readonly userId: UserId;
}

const withDatabase = <Value, Failure>(use: (database: Database) => Effect.Effect<Value, Failure>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => postgres(env.DB.connectionString, { max: 4, prepare: false })),
      (client) => Effect.promise(() => client.end({ timeout: 0 })),
    ).pipe(Effect.map(createDb), Effect.flatMap(use)),
  );

const seedUser = (database: Database, identity: string) => {
  const seeded = {
    agentId: AgentId.make(`scheduled-email-agent-${identity}`),
    allowancePeriodId: AllowancePeriodId.make(`scheduled-email-period-${identity}`),
    authSessionId: AuthSessionId.make(`scheduled-email-auth-${identity}`),
    userId: UserId.make(`scheduled-email-user-${identity}`),
  };
  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      database.insert(users).values({
        email: `${identity}@example.test`,
        emailVerified: true,
        id: seeded.userId,
        name: "Scheduled Email",
      }),
    );
    yield* Effect.promise(() =>
      database.insert(billingSubscriptions).values({
        billing_subscription_id: `scheduled-email-subscription-${identity}`,
        plan: "free",
        plan_policy_version: "launch-v1",
        user_id: seeded.userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(allowancePeriods).values({
        allowance_period_id: seeded.allowancePeriodId,
        billing_subscription_id: `scheduled-email-subscription-${identity}`,
        ends_at: new Date("2027-08-28T12:00:00.000Z"),
        plan: "free",
        plan_policy_version: "launch-v1",
        starts_at: new Date("2026-01-01T00:00:00.000Z"),
        user_id: seeded.userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(agents).values({
        agent_id: seeded.agentId,
        created_at: admittedAt.toISOString(),
        user_id: seeded.userId,
      }),
    );
    yield* Effect.promise(() =>
      database.insert(sessions).values({
        expiresAt: new Date("2027-08-28T12:00:00.000Z"),
        id: seeded.authSessionId,
        token: `scheduled-email-token-${identity}`,
        updatedAt: admittedAt,
        userId: seeded.userId,
      }),
    );
    return seeded;
  });
};

const record = (seeded: SeededUser, identity: string) =>
  makeRecord({
    acceptedAt: admittedAt,
    actionId: ActionId.make(`scheduled-email-action-${identity}`),
    admittedAt,
    agentId: seeded.agentId,
    allowancePeriodId: seeded.allowancePeriodId,
    cloudflareInstanceId: ScheduledEmail.CloudflareInstanceId.make(`scheduled-email-${identity}`),
    dueAt,
    inputDigest: ScheduledEmail.InputDigest.make(
      identity
        .split("")
        .reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0)
        .toString(16)
        .padStart(64, "0")
        .slice(-64),
    ),
    originatingAuthority: { _tag: "AuthSession", authSessionId: seeded.authSessionId },
    plan: "free",
    request: ScheduledEmail.Request.make({
      body: `Body ${identity}`,
      gmailResource: "primary",
      recipients: [`${identity}@example.test`],
      scheduledAt: dueAt,
      subject: `Subject ${identity}`,
    }),
    state: "accepted",
    userId: seeded.userId,
    workflowId: ScheduledEmail.WorkflowId.make(`scheduled-email:${identity}`),
  });

const payloadFor = (email: ScheduledEmail.Record) =>
  ScheduledEmail.WorkflowPayload.make({
    agentId: email.agentId,
    dueAt: email.dueAt,
    inputDigest: email.inputDigest,
    workflowId: email.workflowId,
  });

const insertDeletionFence = (database: Database, seeded: SeededUser, identity: string) =>
  Effect.promise(() =>
    database.insert(deletionCases).values({
      access_fenced_at: sendAt,
      approval_action_id: `delete-action-${identity}`,
      approval_presentation: "Delete Account",
      deletion_case_id: `delete-case-${identity}`,
      reason: "User requested account deletion",
      requested_by_user_id: seeded.userId,
      user_id: seeded.userId,
    }),
  );

const researchRow = (seeded: SeededUser, identity: string) => ({
  action_id: `research-action-${identity}`,
  admitted_at: admittedAt,
  agent_id: seeded.agentId,
  allowance_period_id: seeded.allowancePeriodId,
  capability_catalog_version: "capability-catalog-v1",
  cloudflare_instance_id: `research-${identity}`,
  deadline_at: dueAt,
  input_digest: "1".repeat(64),
  model_access_policy_version: "launch-v1",
  model_route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  originating_authority_json: JSON.stringify({
    _tag: "AuthSession",
    authSessionId: seeded.authSessionId,
  }),
  plan_policy_version: "launch-v1",
  request_json: JSON.stringify({ topic: identity }),
  resource_price_version: "resource-prices-v1",
  route_id: "scheduled-email-route",
  session_id: "scheduled-email-session",
  state: "admitted" as const,
  user_id: seeded.userId,
  workflow_id: `research:${identity}`,
});

const documentRow = (seeded: SeededUser, identity: string) => ({
  action_id: `document-action-${identity}`,
  admitted_at: admittedAt,
  agent_id: seeded.agentId,
  allowance_period_id: seeded.allowancePeriodId,
  capability_catalog_version: "capability-catalog-v1",
  cloudflare_instance_id: `document-${identity}-main`,
  cloudflare_timer_instance_id: `document-${identity}-timer`,
  deadline_at: dueAt,
  input_digest: "2".repeat(64),
  model_access_policy_version: "launch-v1",
  model_route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  originating_authority_json: JSON.stringify({
    _tag: "AuthSession",
    authSessionId: seeded.authSessionId,
  }),
  plan_policy_version: "launch-v1",
  request_json: JSON.stringify({ description: identity, format: "pdf", title: identity }),
  resource_price_version: "resource-prices-v1",
  route_id: "scheduled-email-route",
  session_id: "scheduled-email-session",
  state: "admitted" as const,
  user_id: seeded.userId,
  workflow_id: `document:${identity}`,
});

const applied: IntegrationEffectCompleted = {
  _tag: "IntegrationEffectCompleted" as const,
  evidence: { providerLogId: "gmail-log", providerResourceId: "gmail-message" },
  manifestVersion: ManifestVersion.make("gmail-v1"),
  mutations: 1 as const,
  operation: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
};

const deletionBindings = (terminated: Array<string>): Bindings => {
  const binding = {
    create: async () => ({
      restart: async () => undefined,
      status: async () => ({ status: "running" as const }),
      terminate: async () => undefined,
    }),
    get: async (id: string) => ({
      restart: async () => undefined,
      status: async () => ({ status: "running" as const }),
      terminate: async () => {
        terminated.push(id);
      },
    }),
  };
  return {
    DOCUMENT_BUILD_TIMER_WORKFLOW: binding,
    DOCUMENT_BUILD_WORKFLOW: binding,
    integrationAuthorityDeletion: { _tag: "NotDelivered" },
    OSFO_DIRECTORY: {
      getByName: () => ({
        deleteAgent: async () => undefined,
        quiesceAgentAccountDeletion: async () => undefined,
      }),
    },
    RESEARCH_REPORT_TIMER_WORKFLOW: binding,
    RESEARCH_REPORT_WORKFLOW: binding,
    SCHEDULED_EMAIL_WORKFLOW: binding,
  };
};
