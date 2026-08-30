/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date -- Workerd RPC tests exercise native Agent facets with fixed qualification authority. */
/* oxlint-disable eslint/no-underscore-dangle -- Agent and controller outcomes use the repository-standard _tag discriminator. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- The test-only Directory binding is owned and proven by wrangler.runtime.jsonc. */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
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
import {
  QualificationConversationAttemptArtifact,
  qualificationAttemptArtifactId,
  type SubmitQualificationConversationRequest,
} from "../../qualification/qualification-attempt";
import {
  QualificationControlledAgentAbort,
  qualificationControlledAgentAbortOperationId,
} from "../../qualification/controlled-agent-fault";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../../qualification/qualification-checksum";
import type { OsfoDirectory } from "./directory";

const agentId = AgentId.make("qualification-controlled-fault-agent");
const routeId = ConversationRouteId.make("qualification-controlled-fault-route");
const sessionId = "qualification-controlled-fault-session";
const userId = UserId.make("qualification-controlled-fault-user");

interface FaultFixtureIdentity {
  readonly agentId: AgentId;
  readonly routeId: ConversationRouteId;
  readonly sessionId: string;
  readonly suffix: string;
  readonly userId: UserId;
}

const defaultIdentity: FaultFixtureIdentity = {
  agentId,
  routeId,
  sessionId,
  suffix: "",
  userId,
};

const runtimeEnvironment = () => {
  // SAFETY: wrangler.runtime.jsonc owns this test-only direct Directory binding.
  return env as typeof env & {
    readonly OSFO_DIRECTORY_TEST: DurableObjectNamespace<OsfoDirectory>;
  };
};

it("uses a real facet abort and a distinct onStart activation before the exact root", async () => {
  const runtimeEnv = runtimeEnvironment();
  const directory = runtimeEnv.OSFO_DIRECTORY_TEST.get(
    runtimeEnv.OSFO_DIRECTORY_TEST.idFromName("qualification-controlled-fault-directory"),
  );
  await directory.ensureAgent(agentId);
  await directory.initializeAgent(agentId, {
    agentId,
    initializationId: "qualification-controlled-fault-initialization",
    initializedAt: "2026-08-29T17:00:00.000Z",
    routeId,
    sessionId,
  });
  const request = await qualificationRequest(runtimeEnv.ARTIFACTS);
  const command = QualificationControlledAgentAbort.make({
    context: request.qualificationContext,
    controllerOperationId: qualificationControlledAgentAbortOperationId(
      request.qualificationContext,
    ),
    manifestChecksum: "manifest-controlled-fault",
    proofArtifactChecksum: request.proofArtifactChecksum,
    proofArtifactId: request.proofArtifactId,
    sessionId,
  });

  expect(await directory.applyQualificationControlledAgentAbort(agentId, command)).toMatchObject({
    _tag: "QualificationControlledAgentFaultReady",
    controllerOperationId: command.controllerOperationId,
  });
  expect(await directory.applyQualificationControlledAgentAbort(agentId, command)).toMatchObject({
    _tag: "QualificationControlledAgentFaultReady",
    controllerOperationId: command.controllerOperationId,
  });
  expect(
    await directory.readQualificationControlledAgentRecovery(
      agentId,
      command.controllerOperationId,
    ),
  ).toEqual({ _tag: "QualificationControlledAgentRecoveryAuthority", receipt: null });

  const admitted = await directory.submitQualificationConversation(agentId, request);
  expect(admitted).toMatchObject({ accepted: true, submissionId: request.submissionId });
  expect(
    await directory.readQualificationControlledAgentRecovery(
      agentId,
      command.controllerOperationId,
    ),
  ).toMatchObject({
    _tag: "QualificationControlledAgentRecoveryAuthority",
    receipt: {
      armedActivationId: expect.any(String),
      controllerOperationId: command.controllerOperationId,
      executionId: request.qualificationContext.executionId,
      recoveredActivationId: expect.any(String),
      rootId: request.qualificationContext.rootId,
    },
  });
  expect(
    await directory.readQualificationActivationReceipts(
      agentId,
      request.qualificationContext.executionId,
      sessionId,
    ),
  ).toMatchObject({
    receipts: [
      {
        cause: "faultRecovery",
        classification: "cold",
        controllerOperationId: command.controllerOperationId,
      },
    ],
  });
  const [replayDuringDeletion] = await Promise.all([
    directory.applyQualificationControlledAgentAbort(agentId, command),
    directory.deleteAgent(agentId),
  ]);
  expect([
    "QualificationControlledAgentFaultReady",
    "QualificationControlledAgentFaultUnavailable",
  ]).toContain(replayDuringDeletion._tag);
  expect(await directory.inspectAgent(agentId)).toBeNull();
  expect(
    await directory.readQualificationControlledAgentRecovery(
      agentId,
      command.controllerOperationId,
    ),
  ).toEqual({ _tag: "QualificationControlledAgentFaultUnavailable" });
  await runInDurableObject(directory, async (_boundDirectory, state) => {
    const retained = await state.storage.list();
    expect(
      [...retained.keys()].filter((key) => key.includes("qualification-controlled-agent")),
    ).toEqual([]);
  });
}, 30_000);

