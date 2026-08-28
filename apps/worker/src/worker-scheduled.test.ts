/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise, vitest/no-standalone-expect -- Deferred Promises model the Cloudflare scheduled lifecycle boundary. */
import { expect, it } from "@effect/vitest";

import {
  hourlyMaintenanceCron,
  scheduledEmailReconciliationCron,
  scheduledRunKind,
  settleScheduledBranches,
} from "./scheduled-lifecycle";

it("routes minute Scheduled Email recovery separately from hourly maintenance", () => {
  expect(scheduledRunKind(scheduledEmailReconciliationCron)).toBe("scheduledEmailReconciliation");
  expect(scheduledRunKind(hourlyMaintenanceCron)).toBe("hourlyMaintenance");
  expect(scheduledRunKind("17 4 * * *")).toBe("unknown");
});

it("awaits every scheduled branch before surfacing a safe aggregate failure", async () => {
  let finishLate: (() => void) | undefined;
  const late = new Promise<void>((resolve) => {
    finishLate = resolve;
  });
  const attempted = new Array<string>();
  let settled = false;
  const lifecycle = settleScheduledBranches([
    () => {
      attempted.push("early-failure");
      return Promise.reject(new Error("private early failure"));
    },
    () => {
      attempted.push("late-success");
      return late;
    },
  ]).finally(() => {
    settled = true;
  });

  await Promise.resolve();
  await Promise.resolve();
  expect(attempted).toEqual(["early-failure", "late-success"]);
  expect(settled).toBe(false);

  finishLate?.();
  await expect(lifecycle).rejects.toThrow("Scheduled maintenance failed in 1 branch(es)");
  expect(settled).toBe(true);
});
