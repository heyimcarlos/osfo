/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch-in-effect, effecttsgo/global-timers, effecttsgo/new-promise, effecttsgo/prefer-schema-over-json, osfo/no-runtime-typeof -- This composed journey intentionally constructs raw public HTTP payloads and polls observable local boundaries. */
import { env } from "cloudflare:workers";
import { expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { Effect, Schema } from "effect";

import { OsfoAgent } from "../../src/agents/osfo/agent";
import { OSFO_DIRECTORY_NAME } from "../../src/agents/osfo/identity";
import {
  AllowancePeriodId,
  ConversationRouteId,
  PlanPolicyVersion,
  ThinkSubmissionId,
  UserId,
} from "../../src/domain";
import { AuthSessionId } from "../../src/domain/auth-session";
import { emptyLiveResourceFacts } from "../../src/services/authorization";
import { spawnApp } from "../support/spawn-app";

const AuthSessionResponse = Schema.Struct({ session: Schema.Struct({ id: Schema.String }) });

it.effect(
  "uses trusted Agent setup, then proves public immediate Gmail approval and status HTTP",
  () =>
    Effect.gen(function* () {
      const app = yield* Effect.acquireRelease(Effect.promise(spawnApp), (client) =>
        Effect.promise(client.dispose),
      );
      const identity = yield* Effect.promise(() => app.auth.mintVerifiedUser());

      const checkout = yield* Effect.promise(app.billing.checkout);
      if (checkout.body === undefined) throw new Error("Checkout did not return a hosted URL");
      const checkoutUrl = checkout.body.url;
      const completedCheckout = yield* Effect.promise(() =>
        fetch(checkoutUrl, { method: "POST", redirect: "manual" }),
      );
      expect(completedCheckout.status).toBe(303);
      const reconciled = yield* Effect.promise(() =>
        app.fetch("/v1/billing/reconcile", {
          body: JSON.stringify({
            reason: "checkoutReturn",
            stripeCheckoutSessionId: "cs_test_emulated",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      expect(reconciled.status).toBe(200);

      const connection = yield* Effect.promise(app.integrations.connectGmail);
      if (connection.body === undefined) throw new Error("Gmail connect returned no hosted URL");
      const connectionUrl = connection.body.url;
      const connected = yield* Effect.promise(() =>
        fetch(connectionUrl, { method: "POST", redirect: "manual" }),
      );
      expect(connected.status).toBe(303);

      const sessionResponse = yield* Effect.promise(app.auth.session);
      const session = yield* Schema.decodeUnknownEffect(AuthSessionResponse)(
        yield* Effect.promise(() => sessionResponse.json()),
      );
      const registration = yield* Effect.promise(() => app.database.registration(identity.userId));
      if (registration === null) throw new Error("Registered User facts were not observable");
      if (
        registration.allowance_plan !== "adventurer" ||
        registration.billing_plan !== "adventurer"
      ) {
        throw new Error("Immediate Gmail journey requires reconciled Adventurer facts");
      }
      const userId = UserId.make(identity.userId);
      const authSessionId = AuthSessionId.make(session.session.id);
      const planPolicyVersion = PlanPolicyVersion.make("launch-v1");
      const directory = env.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME);

      const recipient = "journey-immediate@example.test";
      const subject = "Journey immediate Gmail";
      const body = "One exact composed journey message";
      const submit = async (
        requestId: string,
        requestRecipient: string,
        requestSubject: string,
        requestBody: string,
      ): Promise<void> => {
        // Miniflare cannot serialize Chat SDK's live delivery surface across a
        // facet. Real Wrangler/Chrome owns webhook ingress; this trusted setup
        // arranges the Action before every #179 surface continues over HTTP.
        await runInDurableObject(directory, async (host) => {
          const agent = await host.subAgent(OsfoAgent, identity.agentId);
          await agent.submitManagedConversation({
            authorization: {
              allowance: {
                _tag: "Metered",
                allowancePeriodId: AllowancePeriodId.make(registration.allowance_period_id),
                endsAt: registration.allowance_ends_at,
                plan: "adventurer",
                planPolicyVersion,
                startsAt: registration.allowance_starts_at,
                usage: [],
              },
              approval: null,
              authority: {
                _tag: "AuthSession",
                authSessionId,
                expiresAt: registration.allowance_ends_at,
                userId,
              },
              deletionAccess: { _tag: "DeletionAccessAvailable" },
              gmailConnection: null,
              integrationConnections: [],
              liveFacts: emptyLiveResourceFacts,
              now: registration.allowance_starts_at,
              originatingAuthority: { _tag: "AuthSession", authSessionId },
              requestVendorUsdMicros: 0n,
              resourceOwnerUserId: userId,
              subscription: { plan: "adventurer", planPolicyVersion },
              user: { _tag: "ActiveUser", userId },
            },
            idempotencyKey: requestId,
            message: `Send this exact Gmail message now: recipient=${requestRecipient}; subject=${requestSubject}; body=${requestBody}`,
            routeId: ConversationRouteId.make(`primary-route-${identity.agentId}`),
            submissionId: ThinkSubmissionId.make(requestId),
          });
        });
      };
      yield* Effect.promise(() => submit("request", recipient, subject, body));

      const pending = yield* Effect.promise(() => waitForApproval(app.integrations.gmailSends));
      expect(pending.approvals).toHaveLength(1);
      expect(pending.statuses).toEqual([]);
      const approval = pending.approvals[0];
      if (approval === undefined) throw new Error("Immediate Gmail Approval was not projected");
      expect(approval.fields).toEqual([
        { label: "Gmail mailbox", name: "gmailResource", value: "primary" },
        { label: "Integration manifest", name: "manifestVersion", value: "gmail-v1" },
        { label: "Recipients", name: "recipients", value: JSON.stringify([recipient]) },
        { label: "Subject", name: "subject", value: subject },
        { label: "Message", name: "body", value: body },
      ]);

      const decision = yield* Effect.promise(() =>
        app.integrations.decideGmailSend("approve", approval.presentationId),
      );
      expect(decision.response.status).toBe(200);
      expect(decision.body).toEqual({
        decision: "approved",
        presentationId: approval.presentationId,
      });

      const settled = yield* Effect.promise(() => waitForApplied(app.integrations.gmailSends));
      expect(settled.approvals).toEqual([]);
      expect(settled.statuses).toEqual([
        {
          actionId: approval.actionId,
          presentationId: approval.presentationId,
          status: "applied",
        },
      ]);
      const provider = yield* Effect.promise(app.integrations.ledger);
      expect(provider).toHaveLength(1);
      expect(provider[0]).toMatchObject({
        input: {
          body,
          recipient_email: recipient,
          subject,
        },
        providerTool: "GMAIL_SEND_EMAIL",
        userId: identity.userId,
      });
      const usage = yield* Effect.promise(() => app.database.gmailSendUsage(identity.userId));
      expect(usage).toEqual([
        {
          basis: "observed",
          quantity: "1",
          source_id: expect.stringContaining("verification-gmailSendEmail::cf-wai-tool-call::"),
        },
      ]);

      const replay = yield* Effect.promise(() =>
        app.integrations.decideGmailSend("approve", approval.presentationId),
      );
      expect(replay.response.ok).toBe(false);
      expect(yield* Effect.promise(app.integrations.ledger)).toEqual(provider);
      expect(yield* Effect.promise(() => app.database.gmailSendUsage(identity.userId))).toEqual(
        usage,
      );

      yield* Effect.promise(() =>
        app.integrations.nextGmailAction("verification-gmail-admission-swap"),
      );
      yield* Effect.promise(() =>
        submit(
          "admission-swap",
          "admission-swap@example.test",
          "Admission account replacement",
          "Must fail before admission",
        ),
      );
      const admissionPending = yield* Effect.promise(() =>
        waitForApproval(app.integrations.gmailSends),
      );
      const admissionApproval = admissionPending.approvals[0];
      if (admissionApproval === undefined) throw new Error("Admission-swap Approval was absent");
      yield* Effect.promise(() => app.integrations.swapGmailConnectionAfterInspections(1));
      const admissionDecision = yield* Effect.promise(() =>
        app.integrations.decideGmailSend("approve", admissionApproval.presentationId),
      );
      expect(admissionDecision.response.status).toBe(200);
      expect(admissionDecision.body).toEqual({
        decision: "approved",
        presentationId: admissionApproval.presentationId,
      });
      yield* Effect.promise(() =>
        waitForApprovalRemoval(app.integrations.gmailSends, admissionApproval.presentationId),
      );
      yield* Effect.promise(() =>
        waitForConnectionSwapConsumed(app.integrations.connectionControl),
      );
      yield* Effect.promise(() =>
        waitForStatus(app.integrations.gmailSends, admissionApproval.presentationId, "invalidated"),
      );
      expect(yield* Effect.promise(app.integrations.ledger)).toEqual(provider);
      expect(yield* Effect.promise(() => app.database.gmailSendUsage(identity.userId))).toEqual(
        usage,
      );

      yield* Effect.promise(() =>
        app.integrations.nextGmailAction("verification-gmail-recheck-swap"),
      );
      yield* Effect.promise(() =>
        submit(
          "recheck-swap",
          "recheck-swap@example.test",
          "Final recheck account replacement",
          "Must fail before provider execution",
        ),
      );
      const recheckPending = yield* Effect.promise(() =>
        waitForApproval(app.integrations.gmailSends),
      );
      const recheckApproval = recheckPending.approvals[0];
      if (recheckApproval === undefined) throw new Error("Recheck-swap Approval was absent");
      yield* Effect.promise(() => app.integrations.swapGmailConnectionAfterInspections(3));
      const recheckDecision = yield* Effect.promise(() =>
        app.integrations.decideGmailSend("approve", recheckApproval.presentationId),
      );
      expect(recheckDecision.response.status).toBe(200);
      expect(recheckDecision.body).toEqual({
        decision: "approved",
        presentationId: recheckApproval.presentationId,
      });
      yield* Effect.promise(() =>
        waitForApprovalRemoval(app.integrations.gmailSends, recheckApproval.presentationId),
      );
      yield* Effect.promise(() =>
        waitForConnectionSwapConsumed(app.integrations.connectionControl),
      );
      yield* Effect.promise(() =>
        waitForStatus(app.integrations.gmailSends, recheckApproval.presentationId, "invalidated"),
      );
      expect(yield* Effect.promise(app.integrations.ledger)).toEqual(provider);
      expect(yield* Effect.promise(() => app.database.gmailSendUsage(identity.userId))).toEqual(
        usage,
      );

      yield* Effect.promise(() =>
        app.integrations.nextGmailAction("verification-gmail-stale-reject"),
      );
      yield* Effect.promise(() =>
        submit(
          "stale-reject",
          "stale-reject@example.test",
          "Reject after disconnect",
          "Must remain rejectable",
        ),
      );
      const stalePending = yield* Effect.promise(() =>
        waitForApproval(app.integrations.gmailSends),
      );
      const staleApproval = stalePending.approvals[0];
      if (staleApproval === undefined) throw new Error("Disconnect-rejection Approval was absent");
      const disconnected = yield* Effect.promise(app.integrations.disconnectGmail);
      expect(disconnected.status).toBe(200);
      const retainedAfterDisconnect = yield* Effect.promise(() =>
        waitForApproval(app.integrations.gmailSends),
      );
      expect(retainedAfterDisconnect.approvals[0]?.presentationId).toBe(
        staleApproval.presentationId,
      );
      const rejection = yield* Effect.promise(() =>
        app.integrations.decideGmailSend("reject", staleApproval.presentationId),
      );
      expect(rejection.response.status).toBe(200);
      expect(rejection.body).toEqual({
        decision: "rejected",
        presentationId: staleApproval.presentationId,
      });
      yield* Effect.promise(() =>
        waitForStatus(app.integrations.gmailSends, staleApproval.presentationId, "rejected"),
      );
      expect(yield* Effect.promise(app.integrations.ledger)).toEqual(provider);
      expect(yield* Effect.promise(() => app.database.gmailSendUsage(identity.userId))).toEqual(
        usage,
      );

      const reconnection = yield* Effect.promise(app.integrations.connectGmail);
      if (reconnection.body === undefined)
        throw new Error("Gmail reconnect returned no hosted URL");
      const reconnectionUrl = reconnection.body.url;
      const reconnected = yield* Effect.promise(() =>
        fetch(reconnectionUrl, { method: "POST", redirect: "manual" }),
      );
      expect(reconnected.status).toBe(303);
      yield* Effect.promise(() =>
        app.integrations.nextGmailAction("verification-gmail-unseen-disconnect"),
      );
      yield* Effect.promise(() =>
        submit(
          "unseen-disconnect",
          "unseen-disconnect@example.test",
          "Disconnect before first settings view",
          "Must remain rejectable without a live connection",
        ),
      );
      expect((yield* Effect.promise(app.integrations.disconnectGmail)).status).toBe(200);
      const unseenPending = yield* Effect.promise(() =>
        waitForApproval(app.integrations.gmailSends),
      );
      const unseenApproval = unseenPending.approvals[0];
      if (unseenApproval === undefined) throw new Error("Unseen disconnected Approval was absent");
      const unseenRejection = yield* Effect.promise(() =>
        app.integrations.decideGmailSend("reject", unseenApproval.presentationId),
      );
      expect(unseenRejection.response.status).toBe(200);
      yield* Effect.promise(() =>
        waitForStatus(app.integrations.gmailSends, unseenApproval.presentationId, "rejected"),
      );
      expect(yield* Effect.promise(app.integrations.ledger)).toEqual(provider);
      expect(yield* Effect.promise(() => app.database.gmailSendUsage(identity.userId))).toEqual(
        usage,
      );
    }),
);

interface GmailSendsView {
  readonly approvals: ReadonlyArray<{
    readonly actionId: string;
    readonly fields: ReadonlyArray<{
      readonly label: string;
      readonly name: string;
      readonly value: string;
    }>;
    readonly presentationId: string;
  }>;
  readonly statuses: ReadonlyArray<{
    readonly actionId: string;
    readonly presentationId: string;
    readonly status: string;
  }>;
}

const waitForApproval = async (
  inspect: () => Promise<{ readonly body: GmailSendsView | undefined }>,
) => poll(inspect, (view) => view.approvals.length === 1, "Immediate Gmail Approval");

const waitForApprovalRemoval = async (
  inspect: () => Promise<{ readonly body: GmailSendsView | undefined }>,
  presentationId: string,
) =>
  poll(
    inspect,
    (view) => view.approvals.every((approval) => approval.presentationId !== presentationId),
    "Rejected immediate Gmail execution",
  );

const waitForStatus = async (
  inspect: () => Promise<{ readonly body: GmailSendsView | undefined }>,
  presentationId: string,
  status: "invalidated" | "rejected",
) =>
  poll(
    inspect,
    (view) =>
      view.approvals.every((approval) => approval.presentationId !== presentationId) &&
      view.statuses.some(
        (candidate) => candidate.presentationId === presentationId && candidate.status === status,
      ),
    `${status} immediate Gmail status`,
  );

const waitForConnectionSwapConsumed = async (
  inspect: () => Promise<{ readonly swapAfterInspections: number | null }>,
): Promise<void> => waitForConnectionSwapAttempt(inspect, 0);

const waitForConnectionSwapAttempt = async (
  inspect: () => Promise<{ readonly swapAfterInspections: number | null }>,
  attempt: number,
): Promise<void> => {
  if ((await inspect()).swapAfterInspections === null) return;
  if (attempt >= 39) throw new Error("Gmail connection replacement was not consumed");
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForConnectionSwapAttempt(inspect, attempt + 1);
};

const waitForApplied = async (
  inspect: () => Promise<{ readonly body: GmailSendsView | undefined }>,
) =>
  poll(
    inspect,
    (view) => view.statuses.some((status) => status.status === "applied"),
    "Applied status",
  );

const poll = async <Value>(
  inspect: () => Promise<{ readonly body: Value | undefined }>,
  ready: (value: Value) => boolean,
  label: string,
): Promise<Value> => pollAttempt(inspect, ready, label, 0);

const pollAttempt = async <Value>(
  inspect: () => Promise<{ readonly body: Value | undefined }>,
  ready: (value: Value) => boolean,
  label: string,
  attempt: number,
): Promise<Value> => {
  const { body } = await inspect();
  if (body !== undefined && ready(body)) return body;
  if (attempt >= 39) throw new Error(`${label} did not become observable`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return pollAttempt(inspect, ready, label, attempt + 1);
};
