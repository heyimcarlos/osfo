import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate, Schema } from "effect";

import { ActionPresentationPrepared } from "../src/domain/action-approval";
import {
  AgentId,
  AgentInitializationId,
  ConversationRouteId,
  SessionId,
  UserId,
} from "../src/domain";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date-in-effect, effecttsgo/prefer-schema-over-json, effecttsgo/prefer-typed-schema-decoder, effecttsgo/run-effect-inside-effect, effecttsgo/schema-sync-in-effect -- Worker integration assertions use RPC encoding, native Date values, and public JSON projection. */

describe("Action Presentation and exact Approval RPC", () => {
  it.effect("keeps an exact cross-authority Approval durable across Agent activation", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-action-approval");
      const userId = Schema.decodeUnknownSync(UserId)("user-action-approval");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId:
              Schema.decodeUnknownSync(AgentInitializationId)("init-action-approval"),
            initializedAt: "2026-08-16T15:00:00.000Z",
            routeId: Schema.decodeUnknownSync(ConversationRouteId)("route-action-approval"),
            sessionId: Schema.decodeUnknownSync(SessionId)("session-action-approval"),
          }),
      );

      // oxlint-disable-next-line effecttsgo/global-date-in-effect -- The integration test compares server-owned callback time.
      const createdAt = new Date();
      const preparedResult = yield* Effect.promise(
        async () =>
          await agent.prepareActionPresentation({
            actionDefinitionVersion: "gmail-send-v1",
            actionId: "tool-call-send-1",
            consequences: ["Send one email to the stated recipient."],
            createdAt: createdAt.toISOString(),
            description: "Send the prepared email exactly as shown.",
            executionId: "think-execution-send-1",
            fields: [
              { kind: "text", label: "Recipient", name: "recipient", value: "sam@example.com" },
              { kind: "text", label: "Subject", name: "subject", value: "Trip details" },
            ],
            operation: "gmail.send",
            originatingAuthority: {
              _tag: "ChannelBinding",
              channelBindingId: "telegram-binding-origin",
            },
            title: "Send email",
            userId,
          }),
      );
      const prepared = yield* Schema.decodeUnknownEffect(ActionPresentationPrepared)(
        preparedResult,
      );

      expect(prepared).toMatchObject({
        _tag: "ActionPresentationPrepared",
        presentation: {
          actionDefinitionVersion: "gmail-send-v1",
          actionId: "tool-call-send-1",
          consequences: ["Send one email to the stated recipient."],
          createdAt,
          description: "Send the prepared email exactly as shown.",
          expiresAt: new Date(createdAt.getTime() + 15 * 60 * 1_000),
          operation: "gmail.send",
          presentationId: expect.stringMatching(/^action-presentation-/),
          title: "Send email",
        },
        status: { _tag: "Pending" },
      });
      expect(prepared).not.toHaveProperty("executionId");

      const presentationId = prepared.presentation.presentationId;
      const readByWeb = yield* Effect.promise(
        async () =>
          await agent.readActionPresentation({
            actor: {
              _tag: "AuthSession",
              authSessionId: "web-session-approver",
              expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1_000).toISOString(),
              userId,
            },
            presentationId,
          }),
      );
      expect(readByWeb).toMatchObject({
        _tag: "ActionPresentationFound",
        presentation: prepared.presentation,
        status: { _tag: "Pending" },
      });

      const decision = yield* Effect.promise(
        async () =>
          await agent.decideActionApproval({
            actor: {
              _tag: "ChannelBinding",
              channelBindingId: "telegram-binding-approver",
              userId,
            },
            decision: "approve",
            presentationId,
          }),
      );
      expect(decision).toMatchObject({
        _tag: "ApprovalDispatchUnavailable",
        message: "The Approval decision is durable, but Think has not accepted its handoff",
        presentationId,
      });

      const approvedBeforeActivation = yield* Effect.promise(
        async () =>
          await agent.readActionPresentation({
            actor: {
              _tag: "ChannelBinding",
              channelBindingId: "telegram-binding-reader",
              userId,
            },
            presentationId,
          }),
      );
      expect(approvedBeforeActivation).toMatchObject({
        _tag: "ActionPresentationFound",
        status: { _tag: "Approved" },
      });
      const decidedAt =
        "status" in approvedBeforeActivation &&
        Predicate.isTagged(approvedBeforeActivation.status, "Approved")
          ? approvedBeforeActivation.status.decidedAt
          : yield* Effect.die("The Approval must be approved before activation");

      yield* Effect.promise(() => evictDurableObject(agent));
      const recovered = yield* Effect.promise(
        async () =>
          await agent.readActionPresentation({
            actor: {
              _tag: "ChannelBinding",
              channelBindingId: "telegram-binding-reader",
              userId,
            },
            presentationId,
          }),
      );
      expect(recovered).toMatchObject({
        _tag: "ActionPresentationFound",
        presentation: prepared.presentation,
        status: {
          _tag: "Approved",
          actor: {
            _tag: "ChannelBinding",
          },
          decidedAt,
        },
      });
    }),
  );

  it.effect("expires, cancels, and rejects changed material facts without exposing secrets", () =>
    Effect.gen(function* () {
      const agentId = Schema.decodeUnknownSync(AgentId)("agent-action-approval-boundaries");
      const userId = Schema.decodeUnknownSync(UserId)("user-action-approval-boundaries");
      const agent = env.OSFO_AGENT.getByName(agentId);

      yield* Effect.promise(
        async () =>
          await agent.initialize({
            agentId,
            initializationId: Schema.decodeUnknownSync(AgentInitializationId)(
              "init-action-approval-boundaries",
            ),
            initializedAt: "2026-08-16T15:00:00.000Z",
            routeId: Schema.decodeUnknownSync(ConversationRouteId)(
              "route-action-approval-boundaries",
            ),
            sessionId: Schema.decodeUnknownSync(SessionId)("session-action-approval-boundaries"),
          }),
      );
      const base = {
        actionDefinitionVersion: "gmail-send-v1",
        actionId: "tool-call-boundary-1",
        consequences: ["Send one email."],
        createdAt: "2020-01-01T00:00:00.000Z",
        description: "Send the exact prepared email.",
        executionId: "secret-think-execution-boundary-1",
        fields: [{ kind: "text" as const, label: "Recipient", name: "recipient", value: "a@b.ca" }],
        operation: "gmail.send" as const,
        originatingAuthority: {
          _tag: "AuthSession" as const,
          authSessionId: "secret-origin-auth-session",
        },
        title: "Send email",
        userId,
      };
      const preparedResult = yield* Effect.promise(
        async () => await agent.prepareActionPresentation(base),
      );
      const prepared = yield* Schema.decodeUnknownEffect(ActionPresentationPrepared)(
        preparedResult,
      );
      expect(JSON.stringify(prepared)).not.toContain("secret-");

      const changed = yield* Effect.promise(
        async () =>
          await agent.prepareActionPresentation({
            ...base,
            fields: [
              { kind: "text", label: "Recipient", name: "recipient", value: "changed@b.ca" },
            ],
          }),
      );
      expect(changed).toMatchObject({ _tag: "ActionMaterialityConflict" });

      const unauthorized = yield* Effect.promise(
        async () =>
          await agent.readActionPresentation({
            actor: {
              _tag: "ChannelBinding",
              channelBindingId: "binding-other-user",
              userId: Schema.decodeUnknownSync(UserId)("user-other"),
            },
            presentationId: prepared.presentation.presentationId,
          }),
      );
      expect(unauthorized).toMatchObject({ _tag: "ApprovalActorUnauthorized" });

      const expired = yield* Effect.promise(
        async () =>
          await agent.decideActionApproval({
            actor: { _tag: "ChannelBinding", channelBindingId: "binding-owner", userId },
            decision: "approve",
            presentationId: prepared.presentation.presentationId,
          }),
      );
      expect(expired).toMatchObject({ _tag: "ApprovalExpired" });

      const cancelCandidateResult = yield* Effect.promise(
        async () =>
          await agent.prepareActionPresentation({
            ...base,
            actionId: "tool-call-boundary-2",
            createdAt: new Date().toISOString(),
            executionId: "secret-think-execution-boundary-2",
          }),
      );
      const cancelCandidate = yield* Schema.decodeUnknownEffect(ActionPresentationPrepared)(
        cancelCandidateResult,
      );
      const cancelPresentationId = cancelCandidate.presentation.presentationId;
      const canceled = yield* Effect.promise(
        async () =>
          await agent.cancelActionApproval({
            presentationId: cancelPresentationId,
            reason: "The owning conversation was canceled",
            userId,
          }),
      );
      expect(canceled).toMatchObject({
        _tag: "ApprovalDispatchUnavailable",
        message: "The Approval decision is durable, but Think has not accepted its handoff",
        presentationId: cancelPresentationId,
      });
      const decisionAfterCancel = yield* Effect.promise(
        async () =>
          await agent.decideActionApproval({
            actor: { _tag: "ChannelBinding", channelBindingId: "binding-owner", userId },
            decision: "approve",
            presentationId: cancelPresentationId,
          }),
      );
      expect(decisionAfterCancel).toMatchObject({
        _tag: "ApprovalAlreadyResolved",
        status: { _tag: "Canceled" },
      });
    }),
  );
});
