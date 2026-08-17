import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import type { PendingApproval } from "@cloudflare/think";
import { getAgentByName } from "agents";
import { DateTime, Effect, Schema } from "effect";

import {
  AgentId,
  AgentInitializationId,
  ChannelBindingId,
  ConversationRouteId,
  SessionId,
  UserId,
} from "../src/domain";
import {
  ActionPresentationId,
  makeThinkActionApprovalAdapter,
} from "../src/agents/osfo/think-action-approvals";
import { makeActionApprovals } from "../src/services/action-approvals";
import {
  presentTestProtectedAction,
  testProtectedActionName,
  type TestProtectedActionState,
} from "../src/agents/osfo/test-protected-action";
import { gmailSendActionName } from "../src/agents/osfo/gmail-send-action";
import type { OsfoAgent } from "../src/agents/osfo/agent";

/* oxlint-disable effecttsgo/async-function, effecttsgo/run-effect-inside-effect, effecttsgo/schema-sync-in-effect, effecttsgo/prefer-typed-schema-decoder, effecttsgo/prefer-schema-over-json, typescript/await-thenable, typescript/no-unsafe-type-assertion, osfo/no-chained-type-assertions, osfo/no-unknown-parameters, osfo/no-unknown-returns, eslint/no-underscore-dangle -- Worker integration tests cross Think's Promise, private Action compiler, and Durable Object boundaries. */

