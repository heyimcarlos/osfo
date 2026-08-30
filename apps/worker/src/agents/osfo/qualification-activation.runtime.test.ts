/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Workerd RPC tests exercise Promise-native Agent boundaries with fixed authority time. */
/* oxlint-disable eslint/no-underscore-dangle -- Agent outcomes use the repository-standard _tag discriminator. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Runtime test bindings and inherited overload replacement are proven by wrangler.runtime.jsonc and the local test boundary. */
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import {
  AgentId,
  AllowancePeriodId,
  ConversationRouteId,
  PlanPolicyVersion,
  ThinkSubmissionId,
  UserId,
} from "../../domain";
import { AuthSessionId } from "../../domain/auth-session";
import { emptyLiveResourceFacts, type AuthorizationContext } from "../../services/authorization";
import { OsfoAgent } from "../osfo/agent";
import {
  QualificationConversationAttemptArtifact,
  qualificationAttemptArtifactId,
  type SubmitQualificationConversationRequest,
} from "../../qualification/qualification-attempt";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";

const agentId = AgentId.make("qualification-activation-runtime-agent");
const routeId = ConversationRouteId.make("qualification-activation-runtime-route");
const sessionId = "qualification-activation-runtime-session";
const userId = UserId.make("qualification-activation-runtime-user");
const authorization = authorizationContext();

it("refreshes a fresh initialization claim and does not regrant it on initialize replay", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(runtimeEnv.OSFO_AGENT_TEST.idFromName(agentId));
  await runInDurableObject(stub, async (_boundAgent, state) => {
    const agent = new OsfoAgent(state, runtimeEnv);
    await agent.onStart();
    await agent.initialize(initializationInput());
    replaceRunTurn(agent);

    const first = await submitQualification(agent, runtimeEnv.ARTIFACTS, "first", "root-first");
    expect(first).toMatchObject({ accepted: true, submissionId: "qualification-first" });
    expect(await activationReceipts(agent)).toMatchObject({
      receipts: [{ cause: "firstUse", classification: "cold", rootId: "root-first" }],
    });

    await agent.initialize(initializationInput());
    const second = await submitQualification(agent, runtimeEnv.ARTIFACTS, "second", "root-second");
    expect(second).toMatchObject({ accepted: true, submissionId: "qualification-second" });
    expect(await activationReceipts(agent)).toMatchObject({
      receipts: [
        { cause: "firstUse", classification: "cold", rootId: "root-first" },
        { cause: "warm", classification: "warm", rootId: "root-second" },
      ],
    });
  });
});

it("does not block ordinary product work or prove first-use after observation failure", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("qualification-activation-observation-failure"),
  );
  await runInDurableObject(stub, async (_boundAgent, state) => {
    const agent = new OsfoAgent(state, runtimeEnv);
    await agent.onStart();
    await agent.initialize({
      ...initializationInput(),
      agentId: "qualification-activation-observation-failure",
    });
    replaceRunTurn(agent);
    state.storage.sql.exec("DELETE FROM osfo_qualification_runtime_activations");

    const ordinary = await agent.submitManagedConversation({
      authorization,
      idempotencyKey: "ordinary-after-observation-failure",
      message: "Continue ordinary product work",
      routeId,
      submissionId: "ordinary-after-observation-failure",
    });
    expect(ordinary).toMatchObject({ accepted: true });

    const unavailable = await submitQualification(
      agent,
      runtimeEnv.ARTIFACTS,
      "same-activation-after-failure",
      "root-same-activation-after-failure",
    );
    expect("_tag" in unavailable ? unavailable._tag : null).toBe("ThinkSubmissionUnavailable");

    const restarted = new OsfoAgent(state, runtimeEnv);
    await restarted.onStart();
    replaceRunTurn(restarted);
    const afterRestart = await submitQualification(
      restarted,
      runtimeEnv.ARTIFACTS,
      "restart-after-failure",
      "root-restart-after-failure",
    );
    expect(afterRestart).toMatchObject({ accepted: true });
    expect(await activationReceipts(restarted)).toMatchObject({
      receipts: [{ cause: null, classification: null, rootId: "root-restart-after-failure" }],
    });
  });
});

