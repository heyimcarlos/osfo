/** Immutable artifact layout shared by cohort creation and teardown authorities. */
export const qualificationCohortProvisionArtifactPageSize = 50;
export const qualificationCohortRootArtifactRecordCount = 2;

export const qualificationCohortRootArtifactKeys = (executionId: string) => {
  const prefix = `qualification/executions/${encodeURIComponent(executionId)}/cohort`;
  return [`${prefix}/inventory-receipt.json`, `${prefix}/manifest.json`];
};

export const qualificationCohortArtifactLayoutRecordCount = (input: {
  readonly finalizePageCount: number;
  readonly participantCount: number;
}) => {
  if (
    !Number.isSafeInteger(input.finalizePageCount) ||
    input.finalizePageCount <= 0 ||
    !Number.isSafeInteger(input.participantCount) ||
    input.participantCount <= 0
  ) {
    return null;
  }
  const provisionPageCount = Math.ceil(
    input.participantCount / qualificationCohortProvisionArtifactPageSize,
  );
  const count =
    qualificationCohortRootArtifactRecordCount +
    input.participantCount +
    input.finalizePageCount +
    provisionPageCount;
  return Number.isSafeInteger(count) && count > qualificationCohortRootArtifactRecordCount
    ? count
    : null;
};