describe("Think Action and exact Approval", () => {
  it.effect("parks in Think, recovers after activation, and executes once after Approval", () =>
    Effect.gen(function* () {
      const agentName = Schema.decodeUnknownSync(AgentId)("agent-think-action-recovery");
      const agent = env.OSFO_AGENT.getByName(agentName);
      const parked = yield* Effect.promise(() => parkTestAction(agent, "call-recovery"));

      expect(parked).toMatchObject({ action: testProtectedActionName, status: "paused" });
      expect(parked.executionId).toMatch(/^actpause_/);

      const beforeActivation = yield* Effect.promise(async () => await agent.pendingApprovals());
      expect(beforeActivation).toHaveLength(1);
      expect(beforeActivation[0]).toMatchObject({
        descriptor: {
          action: testProtectedActionName,
          input: { recipient: "sam@example.com", subject: "Trip details" },
          kind: "durable-pause",
        },
        executionId: parked.executionId,
        source: "action",
      });
      expect(JSON.stringify(beforeActivation)).not.toContain("oauth-token-must-not-leak");

      yield* Effect.promise(() => evictDurableObject(agent));
      const reactivatedAgent = yield* Effect.promise(
        async () => await getAgentByName(env.OSFO_AGENT, agentName),
      );
      const afterActivation = yield* Effect.promise(
        async () => await reactivatedAgent.pendingApprovals(),
      );
      expect(afterActivation).toEqual(beforeActivation);

      const approved = yield* Effect.promise(
        async () => await reactivatedAgent.approveExecution(parked.executionId),
      );
      expect(approved).toMatchObject({
        _tag: "Applied",
        actionId: "call-recovery",
        providerOperationId: "test-provider:call-recovery",
      });
      expect(yield* Effect.promise(async () => await reactivatedAgent.pendingApprovals())).toEqual(
        [],
      );

      const repeated = yield* Effect.promise(
        async () => await reactivatedAgent.approveExecution(parked.executionId),
      );
      expect(repeated).toMatchObject({ status: "error" });
    }),
  );

  for (const testCase of [
    {
      authority: "revoked",
      currentFact: "current",
      denial: "authorityRevoked",
      name: "authority revocation",
    },
    {
      authority: "active",
      currentFact: "ownership-lost",
      denial: "ownershipRequired",
      name: "ownership loss",
    },
    {
      authority: "active",
      currentFact: "entitlement-lost",
      denial: "missingEntitlement",
      name: "entitlement loss",
    },
    {
      authority: "active",
      currentFact: "integration-revoked",
      denial: "integrationConnectionRequired",
      name: "Integration Connection revocation",
    },
    {
      authority: "active",
      currentFact: "approval-revoked",
      denial: "approvalRequired",
      name: "Approval revocation",
    },
  ] as const) {
    it.effect(`rechecks current ${testCase.name} before provider contact`, () =>
      Effect.gen(function* () {
        const agent = env.OSFO_AGENT.getByName(
          Schema.decodeUnknownSync(AgentId)(`agent-think-action-${testCase.currentFact}`),
        );
        const parked = yield* Effect.promise(() =>
          parkTestAction(agent, `call-${testCase.currentFact}`),
        );
        yield* Effect.promise(() =>
          configureTestAction(agent, {
            authority: testCase.authority,
            currentFact: testCase.currentFact,
            providerOutcome: "not-applied",
          }),
        );

        const result = yield* Effect.promise(
          async () => await agent.approveExecution(parked.executionId),
        );
        expect(result).toEqual({ _tag: "Denied", reason: testCase.denial, resetAt: null });
      }),
    );
  }

  it.effect("returns explicit provider ambiguity", () =>
    Effect.gen(function* () {
      const ambiguousAgent = env.OSFO_AGENT.getByName(
        Schema.decodeUnknownSync(AgentId)("agent-think-action-ambiguous"),
      );
      yield* Effect.promise(() =>
        configureTestAction(ambiguousAgent, {
          authority: "active",
          currentFact: "current",
          providerOutcome: "ambiguous",
        }),
      );
      const ambiguous = yield* Effect.promise(() =>
        parkTestAction(ambiguousAgent, "call-ambiguous"),
      );
      const ambiguousResult = yield* Effect.promise(
        async () => await ambiguousAgent.approveExecution(ambiguous.executionId),
      );
      expect(ambiguousResult).toMatchObject({
        _tag: "Ambiguous",
        actionId: "call-ambiguous",
        retry: "reconcile-before-retry",
      });
    }),
  );

  it.effect("creates a new Action and Approval for materially changed input", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName(
        Schema.decodeUnknownSync(AgentId)("agent-think-action-material-change"),
      );
      const first = yield* Effect.promise(() =>
        parkTestAction(agent, "call-material-first", {
          recipient: "sam@example.com",
          subject: "Trip details",
        }),
      );
      const changed = yield* Effect.promise(() =>
        parkTestAction(agent, "call-material-changed", {
          recipient: "sam@example.com",
          subject: "Changed trip details",
        }),
      );
      const pending: Array<PendingApproval> = yield* Effect.promise(
        (): Promise<Array<PendingApproval>> => agent.pendingApprovals(),
      );

      expect(pending.map(({ descriptor }) => descriptor.input)).toEqual([
        { recipient: "sam@example.com", subject: "Trip details" },
        { recipient: "sam@example.com", subject: "Changed trip details" },
      ]);
      expect(pending).toHaveLength(2);
      expect(new Set([first.executionId, changed.executionId]).size).toBe(2);
    }),
  );

  it.effect("binds the production Gmail Action identity to every exact send field", () =>
    Effect.gen(function* () {
      const agent = env.OSFO_AGENT.getByName(
        Schema.decodeUnknownSync(AgentId)("agent-gmail-action-material-change"),
      );
      const first = yield* Effect.promise(() =>
        parkAction(agent, gmailSendActionName, "gmail-call-first", {
          body: "Original body",
          recipient: "sam@example.com",
          scheduledFor: null,
          selectedResourceId: "gmail-message-selected",
          subject: "Trip details",
        }),
      );
      const changed = yield* Effect.promise(() =>
        parkAction(agent, gmailSendActionName, "gmail-call-changed", {
          body: "Changed body",
          recipient: "sam@example.com",
          scheduledFor: null,
          selectedResourceId: "gmail-message-selected",
          subject: "Trip details",
        }),
      );
      const pending: Array<PendingApproval> = yield* Effect.promise(
        (): Promise<Array<PendingApproval>> => agent.pendingApprovals(),
      );

      expect(pending.map(({ descriptor }) => descriptor.input)).toEqual([
        {
          body: "Original body",
          recipient: "sam@example.com",
          scheduledFor: null,
          selectedResourceId: "gmail-message-selected",
          subject: "Trip details",
        },
        {
          body: "Changed body",
          recipient: "sam@example.com",
          scheduledFor: null,
          selectedResourceId: "gmail-message-selected",
          subject: "Trip details",
        },
      ]);
      expect(new Set([first.executionId, changed.executionId]).size).toBe(2);
      expect(first.executionId).not.toBe(changed.executionId);
    }),
  );

  it.effect("projects only definition-owned safe material and authenticates decisions", () =>
    Effect.gen(function* () {
      const pending = makePending("actpause_safe", "call-safe");
      const presentationId = ActionPresentationId.make(pending.executionId);
      const service = makeActionApprovals({
        authorizer: { ownsAgent: () => Effect.succeed(true) },
        lifecycle: makeThinkActionApprovalAdapter({
          think: {
            approve: () => Promise.resolve({ status: "approved" }),
            pending: () => Promise.resolve([pending]),
            reject: () => Promise.resolve({ status: "rejected" }),
          },
        }),
        now: Effect.succeed(DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-16T12:00:00.000Z"))),
        present: presentTestProtectedAction,
      });
      const actor = {
        _tag: "ChannelBinding" as const,
        channelBindingId: ChannelBindingId.make("binding-owner"),
        userId: UserId.make("user-owner"),
      };

      const found = yield* service.read(actor, presentationId);
      expect(found).toMatchObject({
        _tag: "ActionPresentationFound",
        presentation: {
          actionDefinitionVersion: "osfo-test-gmail-send-v1",
          actionId: "call-safe",
          operation: "gmail.send",
          presentationId,
          title: "Send test email",
        },
      });
      expect(found.presentation.fields).toEqual([
        { label: "Recipient", name: "recipient", value: "sam@example.com" },
        { label: "Subject", name: "subject", value: "Trip details" },
      ]);

      const accepted = yield* service.dispatch(actor, presentationId, "approved");
      expect(accepted).toEqual({
        _tag: "ApprovalDecisionAccepted",
        decision: "approved",
        presentationId,
      });
    }),
  );
});

