import { describe, expect, it } from "@effect/vitest";

import { evaluateSkillLearning, retainNewestCandidate } from "./skill-learning";

/* oxlint-disable effecttsgo/global-date -- Fixed evidence times prove expiry. */

describe("Skill Learning policy", () => {
  it("keeps only the newest candidate and skips expired or repeatedly failed work", () => {
    const older = candidate("old", "2026-08-22T00:00:00.000Z");
    const newer = candidate("new", "2026-08-23T00:00:00.000Z");
    expect(retainNewestCandidate(older, newer)).toEqual(newer);
    expect(
      evaluateSkillLearning(
        { ...older, attempts: 0 },
        proposal(),
        load(),
        new Date("2026-08-24T00:00:00.001Z"),
      ),
    ).toMatchObject({ _tag: "Skipped", reason: "expired" });
    expect(
      evaluateSkillLearning(
        { ...newer, attempts: 2 },
        proposal(),
        load(),
        new Date("2026-08-23T01:00:00.000Z"),
      ),
    ).toMatchObject({ _tag: "Skipped", reason: "attemptsExhausted" });
  });

  it("accepts only schema-checked evidence and every bounded output", () => {
    expect(
      evaluateSkillLearning(
        candidate("candidate", "2026-08-23T00:00:00.000Z"),
        proposal(),
        load(),
        new Date("2026-08-23T01:00:00.000Z"),
      ),
    ).toEqual({ _tag: "Accepted" });
    for (const rejected of [
      { ...proposal(), evidence: "modelCompletion" as const },
      { ...proposal(), modelInputTokens: 16_001 },
      { ...proposal(), modelOutputTokens: 2_001 },
      { ...proposal(), skillBodyBytes: 8_193n },
      { ...proposal(), skillVersionBytes: 16_385n },
      { ...proposal(), skillsChanged: 2 },
    ]) {
      expect(
        evaluateSkillLearning(
          candidate("candidate", "2026-08-23T00:00:00.000Z"),
          rejected,
          load(),
          new Date("2026-08-23T01:00:00.000Z"),
        ),
      ).toMatchObject({ _tag: "Rejected" });
    }
  });

  it("enforces frequency, retention, and company concurrency backpressure", () => {
    const current = candidate("candidate", "2026-08-23T00:00:00.000Z");
    const now = new Date("2026-08-23T01:00:00.000Z");
    for (const overloaded of [
      { ...load(), jobsInRollingDay: 3 },
      { ...load(), concurrentJobsForUser: 1 },
      { ...load(), concurrentJobsGlobally: 10 },
      { ...load(), retainedSkills: 100 },
      { ...load(), retainedSkillHistoryBytes: 5_000_000n },
    ]) {
      expect(evaluateSkillLearning(current, proposal(), overloaded, now)).toMatchObject({
        _tag: "Backpressured",
      });
    }
  });
});

const candidate = (id: string, createdAt: string) => ({
  attempts: 0,
  candidateBytes: 32_768n,
  createdAt: new Date(createdAt),
  id,
});

const proposal = () => ({
  evidence: "explicitConfirmation" as const,
  modelInputTokens: 16_000,
  modelOutputTokens: 2_000,
  skillBodyBytes: 8_192n,
  skillVersionBytes: 16_384n,
  skillsChanged: 1,
});

const load = () => ({
  concurrentJobsForUser: 0,
  concurrentJobsGlobally: 0,
  jobsInRollingDay: 0,
  retainedSkillHistoryBytes: 0n,
  retainedSkills: 0,
});
