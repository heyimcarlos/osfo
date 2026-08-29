import { expect, it } from "@effect/vitest";

import {
  qualificationCorrectnessReducerMaximumSteps,
  qualificationCorrectnessReducerMaximumSubrequests,
  qualificationReducerRetrySubrequestAllowance,
  qualificationSortedReducerMaximumSubrequests,
  qualificationWorkflowSubrequestLimit,
} from "./qualification-evaluation-limits";
import { qualificationEvaluationMaximumDimensionWorkflowSteps } from "./qualification-evaluation-reducer";

it("keeps both Public reducers within the explicitly deployed Workflow limits", () => {
  expect(qualificationSortedReducerMaximumSubrequests).toBe(136_779);
  expect(qualificationCorrectnessReducerMaximumSubrequests).toBe(129_991);
  expect(qualificationReducerRetrySubrequestAllowance).toBe(113_221);
  expect(qualificationEvaluationMaximumDimensionWorkflowSteps).toBe(6_840);
  expect(qualificationCorrectnessReducerMaximumSteps).toBe(6_979);

  const maximumSubrequests = Math.max(
    qualificationSortedReducerMaximumSubrequests,
    qualificationCorrectnessReducerMaximumSubrequests,
  );
  expect(maximumSubrequests * 10).toBeLessThanOrEqual(qualificationWorkflowSubrequestLimit * 7);
  expect(qualificationCorrectnessReducerMaximumSteps).toBeLessThan(10_000);
});
