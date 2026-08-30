import { describe, expect, it } from "vitest";

import {
  QualificationControlledAgentAbortApplied,
  QualificationControlledAgentAbortArm,
  qualificationControlledAgentAbortOperationId,
  qualificationControlledAgentAbortReconciliation,
  qualificationControlledAgentFaultDeletionFenced,
  qualificationControlledAgentFaultControllerRecord,
  qualificationControlledAgentFaultReceipt,
  qualificationControlledAgentRecoveryReceipt,
  validQualificationControlledAgentFaultControllerRecord,
} from "./controlled-agent-fault";
import { qualificationChecksum } from "./qualification-checksum";

const context = {
  attemptId: "attempt-1",
  executionId: "execution-1",
  journey: "ordinaryConversation" as const,
  offeredAtEpochMs: Date.parse("2026-08-30T12:00:00.000Z"),
  planChecksum: qualificationChecksum({ plan: 1 }),
  region: "americas" as const,
  rootId: "root-1",
  runId: "BoundedBeta:americas:challenge:coldActivation",
};

describe("controlled Agent fault authority", () => {
  it("binds the operation and exact one-root run receipt to applied and restored facts", () => {
    const controllerOperationId = qualificationControlledAgentAbortOperationId(context);
    const recovery = qualificationControlledAgentRecoveryReceipt({
      applicationAuthorityFactId: "application-1",
      appliedAtUtc: "2026-08-30T11:59:59.800Z",
      armedActivationId: "activation-old",
      controllerOperationId,
      executionId: context.executionId,
      manifestChecksum: qualificationChecksum({ manifest: 1 }),
      planChecksum: context.planChecksum,
      recoveredActivationId: "activation-new",
      recoveredAtUtc: "2026-08-30T11:59:59.900Z",
      rootId: context.rootId,
      runId: context.runId,
    });
    const receipt = qualificationControlledAgentFaultReceipt({
      manifestChecksum: qualificationChecksum({ manifest: 1 }),
      receipt: recovery,
      scheduledTriggerAtUtc: "2026-08-30T12:00:00.000Z",
    });

    expect(controllerOperationId).toBe(
      qualificationChecksum({ context, kind: "coldActivation", target: "osfoAgent" }),
    );
    expect(receipt).toMatchObject({
      applicationAuthorityFactId: "application-1",
      applicationStatus: "applied",
      controllerOperationId,
      endedAtUtc: recovery.recoveredAtUtc,
      kind: "coldActivation",
      restorationAuthorityFactId: recovery.restorationAuthorityFactId,
      runId: context.runId,
      target: "osfoAgent",
      trigger: "beforeOffer",
    });
    const { artifactChecksum, ...content } = receipt;
    expect(artifactChecksum).toBe(qualificationChecksum(content));
  });

  it("never repeats an abort after an ambiguous activation transition", () => {
    expect(
      qualificationControlledAgentAbortReconciliation({
        armedActivationId: "activation-old",
        observedActivationId: "activation-old",
        retainedState: "armed",
      }),
    ).toBe("abortArmedActivation");
    expect(
      qualificationControlledAgentAbortReconciliation({
        armedActivationId: "activation-old",
        observedActivationId: "activation-new",
        retainedState: "armed",
      }),
    ).toBe("retainMissing");
    expect(
      qualificationControlledAgentAbortReconciliation({
        armedActivationId: "activation-old",
        observedActivationId: "activation-old",
        retainedState: "applied",
      }),
    ).toBe("retainMissing");
    expect(
      qualificationControlledAgentAbortReconciliation({
        armedActivationId: "activation-old",
        observedActivationId: "activation-new",
        retainedState: "applied",
      }),
    ).toBe("recoverChangedActivation");
  });

  it("rejects checksummed controller rows with substituted arm and applied records", () => {
    const controllerOperationId = qualificationControlledAgentAbortOperationId(context);
    const command = {
      context,
      controllerOperationId,
      manifestChecksum: "manifest-1",
      proofArtifactChecksum: "proof-checksum-1",
      proofArtifactId: "proof-1",
      sessionId: "session-1",
    };
    const armContent = {
      ...command,
      armedActivationId: "activation-old",
      armedAtUtc: "2026-08-30T11:59:59.000Z",
    };
    const arm = QualificationControlledAgentAbortArm.make({
      ...armContent,
      artifactChecksum: qualificationChecksum(armContent),
    });
    const applied = QualificationControlledAgentAbortApplied.make({
      ...command,
      applicationAuthorityFactId: "application-1",
      appliedAtUtc: "2026-08-30T11:59:59.500Z",
      armedActivationId: "activation-old",
    });
    expect(
      validQualificationControlledAgentFaultControllerRecord(
        qualificationControlledAgentFaultControllerRecord({
          agentId: "agent-1",
          applied,
          arm,
          state: "applied",
        }),
      ),
    ).toBe(true);
    expect(
      validQualificationControlledAgentFaultControllerRecord(
        qualificationControlledAgentFaultControllerRecord({
          agentId: "agent-1",
          applied: { ...applied, sessionId: "substituted-session" },
          arm,
          state: "applied",
        }),
      ),
    ).toBe(false);
  });

  it("cannot recreate an Agent deleted while the durable fence read is in flight", () => {
    let hasAgent = true;
    const deletionRead = controlledDeletionRead();
    const fenced = qualificationControlledAgentFaultDeletionFenced({
      hasAgent: () => hasAgent,
      readDeletionStarted: () => deletionRead.promise,
    });

    hasAgent = false;
    deletionRead.resolve(false);
    return expect(fenced).resolves.toBe(true);
  });
});

const controlledDeletionRead = () => {
  let completeDeletionRead: ((deletionStarted: boolean) => void) | undefined;
  // oxlint-disable-next-line effecttsgo/new-promise -- The unresolved host read models deletion racing a Durable Object storage await.
  const promise = new Promise<boolean>((complete) => {
    completeDeletionRead = complete;
  });
  return {
    promise,
    resolve(deletionStarted: boolean) {
      completeDeletionRead?.(deletionStarted);
    },
  };
};
