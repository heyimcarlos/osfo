/** Test whether a value is a non-negative integer evidence count. */
export const isEvidenceCount = (value: number): boolean => Number.isInteger(value) && value >= 0;

/** Test whether two values form a valid subset and total evidence count. */
export const isEvidenceSubset = (subset: number, total: number): boolean =>
  isEvidenceCount(subset) && isEvidenceCount(total) && subset <= total;