const ParkedAction = Schema.Struct({
  action: Schema.String,
  executionId: Schema.String,
  status: Schema.String,
});
type ParkedAction = typeof ParkedAction.Type;
type ParkedActionInput =
  | { readonly recipient: string; readonly subject: string }
  | {
      readonly body: string;
      readonly recipient: string;
      readonly scheduledFor: null;
      readonly selectedResourceId: string | null;
      readonly subject: string;
    };

const parkTestAction = async (
  agent: DurableObjectStub<OsfoAgent>,
  toolCallId: string,
  input: { readonly recipient: string; readonly subject: string } = {
    recipient: "sam@example.com",
    subject: "Trip details",
  },
): Promise<ParkedAction> => parkAction(agent, testProtectedActionName, toolCallId, input);

const parkAction = async (
  agent: DurableObjectStub<OsfoAgent>,
  actionName: string,
  toolCallId: string,
  input: ParkedActionInput,
): Promise<ParkedAction> =>
  runInDurableObject(agent, async (instance) => {
    await instance.initialize({
      agentId: AgentId.make(instance.name),
      initializationId: AgentInitializationId.make(`init-${toolCallId}`),
      initializedAt: "2026-08-16T12:00:00.000Z",
      routeId: ConversationRouteId.make(`route-${toolCallId}`),
      sessionId: SessionId.make(`session-${toolCallId}`),
    });
    // SAFETY: Think exposes no public test driver for compiling registered Actions. The cast reaches the same private seam used by Think's own durable-pause tests.
    const compile = instance as unknown as {
      _compileActionTools: () => Promise<
        Record<
          string,
          {
            execute?: (
              input: unknown,
              options: { abortSignal?: AbortSignal; messages?: []; toolCallId?: string },
            ) => Promise<unknown>;
          }
        >
      >;
    };
    const tools = await compile._compileActionTools();
    const protectedAction = tools[actionName];
    if (protectedAction?.execute === undefined) throw new Error("Test Action is not registered");
    const result = await protectedAction.execute(
      {
        oauthToken: "oauth-token-must-not-leak",
        ...input,
      },
      { messages: [], toolCallId },
    );
    // SAFETY: The Think test seam returns the documented durable-pause result after the status check in each caller.
    return Schema.decodeUnknownSync(ParkedAction)(result);
  });

const configureTestAction = (
  agent: DurableObjectStub<OsfoAgent>,
  state: TestProtectedActionState,
) =>
  runInDurableObject(agent, async (instance) => {
    instance.configure<TestProtectedActionState>(state);
  });

const makePending = (executionId: string, toolCallId: string): PendingApproval => ({
  descriptor: {
    action: testProtectedActionName,
    input: { recipient: "sam@example.com", subject: "Trip details" },
    kind: "durable-pause",
    permissions: ["gmail:send"],
    requestId: "request-safe",
    risk: "high",
    summary: "Send the exact test email",
    toolCallId,
  },
  executionId,
  source: "action",
});
