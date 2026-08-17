import { Schema } from "effect";

/** Stable identity for one User deletion process. */
export const DeletionCaseId = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "must not be empty"),
).pipe(Schema.brand("DeletionCaseId"));

/** Stable identity for one User deletion process. */
export type DeletionCaseId = typeof DeletionCaseId.Type;

/** Current deletion-access fact consumed by Authorization. */
export const DeletionAccessFact = Schema.Union([
  Schema.TaggedStruct("DeletionAccessAvailable", {}),
  Schema.TaggedStruct("DeletionAccessRevoked", {}),
]);

/** Current deletion-access fact consumed by Authorization. */
export type DeletionAccessFact = typeof DeletionAccessFact.Type;