it("returns Conflict for malformed retained Directory controller state", async () => {
  const runtimeEnv = runtimeEnvironment();
  const identity = {
    agentId: AgentId.make("qualification-controlled-fault-corrupt-agent"),
    routeId: ConversationRouteId.make("qualification-controlled-fault-corrupt-route"),
    sessionId: "qualification-controlled-fault-corrupt-session",
    suffix: "-corrupt",
    userId: UserId.make("qualification-controlled-fault-corrupt-user"),
  } satisfies FaultFixtureIdentity;
  const directory = runtimeEnv.OSFO_DIRECTORY_TEST.get(
    runtimeEnv.OSFO_DIRECTORY_TEST.idFromName("qualification-controlled-fault-corrupt-directory"),
  );
  await directory.ensureAgent(identity.agentId);
  await directory.initializeAgent(identity.agentId, {
    agentId: identity.agentId,
    initializationId: "qualification-controlled-fault-corrupt-initialization",
    initializedAt: "2026-08-29T17:00:00.000Z",
    routeId: identity.routeId,
    sessionId: identity.sessionId,
  });
  const request = await qualificationRequest(runtimeEnv.ARTIFACTS, identity);
  const command = QualificationControlledAgentAbort.make({
    context: request.qualificationContext,
    controllerOperationId: qualificationControlledAgentAbortOperationId(
      request.qualificationContext,
    ),
    manifestChecksum: "manifest-controlled-fault",
    proofArtifactChecksum: request.proofArtifactChecksum,
    proofArtifactId: request.proofArtifactId,
    sessionId: identity.sessionId,
  });
  const agentHash = qualificationChecksum({
    agentId: identity.agentId,
    kind: "qualification-controlled-agent-fault-agent",
  });
  const key = `qualification-controlled-agent-fault/${agentHash}/${encodeURIComponent(command.controllerOperationId)}`;
  await runInDurableObject(directory, async (_boundDirectory, state) => {
    await state.storage.put(key, { artifactChecksum: "self-authored-corrupt-row" });
  });

  expect(await directory.applyQualificationControlledAgentAbort(identity.agentId, command)).toEqual(
    { _tag: "QualificationControlledAgentFaultConflict" },
  );
  await directory.deleteAgent(identity.agentId);
}, 30_000);

