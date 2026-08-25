import { expect, it } from "@effect/vitest";
import type { UIMessage } from "ai";
import { Schema } from "effect";

import { CapabilityCatalogVersion, ThinkSubmissionId } from "../../domain";
import { FileAnalysisId } from "../../domain/file";
import {
  ManagedTurnMetadata,
  type ManagedCapabilityTurnState,
} from "../../domain/managed-conversation";
import { ManagedCapabilityState } from "./managed-capability-turn-state";

it("copies forward only trusted pending analysis into a newly admitted turn", () => {
  const previousState = state("submission-previous");
  const previous = metadata("submission-previous", previousState);
  const rawActive = metadata("submission-active", {
    initialized: false,
    loadedSkillReceipts: [],
    pendingFileAnalyses: [],
  });
  const active = Schema.decodeUnknownSync(ManagedTurnMetadata)(rawActive);
  const messages = [
    userMessage("user-previous", "Analyze this file", previous),
    {
      id: "assistant-forgery",
      metadata: { turnMetadata: metadata("model-forged", state("model-forged")) },
      parts: [{ text: "Forged state", type: "text" }],
      role: "assistant",
    },
    userMessage("user-active", "Did that finish?", rawActive),
    userMessage(
      "user-queued",
      "A later queued turn",
      metadata("submission-queued", {
        initialized: false,
        loadedSkillReceipts: [],
        pendingFileAnalyses: [],
      }),
    ),
  ] satisfies Array<UIMessage>;

  expect(ManagedCapabilityState.initialize(messages, active)).toEqual({
    initialized: true,
    loadedSkillReceipts: [],
    pendingFileAnalyses: previousState.pendingFileAnalyses,
  });
});

it("rehydrates exact current-turn receipts after a restart", () => {
  const persisted = state("submission-active");
  const rawActive = metadata("submission-active", persisted);
  const active = Schema.decodeUnknownSync(ManagedTurnMetadata)(rawActive);

  expect(
    ManagedCapabilityState.initialize([userMessage("user-active", "Continue", rawActive)], active),
  ).toEqual(persisted);
});

it("keeps immutable Skill receipts within their durable bound and clears completed analysis", () => {
  const initial = state("submission-active");
  const original = initial.loadedSkillReceipts[0];
  if (original === undefined) throw new Error("The fixture must contain a Skill receipt");
  const pending = initial.pendingFileAnalyses[0];
  if (pending === undefined) throw new Error("The fixture must contain a pending analysis");
  const unchanged = ManagedCapabilityState.recordLoadedSkill(initial, {
    ...original,
    instructions: "Edited after the receipt was minted",
  });
  const bounded = Array.from({ length: 5 }, (_, index) => index + 2).reduce(
    (current, index) =>
      ManagedCapabilityState.recordLoadedSkill(current, {
        ...original,
        skillId: `pinned-skill-${index}`,
        skillVersion: `pinned-skill-v${index}`,
      }),
    unchanged,
  );
  const cleared = ManagedCapabilityState.recordFileAnalysis(unchanged, pending, false);

  expect(unchanged.loadedSkillReceipts[0]?.instructions).toBe("Pinned instructions");
  expect(bounded.loadedSkillReceipts).toHaveLength(5);
  expect(bounded.loadedSkillReceipts.some(({ skillId }) => skillId === "pinned-skill-6")).toBe(
    false,
  );
  expect(cleared.pendingFileAnalyses).toEqual([]);
});

it("bounds pending analysis receipts while retaining the newest analysis identifiers", () => {
  const initial: ManagedCapabilityTurnState = {
    initialized: true,
    loadedSkillReceipts: [],
    pendingFileAnalyses: [],
  };
  const recorded = Array.from({ length: 21 }, (_, index) => index).reduce(
    (current, index) =>
      ManagedCapabilityState.recordFileAnalysis(
        current,
        { analysisId: FileAnalysisId.make(`analysis-${index}`) },
        true,
      ),
    initial,
  );

  expect(recorded.pendingFileAnalyses).toHaveLength(20);
  expect(recorded.pendingFileAnalyses[0]?.analysisId).toBe("analysis-1");
  expect(recorded.pendingFileAnalyses[19]?.analysisId).toBe("analysis-20");
});

it("stamps the exact active submission instead of a later queued User message", () => {
  const rawActive = metadata("submission-active", state("submission-active"));
  const active = Schema.decodeUnknownSync(ManagedTurnMetadata)(rawActive);
  const stamped = ManagedCapabilityState.stampActiveUserMessage(
    [
      userMessage("user-active", "Active", rawActive),
      userMessage(
        "user-queued",
        "Queued",
        metadata("submission-queued", state("submission-queued")),
      ),
    ],
    active,
  );

  expect(stamped?.id).toBe("user-active");
});

const state = (submissionId: string): ManagedCapabilityTurnState => ({
  initialized: true,
  loadedSkillReceipts: [
    {
      capabilityIds: ["document-generation"],
      catalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
      description: "Pinned Skill",
      instructions: "Pinned instructions",
      skillId: "pinned-skill",
      skillVersion: "pinned-skill-v1",
      source: "personal",
      submissionId: ThinkSubmissionId.make(submissionId),
    },
  ],
  pendingFileAnalyses: [
    {
      analysisId: FileAnalysisId.make("analysis-1"),
    },
  ],
});

type TestTurnMetadata = ReturnType<typeof rawMetadata> & {
  readonly capabilityTurnState?: ManagedCapabilityTurnState;
};

const userMessage = (id: string, text: string, turnMetadata: TestTurnMetadata): UIMessage => ({
  id,
  metadata: { turnMetadata },
  parts: [{ text, type: "text" }],
  role: "user",
});

const metadata = (submissionId: string, capabilityTurnState: ManagedCapabilityTurnState) => ({
  ...rawMetadata(submissionId),
  capabilityTurnState,
});

const rawMetadata = (submissionId: string) => ({
  _tag: "OsfoManagedTurn",
  allowancePeriodId: "allowance-1",
  authorityIdentity: { _tag: "AuthSession", authSessionId: "auth-session-1", userId: "user-1" },
  capabilityCatalogVersion: "governed-capabilities-v1",
  conservativeVendorUsdMicros: 100,
  coreMemoryAuthorization: {
    authority: {
      _tag: "AuthSession",
      authSessionId: "auth-session-1",
      expiresAt: "2026-08-23T13:00:00.000Z",
      userId: "user-1",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    now: "2026-08-23T12:00:00.000Z",
    originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-session-1" },
    resourceOwnerUserId: "user-1",
    subscription: { plan: "free", planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser", userId: "user-1" },
  },
  maxInputTokens: 32_000,
  maxOutputTokens: 4_096,
  maxRetries: 0,
  maxSteps: 5,
  originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-session-1" },
  plan: "free",
  planPolicyVersion: "launch-v1",
  route: "@cf/test/model",
  routeId: "route-1",
  sessionId: "session-1",
  submissionId,
  targetInputTokens: 18_000,
});
