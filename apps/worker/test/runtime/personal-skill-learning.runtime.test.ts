/* oxlint-disable vitest/no-conditional-expect -- The paused parameter verifies a deferred candidate; the active parameter continues the existing learned-Skill assertions. */
/* oxlint-disable effecttsgo/async-function -- Cloudflare Durable Object and AI SDK test boundaries are Promise APIs. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- The test-only resolver access is proven against OsfoAgent's inherited protected method and never enters production code. */
/* oxlint-disable eslint/no-await-in-loop -- Bounded polling must observe each durable write before scheduling the next read. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { Session } from "@cloudflare/think";
import { expect, it, vi, beforeEach, afterEach } from "vitest";
import { IncidentControls } from "../../src/services/incident-controls";
import { IncidentControlsPostgres } from "../../src/integrations/postgres/incident-controls";
import { tool, type LanguageModel, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Effect, Schema } from "effect";

import {
  AgentId,
  AssistantMessageId,
  ThinkRequestId,
  ThinkSubmissionId,
  UserId,
} from "../../src/domain";
import { ManagedTurnMetadata } from "../../src/domain/managed-conversation";
import { ManagedCapabilityState } from "../../src/agents/osfo/managed-capability-turn-state";
import { OsfoAgent } from "../../src/agents/osfo/agent";
import { effectToolSchema } from "../../src/agents/osfo/effect-tool-schema";

// This focused runtime has no PostgreSQL server; supply its incident authority explicitly.
beforeEach(() => {
  vi.spyOn(IncidentControlsPostgres, "check").mockReturnValue(Effect.void);
});
afterEach(() => vi.restoreAllMocks());

const userId = UserId.make("personal-skill-journey-user");
const initialSessionId = "personal-skill-session-initial";
const matchingSessionId = "personal-skill-session-matching";
const unrelatedSessionId = "personal-skill-session-unrelated";

it.each(["active", "paused"] as const)(
  "drives Skill Learning with %s incident controls and preserves matching Session scope",
  async (controlState) => {
    const agentId = AgentId.make(`personal-skill-journey-agent-${controlState}`);
    // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
    const runtimeEnv = env as typeof env & {
      readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
    };
    const stub = runtimeEnv.OSFO_AGENT_TEST.get(runtimeEnv.OSFO_AGENT_TEST.idFromName(agentId));
    await runInDurableObject(stub, async (agent, state) => {
      const historyReads = vi.spyOn(Session.prototype, "getHistory");
      await agent.initialize({
        agentId,
        initializationId: "personal-skill-journey-initialization",
        initializedAt: "2026-08-27T12:00:00.000Z",
        routeId: "personal-skill-journey-route",
        sessionId: initialSessionId,
      });
      await agent.onStart();
      expect(historyReads).not.toHaveBeenCalled();
      const submissionId = ThinkSubmissionId.make("personal-skill-submission-initial");
      const metadata = turnMetadata({ sessionId: initialSessionId, submissionId });
      const userMessage = managedUserMessage(
        "personal-skill-user-initial",
        "Always create a PDF weekly report with the summary first.",
        metadata,
      );
      await agent.addMessages([userMessage]);
      const model = learningModel();
      const generate = vi.spyOn(model, "doGenerate");
      // SAFETY: resolveModel is inherited by OsfoAgent and the test replaces only that protected method.
      vi.spyOn(
        agent as OsfoAgent & { resolveModel(model?: string): LanguageModel },
        "resolveModel",
      ).mockReturnValue(model);
      await agent.beforeTurn(
        turnContext(
          "Always create a PDF weekly report with the summary first.",
          compiledAgentTools(agent),
          model,
        ),
      );

      const assistantMessageId = AssistantMessageId.make("personal-skill-assistant-initial");
      const assistantMessage: UIMessage = {
        id: assistantMessageId,
        parts: [{ text: "The weekly report is ready.", type: "text" }],
        role: "assistant",
      };
      await agent.addMessages([assistantMessage]);
      if (controlState === "paused") {
        vi.mocked(IncidentControlsPostgres.check).mockReturnValue(
          Effect.fail(new IncidentControls.Paused({ control: "newCostlyWork" })),
        );
      }
      await agent.onChatResponse({
        continuation: false,
        message: assistantMessage,
        requestId: ThinkRequestId.make("personal-skill-request-initial"),
        status: "completed",
      });

      if (controlState === "paused") {
        await vi.waitFor(() => {
          expect(
            state.storage.sql
              .exec(
                "SELECT status, attempts, claim_token FROM osfo_personal_skill_learning_candidates",
              )
              .toArray(),
          ).toEqual([{ status: "pending", attempts: 1, claim_token: null }]);
        });
        expect(generate).not.toHaveBeenCalled();
        expect(
          state.storage.sql
            .exec("SELECT * FROM osfo_personal_skill_learning_model_attempts")
            .toArray(),
        ).toEqual([]);
        return;
      }
      await waitForSkill(state.storage);
      const settingsActor = {
        decisionReference: "personal-skill-settings-decision",
        userId,
      };
      const settings = await agent.inspectPersonalSkills(settingsActor);
      if (!("skills" in settings)) throw new Error("The Agent did not return Skill settings");
      expect(settings.skills).toHaveLength(1);
      const settingsSkill = settings.skills[0];
      if (settingsSkill === undefined) throw new Error("The Agent returned no learned Skill");
      const archived = await agent.changePersonalSkill({
        actor: settingsActor,
        change: {
          change: "archive",
          expectedRevision: settingsSkill.revisionReference,
          reference: settingsSkill.reference,
        },
      });
      if (!("skill" in archived)) throw new Error("The Agent did not archive the learned Skill");
      expect(archived.skill.status).toBe("archived");
      const restored = await agent.changePersonalSkill({
        actor: settingsActor,
        change: {
          change: "undo",
          expectedRevision: archived.skill.revisionReference,
          reference: archived.skill.reference,
        },
      });
      if (!("skill" in restored)) throw new Error("The Agent did not undo Skill archival");
      expect(restored.skill.status).toBe("active");
      const foreign = await agent.inspectPersonalSkills({
        decisionReference: "foreign-settings-decision",
        userId: UserId.make("another-user"),
      });
      if (!("skills" in foreign)) throw new Error("The Agent did not return foreign isolation");
      expect(foreign.skills).toEqual([]);
      const restartedAgent = new OsfoAgent(state, runtimeEnv);
      expect(restartedAgent).not.toBe(agent);
      historyReads.mockClear();
      await restartedAgent.onStart();
      expect(historyReads).not.toHaveBeenCalled();
      const matchingSubmissionId = ThinkSubmissionId.make("personal-skill-submission-matching");
      const matchingMetadata = turnMetadata({
        sessionId: matchingSessionId,
        submissionId: matchingSubmissionId,
      });
      await restartedAgent.onSubmissionStatus(runningSubmission(matchingMetadata));
      await restartedAgent.addMessages([
        managedUserMessage(
          "personal-skill-user-matching",
          "Create my weekly report as a PDF.",
          matchingMetadata,
        ),
      ]);
      const matchingTurnContext = turnContext(
        "Create my weekly report as a PDF.",
        compiledAgentTools(restartedAgent),
        new MockLanguageModelV4(),
      );
      await restartedAgent.beforeTurn(matchingTurnContext);
      expect(historyReads).toHaveBeenCalled();
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM osfo_personal_skill_learning_candidates",
          )
          .one().count,
      ).toBe(1);
      const matchingState = latestManagedTurn(restartedAgent.messages);
      expect(matchingState.capabilityTurnState.eligiblePersonalSkills).toHaveLength(1);
      const selected = matchingState.capabilityTurnState.eligiblePersonalSkills[0];
      if (selected === undefined)
        throw new Error("The matching turn did not pin the learned Skill");
      const loadSkill = restartedAgent.getTools().loadSkill;
      if (loadSkill?.execute === undefined)
        throw new Error("The matching turn did not expose loadSkill");
      const loaded = await loadSkill.execute(
        { skillId: selected.skillId, skillVersion: selected.skillVersion },
        { context: {}, messages: [], toolCallId: "personal-skill-load-matching" },
      );
      expect(loaded).toMatchObject({
        instructions: "Put the summary first in every weekly report.",
      });

      const secondSubmissionId = ThinkSubmissionId.make("personal-skill-submission-second");
      const secondMetadata = turnMetadata({
        sessionId: matchingSessionId,
        submissionId: secondSubmissionId,
      });
      await restartedAgent.onSubmissionStatus(runningSubmission(secondMetadata));
      await restartedAgent.addMessages([
        managedUserMessage(
          "personal-skill-user-second",
          "Create another weekly report as a PDF.",
          secondMetadata,
        ),
      ]);
      await restartedAgent.beforeTurn(
        turnContext(
          "Create another weekly report as a PDF.",
          compiledAgentTools(restartedAgent),
          new MockLanguageModelV4(),
        ),
      );
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM osfo_personal_skill_learning_candidates",
          )
          .one().count,
      ).toBe(1);

      const unrelatedAgent = new OsfoAgent(state, runtimeEnv);
      await unrelatedAgent.onStart();
      const unrelatedSubmissionId = ThinkSubmissionId.make("personal-skill-submission-unrelated");
      const unrelatedMetadata = turnMetadata({
        sessionId: unrelatedSessionId,
        submissionId: unrelatedSubmissionId,
      });
      await unrelatedAgent.onSubmissionStatus(runningSubmission(unrelatedMetadata));
      await unrelatedAgent.addMessages([
        managedUserMessage(
          "personal-skill-user-unrelated",
          "Create a birthday invitation PDF.",
          unrelatedMetadata,
        ),
      ]);
      await unrelatedAgent.beforeTurn(
        turnContext(
          "Create a birthday invitation PDF.",
          compiledAgentTools(unrelatedAgent),
          new MockLanguageModelV4(),
        ),
      );
      expect(
        latestManagedTurn(unrelatedAgent.messages).capabilityTurnState.eligiblePersonalSkills,
      ).toEqual([]);

      const deletion = await unrelatedAgent.presentPersonalSkillDeletion({
        actor: settingsActor,
        reference: restored.skill.reference,
      });
      if (!("reference" in deletion)) throw new Error("The Agent did not present Skill deletion");
      const editedDeletion = await unrelatedAgent.deletePersonalSkillFromSettings({
        actor: settingsActor,
        reference: deletion.reference,
        request: {
          approval: {
            decision: "approved",
            presentation: { ...deletion, expectedRevision: "edited-revision" },
          },
          confirmation: "delete-this-skill",
        },
      });
      expect(editedDeletion).toMatchObject({ _tag: "PersonalSkillApprovalInvalid" });
      expect(
        await unrelatedAgent.deletePersonalSkillFromSettings({
          actor: settingsActor,
          reference: deletion.reference,
          request: {
            approval: { decision: "approved", presentation: deletion },
            confirmation: "delete-this-skill",
          },
        }),
      ).toEqual({ status: "deleted" });
      const afterDeletion = await unrelatedAgent.inspectPersonalSkills(settingsActor);
      if (!("skills" in afterDeletion)) throw new Error("The Agent did not confirm Skill deletion");
      expect(afterDeletion.skills).toEqual([]);
    });
  },
);

const learningModel = (): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          text: JSON.stringify({
            _tag: "Change",
            description: "Prepare the User's weekly status report.",
            instructions: "Put the summary first in every weekly report.",
            keywords: ["weekly report", "summary first"],
            materiality: "material",
          }),
          type: "text",
        },
      ],
      finishReason: { raw: undefined, unified: "stop" },
      usage: {
        inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 10, total: 10 },
        outputTokens: { reasoning: undefined, text: 10, total: 10 },
      },
      warnings: [],
    }),
  });

const turnContext = (text: string, tools: ToolSet, model: LanguageModel) => ({
  continuation: false,
  messages: [{ content: text, role: "user" }] satisfies Array<ModelMessage>,
  model,
  system: "",
  tools,
});

/** Mirror Think's action compilation for document Skill selection. */
const compiledAgentTools = (agent: OsfoAgent): ToolSet => ({
  ...agent.getTools(),
  inspectPdfForm: tool({
    description: "Inspect an owned PDF form.",
    execute: async () => ({}),
    inputSchema: effectToolSchema(Schema.Struct({})),
    metadata: { cfThinkAction: true },
  }),
  generateDocument: tool({
    description: "Generate a retained document.",
    execute: async () => ({}),
    inputSchema: effectToolSchema(Schema.Struct({})),
    metadata: { cfThinkAction: true },
  }),
});