it("reconciles abort throws without repeating an abort against a changed activation", async () => {
  const runtimeEnv = runtimeEnvironment();
  const identity = {
    agentId: AgentId.make("qualification-controlled-fault-ambiguous-agent"),
    routeId: ConversationRouteId.make("qualification-controlled-fault-ambiguous-route"),
    sessionId: "qualification-controlled-fault-ambiguous-session",
    suffix: "-ambiguous",
    userId: UserId.make("qualification-controlled-fault-ambiguous-user"),
  } satisfies FaultFixtureIdentity;
  const directory = runtimeEnv.OSFO_DIRECTORY_TEST.get(
    runtimeEnv.OSFO_DIRECTORY_TEST.idFromName("qualification-controlled-fault-ambiguous-directory"),
  );
  await directory.ensureAgent(identity.agentId);
  await directory.initializeAgent(identity.agentId, {
    agentId: identity.agentId,
    initializationId: "qualification-controlled-fault-ambiguous-initialization",
    initializedAt: "2026-08-29T17:00:00.000Z",
    routeId: identity.routeId,
    sessionId: identity.sessionId,
  });
  const request = await qualificationRequest(runtimeEnv.ARTIFACTS, identity);
  const command = QualificationControlledAgentAbort.make({
    context: request.qualificationContext,
    controllerOperationId: qualificationControlledAgentAbortOperationId(
      request.qualificationContext,
    ),
    manifestChecksum: "manifest-controlled-fault",
    proofArtifactChecksum: request.proofArtifactChecksum,
    proofArtifactId: request.proofArtifactId,
    sessionId: identity.sessionId,
  });
  await runInDurableObject(directory, async (boundDirectory) => {
    const originalAbort = boundDirectory.abortSubAgent.bind(boundDirectory);
    let abortCount = 0;
    Object.defineProperty(boundDirectory, "abortSubAgent", {
      configurable: true,
      value: (...args: Parameters<typeof boundDirectory.abortSubAgent>) => {
        abortCount += 1;
        originalAbort(...args);
        throw new Error("ambiguous abort return");
      },
    });
    expect(
      await boundDirectory.applyQualificationControlledAgentAbort(identity.agentId, command),
    ).toEqual({ _tag: "QualificationControlledAgentFaultUnavailable" });
    expect(
      await boundDirectory.applyQualificationControlledAgentAbort(identity.agentId, command),
    ).toEqual({ _tag: "QualificationControlledAgentFaultUnavailable" });
    expect(abortCount).toBe(1);
  });
  await directory.deleteAgent(identity.agentId);
}, 30_000);

it("retries only the same armed activation after an abort throws before applying", async () => {
  const runtimeEnv = runtimeEnvironment();
  const identity = {
    agentId: AgentId.make("qualification-controlled-fault-safe-retry-agent"),
    routeId: ConversationRouteId.make("qualification-controlled-fault-safe-retry-route"),
    sessionId: "qualification-controlled-fault-safe-retry-session",
    suffix: "-safe-retry",
    userId: UserId.make("qualification-controlled-fault-safe-retry-user"),
  } satisfies FaultFixtureIdentity;
  const directory = runtimeEnv.OSFO_DIRECTORY_TEST.get(
    runtimeEnv.OSFO_DIRECTORY_TEST.idFromName(
      "qualification-controlled-fault-safe-retry-directory",
    ),
  );
  await directory.ensureAgent(identity.agentId);
  await directory.initializeAgent(identity.agentId, {
    agentId: identity.agentId,
    initializationId: "qualification-controlled-fault-safe-retry-initialization",
    initializedAt: "2026-08-29T17:00:00.000Z",
    routeId: identity.routeId,
    sessionId: identity.sessionId,
  });
  const request = await qualificationRequest(runtimeEnv.ARTIFACTS, identity);
  const command = QualificationControlledAgentAbort.make({
    context: request.qualificationContext,
    controllerOperationId: qualificationControlledAgentAbortOperationId(
      request.qualificationContext,
    ),
    manifestChecksum: "manifest-controlled-fault",
    proofArtifactChecksum: request.proofArtifactChecksum,
    proofArtifactId: request.proofArtifactId,
    sessionId: identity.sessionId,
  });
  await runInDurableObject(directory, async (boundDirectory) => {
    const originalAbort = boundDirectory.abortSubAgent.bind(boundDirectory);
    Object.defineProperty(boundDirectory, "abortSubAgent", {
      configurable: true,
      value: () => {
        throw new Error("abort failed before application");
      },
    });
    expect(
      await boundDirectory.applyQualificationControlledAgentAbort(identity.agentId, command),
    ).toEqual({ _tag: "QualificationControlledAgentFaultUnavailable" });
    Object.defineProperty(boundDirectory, "abortSubAgent", {
      configurable: true,
      value: originalAbort,
    });
    expect(
      await boundDirectory.applyQualificationControlledAgentAbort(identity.agentId, command),
    ).toMatchObject({ _tag: "QualificationControlledAgentFaultReady" });
  });
  await directory.deleteAgent(identity.agentId);
}, 30_000);

