import { expect, it } from "vitest";

/* oxlint-disable effecttsgo/async-function -- The helper exercises Cloudflare's Promise-only WorkflowStep boundary. */

import { settleDeadlineOutcome } from "./research-report-timer-outcome";

it("retries deadline cleanup before the immediate exactly-once terminal follow-up", async () => {
  const calls: Array<string> = [];
  let cleanupFailures = 1;
  let followUps = 0;
  const deadline = {
    _tag: "Canceled" as const,
    report: { state: "canceled" as const },
  };
  const discard = async () => {
    calls.push("cleanup");
    if (cleanupFailures > 0) {
      cleanupFailures -= 1;
      throw new Error("cleanup unavailable");
    }
  };
  const claimTerminal = async () => {
    calls.push("followUp");
    followUps += 1;
    return "claimed" as const;
  };

  await expect(settleDeadlineOutcome(deadline, discard, claimTerminal)).rejects.toThrow(
    "cleanup unavailable",
  );
  expect(followUps).toBe(0);
  await expect(settleDeadlineOutcome(deadline, discard, claimTerminal)).resolves.toBe("claimed");
  expect(calls).toEqual(["cleanup", "cleanup", "followUp"]);
  expect(followUps).toBe(1);
});

it("cleans an existing canceled terminal replay before claiming its follow-up", async () => {
  const calls: Array<string> = [];
  let cleanupFailures = 1;
  let followUps = 0;
  const deadline = {
    _tag: "Terminal" as const,
    report: { state: "canceled" as const },
  };
  const discard = async () => {
    calls.push("cleanup");
    if (cleanupFailures > 0) {
      cleanupFailures -= 1;
      throw new Error("cleanup unavailable");
    }
  };
  const claimTerminal = async () => {
    calls.push("followUp");
    followUps += 1;
    return "claimed" as const;
  };

  await expect(settleDeadlineOutcome(deadline, discard, claimTerminal)).rejects.toThrow(
    "cleanup unavailable",
  );
  expect(followUps).toBe(0);
  await expect(settleDeadlineOutcome(deadline, discard, claimTerminal)).resolves.toBe("claimed");
  expect(calls).toEqual(["cleanup", "cleanup", "followUp"]);
  expect(followUps).toBe(1);
});