it("reports a retained activation checksum conflict through the Agent RPC", async () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct binding to OsfoAgent.
  const runtimeEnv = env as typeof env & {
    readonly OSFO_AGENT_TEST: DurableObjectNamespace<OsfoAgent>;
  };
  const stub = runtimeEnv.OSFO_AGENT_TEST.get(
    runtimeEnv.OSFO_AGENT_TEST.idFromName("qualification-activation-corrupt-receipt"),
  );
  await runInDurableObject(stub, async (_boundAgent, state) => {
    const agent = new OsfoAgent(state, runtimeEnv);
    await agent.onStart();
    await agent.initialize({
      ...initializationInput(),
      agentId: "qualification-activation-corrupt-receipt",
    });
    replaceRunTurn(agent);
    await submitQualification(agent, runtimeEnv.ARTIFACTS, "corrupt", "root-corrupt");
    state.storage.sql.exec(
      "UPDATE osfo_qualification_activation_receipts SET artifact_checksum = 'corrupt' WHERE attempt_id = 'attempt-corrupt'",
    );

    expect(await activationReceipts(agent)).toEqual({
      _tag: "QualificationActivationAuthorityConflict",
    });
  });
});

const initializationInput = () => ({
  agentId,
  initializationId: "qualification-activation-runtime-initialization",
  initializedAt: "2026-08-29T17:00:00.000Z",
  routeId,
  sessionId,
});

function authorizationContext(): AuthorizationContext {
  const now = new Date("2026-08-29T17:00:00.000Z");
  const resetsAt = new Date("2026-09-29T17:00:00.000Z");
  const authSessionId = AuthSessionId.make("qualification-activation-runtime-auth-session");
  return {
    allowance: {
      _tag: "Metered",
      allowancePeriodId: AllowancePeriodId.make("qualification-activation-runtime-allowance"),
      endsAt: resetsAt,
      plan: "free",
      planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      startsAt: now,
      usage: [],
    },
    approval: null,
    authority: { _tag: "AuthSession", authSessionId, expiresAt: resetsAt, userId },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    integrationConnections: [],
    liveFacts: emptyLiveResourceFacts,
    now,
    originatingAuthority: { _tag: "AuthSession", authSessionId },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: userId,
    subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
    user: { _tag: "ActiveUser", userId },
  };
}

const replaceRunTurn = (agent: OsfoAgent): void => {
  Object.defineProperty(agent, "runTurn", {
    configurable: true,
    value: (input: { readonly submissionId: string }) =>
      Promise.resolve({
        accepted: true,
        createdAt: Date.parse("2026-08-29T17:00:01.000Z"),
        status: "pending" as const,
        submissionId: input.submissionId,
      }),
  });
};

const submitQualification = async (
  agent: OsfoAgent,
  artifacts: R2Bucket,
  suffix: string,
  rootId: string,
) => {
  const submissionId = ThinkSubmissionId.make(`qualification-${suffix}`);
  const qualificationContext = {
    attemptId: `attempt-${suffix}`,
    executionId: "qualification-activation-runtime-execution",
    journey: "ordinaryConversation" as const,
    offeredAtEpochMs: Date.parse("2026-08-29T17:00:00.000Z"),
    planChecksum: "qualification-activation-runtime-plan",
    region: "americas" as const,
    rootId,
    runId: "qualification-activation-runtime-run",
  };
  const message = "Exercise the qualification activation boundary";
  const proofContent = {
    agentId: AgentId.make(agent.name),
    authSessionExpiresAtUtc: "2026-09-29T17:00:00.000Z",
    authSessionId: "qualification-activation-runtime-auth-session",
    context: qualificationContext,
    messageChecksum: qualificationChecksum({ message }),
    participantGrantChecksum: "qualification-activation-runtime-participant-grant",
    routeId,
    submissionId,
    userId,
  };
  const proof = QualificationConversationAttemptArtifact.make({
    ...proofContent,
    artifactChecksum: qualificationChecksum(proofContent),
  });
  const proofArtifactId = qualificationAttemptArtifactId(qualificationContext);
  await artifacts.put(proofArtifactId, canonicalQualificationJson(proof));
  const request = {
    authorization,
    idempotencyKey: `qualification-idempotency-${suffix}`,
    message,
    proofArtifactChecksum: proof.artifactChecksum,
    proofArtifactId,
    qualificationContext,
    routeId,
    submissionId,
  } satisfies SubmitQualificationConversationRequest;
  return agent.submitQualificationConversation(request);
};

const activationReceipts = (agent: OsfoAgent) =>
  agent.readQualificationActivationReceipts(
    "qualification-activation-runtime-execution",
    sessionId,
  );