const qualificationRequest = async (
  artifacts: R2Bucket,
  identity: FaultFixtureIdentity = defaultIdentity,
): Promise<SubmitQualificationConversationRequest> => {
  const qualificationContext = {
    attemptId: `qualification-controlled-fault-attempt${identity.suffix}`,
    executionId: `qualification-controlled-fault-execution${identity.suffix}`,
    journey: "ordinaryConversation" as const,
    offeredAtEpochMs: 1_787_500_000_000,
    planChecksum: "qualification-controlled-fault-plan",
    region: "americas" as const,
    rootId: `qualification-controlled-fault-root${identity.suffix}`,
    runId: `qualification-controlled-fault-run${identity.suffix}`,
  };
  const submissionId = ThinkSubmissionId.make(
    `qualification-controlled-fault-submission${identity.suffix}`,
  );
  const message = "Run the exact controlled cold-activation qualification root.";
  const proofContent = {
    agentId: identity.agentId,
    authSessionExpiresAtUtc: "2026-09-29T17:00:00.000Z",
    authSessionId: "qualification-controlled-fault-auth-session",
    context: qualificationContext,
    messageChecksum: qualificationChecksum({ message }),
    participantGrantChecksum: "qualification-controlled-fault-participant",
    routeId: identity.routeId,
    submissionId,
    userId: identity.userId,
  };
  const proof = QualificationConversationAttemptArtifact.make({
    ...proofContent,
    artifactChecksum: qualificationChecksum(proofContent),
  });
  const proofArtifactId = qualificationAttemptArtifactId(qualificationContext);
  await artifacts.put(proofArtifactId, canonicalQualificationJson(proof));
  return {
    authorization: authorizationContext(identity.userId),
    idempotencyKey: qualificationContext.attemptId,
    message,
    proofArtifactChecksum: proof.artifactChecksum,
    proofArtifactId,
    qualificationContext,
    routeId: identity.routeId,
    submissionId,
  };
};

const authorizationContext = (authorizedUserId: UserId = userId): AuthorizationContext => {
  const now = new Date("2026-08-29T17:00:00.000Z");
  const resetsAt = new Date("2026-09-29T17:00:00.000Z");
  return {
    allowance: {
      _tag: "Metered",
      allowancePeriodId: AllowancePeriodId.make("qualification-controlled-fault-allowance"),
      endsAt: resetsAt,
      plan: "free",
      planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
      startsAt: now,
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make("qualification-controlled-fault-auth-session"),
      expiresAt: resetsAt,
      userId: authorizedUserId,
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    integrationConnections: [],
    liveFacts: emptyLiveResourceFacts,
    now,
    originatingAuthority: {
      _tag: "AuthSession",
      authSessionId: AuthSessionId.make("qualification-controlled-fault-auth-session"),
    },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: authorizedUserId,
    subscription: { plan: "free", planPolicyVersion: PlanPolicyVersion.make("launch-v1") },
    user: { _tag: "ActiveUser", userId: authorizedUserId },
  };
};
