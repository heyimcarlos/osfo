/** One registered live or provider-recovery evaluation copy. */
export type EvaluationCopy =
  | { readonly copyId: string; readonly location: "live" }
  | {
      readonly copyId: string;
      readonly location: "provider-recovery";
      readonly recoveryExpiresAt: string;
    };

/** Product-owned complete registry of evaluation copies for one source. */
export type EvaluationCopyRegistry = {
  readonly copies: ReadonlyArray<EvaluationCopy>;
  readonly sourceId: string;
};

/** Parsed registry construction outcome. */
export type EvaluationCopyRegistryResult =
  | { readonly kind: "success"; readonly value: EvaluationCopyRegistry }
  | { readonly error: { readonly _tag: "InvalidEvaluationCopyRegistry" }; readonly kind: "error" };

/** Create the complete immutable registry when evaluation copies are created. */
export const createEvaluationCopyRegistry = (
  sourceId: string,
  copies: ReadonlyArray<EvaluationCopy>,
): EvaluationCopyRegistryResult => {
  const copyIds = copies.map((copy) => copy.copyId);
  const invalid =
    sourceId.length === 0 ||
    copies.length === 0 ||
    copyIds.some((copyId) => copyId.length === 0) ||
    new Set(copyIds).size !== copyIds.length ||
    copies.some(
      (copy) =>
        copy.location === "provider-recovery" &&
        !Number.isFinite(Date.parse(copy.recoveryExpiresAt)),
    );
  return invalid
    ? { error: { _tag: "InvalidEvaluationCopyRegistry" }, kind: "error" }
    : {
        kind: "success",
        value: Object.freeze({
          copies: Object.freeze(copies.map((copy) => Object.freeze({ ...copy }))),
          sourceId,
        }),
      };
};

/** One immediate deletion request propagated to an evaluation copy. */
export type EvaluationCopyDeletion = {
  readonly copyId: string;
  readonly requestedAt: string;
  readonly sourceId: string;
};

/** Provider-recovery expiry kept separate from live deletion completion. */
export type ProviderRecoveryExpiry = {
  readonly copyId: string;
  readonly recoveryExpiresAt: string;
  readonly sourceId: string;
};

/** Separate live deletion and provider-recovery results for one source lineage. */
export type SourceDeletionPlan = {
  readonly liveDeletions: ReadonlyArray<EvaluationCopyDeletion>;
  readonly providerRecoveryExpiries: ReadonlyArray<ProviderRecoveryExpiry>;
};

/** Start deletion from every registered evaluation copy when its source is deleted or redacted. */
export const propagateSourceDeletion = (
  registry: EvaluationCopyRegistry,
  requestedAt: string,
): SourceDeletionPlan => ({
  liveDeletions: registry.copies
    .filter((copy) => copy.location === "live")
    .map((copy) => ({ copyId: copy.copyId, requestedAt, sourceId: registry.sourceId })),
  providerRecoveryExpiries: registry.copies
    .filter((copy) => copy.location === "provider-recovery")
    .map((copy) => ({
      copyId: copy.copyId,
      recoveryExpiresAt: copy.recoveryExpiresAt,
      sourceId: registry.sourceId,
    })),
});