const managedUserMessage = (
  id: string,
  text: string,
  turnMetadata: ManagedTurnMetadata,
): UIMessage => ({
  id,
  metadata: { turnMetadata },
  parts: [{ text, type: "text" }],
  role: "user",
});

const latestManagedTurn = (messages: ReadonlyArray<UIMessage>): ManagedTurnMetadata => {
  const metadata = messages.reduceRight<ManagedTurnMetadata | undefined>(
    (found, message) => found ?? ManagedCapabilityState.readManagedTurn(message),
    undefined,
  );
  if (metadata === undefined) throw new Error("The Agent did not retain managed turn metadata");
  return metadata;
};

const turnMetadata = ({
  sessionId,
  submissionId,
}: {
  readonly sessionId: string;
  readonly submissionId: ThinkSubmissionId;
}): ManagedTurnMetadata =>
  Schema.decodeSync(ManagedTurnMetadata)({
    _tag: "OsfoManagedTurn",
    allowancePeriodId: "personal-skill-allowance",
    authorityIdentity: {
      _tag: "AuthSession",
      authSessionId: "personal-skill-auth-session",
      userId,
    },
    capabilityCatalogVersion: "governed-capabilities-v1",
    conservativeVendorUsdMicros: 100,
    coreMemoryAuthorization: {
      authority: {
        _tag: "AuthSession",
        authSessionId: "personal-skill-auth-session",
        expiresAt: "2026-08-27T13:00:00.000Z",
        userId,
      },
      deletionAccess: { _tag: "DeletionAccessAvailable" },
      now: "2026-08-27T12:00:00.000Z",
      originatingAuthority: {
        _tag: "AuthSession",
        authSessionId: "personal-skill-auth-session",
      },
      resourceOwnerUserId: userId,
      subscription: { plan: "free", planPolicyVersion: "launch-v1" },
      user: { _tag: "ActiveUser", userId },
    },
    maxInputTokens: 32_000,
    maxOutputTokens: 4_096,
    maxRetries: 0,
    maxSteps: 5,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: "personal-skill-auth-session",
    },
    plan: "free",
    planPolicyVersion: "launch-v1",
    route: "@cf/test/model",
    routeId: "personal-skill-journey-route",
    sessionId,
    submissionId,
    targetInputTokens: 18_000,
  });

const runningSubmission = (metadata: ManagedTurnMetadata) => ({
  createdAt: 1_788_000_000_200,
  metadata,
  requestId: metadata.submissionId,
  startedAt: 1_788_000_000_200,
  status: "running" as const,
  submissionId: metadata.submissionId,
});

const waitForSkill = async (storage: DurableObjectStorage): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const count = storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM osfo_personal_skills")
      .one().count;
    if (count === 1) return;
    await scheduler.wait(10);
  }
  const candidates = storage.sql
    .exec(
      "SELECT candidate_id, candidate_json, status, attempts, claim_token FROM osfo_personal_skill_learning_candidates",
    )
    .toArray();
  const attempts = storage.sql
    .exec("SELECT candidate_id, outcome, basis FROM osfo_personal_skill_learning_model_attempts")
    .toArray();
  throw new Error(
    `Personal Skill Learning did not settle before the journey deadline: ${JSON.stringify({ attempts, candidates })}`,
  );
};
