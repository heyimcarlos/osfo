import { currentCapabilityCatalog } from "./capability-catalog";

type Candidate = {
  readonly attempts: number;
  readonly candidateBytes: bigint;
  readonly createdAt: Date;
  readonly id: string;
};

type Proposal = {
  readonly evidence:
    | "confirmedEffect"
    | "explicitConfirmation"
    | "modelCompletion"
    | "silence"
    | "successfulReuse";
  readonly modelInputTokens: number;
  readonly modelOutputTokens: number;
  readonly skillBodyBytes: bigint;
  readonly skillVersionBytes: bigint;
  readonly skillsChanged: number;
};

type Load = {
  readonly concurrentJobsForUser: number;
  readonly concurrentJobsGlobally: number;
  readonly jobsInRollingDay: number;
  readonly retainedSkillHistoryBytes: bigint;
  readonly retainedSkills: number;
};

/** Replace a pending candidate only when newer evidence arrives. */
export const retainNewestCandidate = (current: Candidate | null, incoming: Candidate) =>
  current === null || incoming.createdAt > current.createdAt ? incoming : current;

/** Apply company-funded Skill Learning bounds without changing the original task. */
export const evaluateSkillLearning = (
  candidate: Candidate,
  proposal: Proposal,
  load: Load,
  now: Date,
) => {
  const limits = currentCapabilityCatalog.skillLearning;
  if (now.getTime() - candidate.createdAt.getTime() > limits.candidateLifetimeMilliseconds) {
    return { _tag: "Skipped" as const, reason: "expired" as const };
  }
  if (candidate.attempts > limits.retries) {
    return { _tag: "Skipped" as const, reason: "attemptsExhausted" as const };
  }
  if (
    load.jobsInRollingDay >= limits.jobsPerRollingDay ||
    load.concurrentJobsForUser >= limits.concurrentJobsPerUser ||
    load.concurrentJobsGlobally >= limits.concurrentJobsGlobally ||
    load.retainedSkills >= limits.retainedSkillsPerUser ||
    load.retainedSkillHistoryBytes >= limits.retainedSkillHistoryBytes
  ) {
    return { _tag: "Backpressured" as const };
  }
  const acceptedEvidence =
    proposal.evidence === "explicitConfirmation" ||
    proposal.evidence === "confirmedEffect" ||
    proposal.evidence === "successfulReuse";
  if (
    !acceptedEvidence ||
    candidate.candidateBytes > limits.candidateBytes ||
    proposal.modelInputTokens > limits.modelInputTokens ||
    proposal.modelOutputTokens > limits.modelOutputTokens ||
    proposal.skillBodyBytes > limits.skillBodyBytes ||
    proposal.skillVersionBytes > limits.skillVersionBytes ||
    proposal.skillsChanged > limits.skillsChangedPerJob
  ) {
    return { _tag: "Rejected" as const };
  }
  return { _tag: "Accepted" as const };
};
