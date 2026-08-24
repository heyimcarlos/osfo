import type { AllowancePeriodId } from "../domain";
import { policyFor, sharedUsagePolicyV1 } from "./plan-policy";

/** Start a new Free period without transferring Adventurer Usage or reassigning admitted work. */
export const startFreePeriodAfterDowngrade = (facts: {
  readonly admittedAllowancePeriodId: AllowancePeriodId;
  readonly newFreeAllowancePeriodId: AllowancePeriodId;
}) => ({
  admittedWorkAllowancePeriodId: facts.admittedAllowancePeriodId,
  includedPlanUsageMicros: policyFor(sharedUsagePolicyV1, "free").includedPlanUsageMicros,
  newPeriodAllowancePeriodId: facts.newFreeAllowancePeriodId,
  recordedPlanUsageMicros: 0n,
});

/** Select the oldest resources up to the Free limit unless the User chooses another valid set. */
export const selectActiveResources = (
  resources: ReadonlyArray<{ readonly createdAt: Date; readonly id: string }>,
  limit: number,
  selectedIds: ReadonlyArray<string> | null,
) => {
  const knownIds = new Set(resources.map(({ id }) => id));
  const selected =
    selectedIds !== null &&
    selectedIds.length <= limit &&
    new Set(selectedIds).size === selectedIds.length &&
    selectedIds.every((id) => knownIds.has(id))
      ? [...selectedIds]
      : resources
          .reduce<ReadonlyArray<{ readonly createdAt: Date; readonly id: string }>>(
            (ordered, resource) => {
              const index = ordered.findIndex(
                (candidate) => resource.createdAt < candidate.createdAt,
              );
              return index === -1
                ? ordered.concat(resource)
                : ordered.slice(0, index).concat(resource, ordered.slice(index));
            },
            [],
          )
          .slice(0, limit)
          .map(({ id }) => id);
  const active = new Set(selected);
  return {
    active: selected,
    paused: resources.map(({ id }) => id).filter((id) => !active.has(id)),
  };
};
