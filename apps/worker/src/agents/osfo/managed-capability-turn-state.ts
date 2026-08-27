import type { UIMessage } from "ai";
import { Option, Schema } from "effect";

import {
  maximumLoadedSkillsPerTurn,
  ManagedTurnMetadata,
  type ManagedCapabilityTurnState,
  type ManagedLoadedSkillReceipt,
  type ManagedPendingFileAnalysis,
} from "../../domain/managed-conversation";

const TurnMetadataEnvelope = Schema.Struct({ turnMetadata: ManagedTurnMetadata });

/** Initialize one turn from its server receipt, copying forward only pending analyses. */
export const initialize = (
  messages: ReadonlyArray<UIMessage>,
  activeMetadata: ManagedTurnMetadata,
): ManagedCapabilityTurnState => {
  if (activeMetadata.capabilityTurnState.initialized) {
    return activeMetadata.capabilityTurnState;
  }
  const previous = previousManagedTurn(messages, activeMetadata.submissionId);
  return {
    eligiblePersonalSkills: [],
    initialized: true,
    loadedSkillReceipts: [],
    pendingFileAnalyses: previous?.capabilityTurnState.pendingFileAnalyses ?? [],
    skillLearningDraft: null,
  };
};

/** Add one exact Skill receipt once without allowing a later source edit to replace it. */
export const recordLoadedSkill = (
  state: ManagedCapabilityTurnState,
  receipt: ManagedLoadedSkillReceipt,
): ManagedCapabilityTurnState => {
  const alreadyRetained = state.loadedSkillReceipts.some(
    ({ skillId, skillVersion }) =>
      skillId === receipt.skillId && skillVersion === receipt.skillVersion,
  );
  if (alreadyRetained || state.loadedSkillReceipts.length >= maximumLoadedSkillsPerTurn) {
    return state;
  }
  return { ...state, loadedSkillReceipts: [...state.loadedSkillReceipts, receipt] };
};

/** Retain or clear authoritative pending-analysis facts after one file operation. */
export const recordFileAnalysis = (
  state: ManagedCapabilityTurnState,
  analysis: ManagedPendingFileAnalysis,
  pending: boolean,
): ManagedCapabilityTurnState => ({
  ...state,
  pendingFileAnalyses: pending
    ? [
        ...state.pendingFileAnalyses.filter(({ analysisId }) => analysisId !== analysis.analysisId),
        analysis,
      ].slice(-20)
    : state.pendingFileAnalyses.filter(({ analysisId }) => analysisId !== analysis.analysisId),
});

/** Stamp state on the durable User message for the exact active Submission. */
export const stampActiveUserMessage = (
  messages: ReadonlyArray<UIMessage>,
  metadata: ManagedTurnMetadata,
): UIMessage | null => {
  const active = messages.find(
    (message) => managedTurn(message)?.submissionId === metadata.submissionId,
  );
  if (active === undefined) return null;
  const retainedMetadata = Option.getOrElse(
    Schema.decodeUnknownOption(Schema.JsonObject)(active.metadata),
    () => ({}),
  );
  return {
    ...active,
    metadata: {
      ...retainedMetadata,
      turnMetadata: metadata,
    },
  };
};

const previousManagedTurn = (
  messages: ReadonlyArray<UIMessage>,
  activeSubmissionId: string,
): ManagedTurnMetadata | undefined => {
  const activeIndex = messages.findIndex(
    (message) => managedTurn(message)?.submissionId === activeSubmissionId,
  );
  if (activeIndex < 0) return undefined;
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const turn = managedTurn(messages[index]);
    if (turn !== undefined) return turn;
  }
  return undefined;
};

/** Decode only server-owned managed-turn metadata from one persisted User message. */
export const readManagedTurn = (
  message: UIMessage | undefined,
): ManagedTurnMetadata | undefined => {
  if (message?.role !== "user") return undefined;
  return Option.getOrUndefined(
    Option.map(
      Schema.decodeUnknownOption(TurnMetadataEnvelope)(message.metadata),
      ({ turnMetadata }) => turnMetadata,
    ),
  );
};

const managedTurn = readManagedTurn;

export * as ManagedCapabilityState from "./managed-capability-turn-state";
