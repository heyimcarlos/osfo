import { Schema } from "effect";

const NonEmptyText = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "must not be empty"),
);

/** Stable identity for a trusted v1 administrator. */
export const AdminActorId = NonEmptyText.pipe(Schema.brand("AdminActorId"));

/** Stable identity for a trusted v1 administrator. */
export type AdminActorId = typeof AdminActorId.Type;

/** Non-empty administrative reason retained with an authority change. */
export const AdminReason = NonEmptyText.pipe(Schema.brand("AdminReason"));

/** Non-empty administrative reason retained with an authority change. */
export type AdminReason = typeof AdminReason.Type;

/** A request must stop and continue through trusted manual support. */
export const ManualSupportRequired = Schema.TaggedStruct("ManualSupportRequired", {
  message: Schema.String,
});

/** A request must stop and continue through trusted manual support. */
export type ManualSupportRequired = typeof ManualSupportRequired.Type;
