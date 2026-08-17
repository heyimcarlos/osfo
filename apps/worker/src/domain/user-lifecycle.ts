import { Schema } from "effect";

import { UserId } from "../domain";

const NonEmptyText = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "must not be empty"),
);

/** Stable identity for a trusted v1 administrator. */
export const AdminActorId = NonEmptyText.pipe(Schema.brand("AdminActorId"));

/** Stable identity for a trusted v1 administrator. */
export type AdminActorId = typeof AdminActorId.Type;

/** Stable identity for one Better Auth session. */
export const AuthSessionId = NonEmptyText.pipe(Schema.brand("AuthSessionId"));

/** Stable identity for one Better Auth session. */
export type AuthSessionId = typeof AuthSessionId.Type;

/** Stable identity for one User suspension history event. */
export const UserSuspensionEventId = NonEmptyText.pipe(Schema.brand("UserSuspensionEventId"));

/** Stable identity for one User suspension history event. */
export type UserSuspensionEventId = typeof UserSuspensionEventId.Type;

/** Stable identity for one User deletion process. */
export const DeletionCaseId = NonEmptyText.pipe(Schema.brand("DeletionCaseId"));

/** Stable identity for one User deletion process. */
export type DeletionCaseId = typeof DeletionCaseId.Type;

/** One verified E.164 Phone Account identifier. */
export const PhoneNumber = Schema.String.check(
  Schema.makeFilter((value) => /^\+[1-9]\d{7,14}$/u.test(value) || "must be an E.164 phone number"),
).pipe(Schema.brand("PhoneNumber"));

/** One verified E.164 Phone Account identifier. */
export type PhoneNumber = typeof PhoneNumber.Type;

/** Non-empty administrative reason retained with a lifecycle change. */
export const LifecycleReason = NonEmptyText.pipe(Schema.brand("LifecycleReason"));

/** Non-empty administrative reason retained with a lifecycle change. */
export type LifecycleReason = typeof LifecycleReason.Type;

/** Current User suspension fact consumed by Authorization. */
export const UserAccessFact = Schema.Union([
  Schema.TaggedStruct("ActiveUser", { userId: UserId }),
  Schema.TaggedStruct("SuspendedUser", { userId: UserId }),
]);

/** Current User suspension fact consumed by Authorization. */
export type UserAccessFact = typeof UserAccessFact.Type;

/** Current deletion-access fact consumed by Authorization. */
export const DeletionAccessFact = Schema.Union([
  Schema.TaggedStruct("DeletionAccessAvailable", {}),
  Schema.TaggedStruct("DeletionAccessRevoked", {}),
]);

/** Current deletion-access fact consumed by Authorization. */
export type DeletionAccessFact = typeof DeletionAccessFact.Type;

/** Current Better Auth session fact consumed by Authorization. */
export const AuthSessionAuthorityFact = Schema.Union([
  Schema.TaggedStruct("AuthSession", {
    authSessionId: AuthSessionId,
    expiresAt: Schema.Date,
    userId: UserId,
  }),
  Schema.TaggedStruct("RevokedAuthSession", {
    authSessionId: AuthSessionId,
    userId: UserId,
  }),
]);

/** Current Better Auth session fact consumed by Authorization. */
export type AuthSessionAuthorityFact = typeof AuthSessionAuthorityFact.Type;

/** Current lifecycle facts owned by the User lifecycle module. */
export const UserLifecycleFacts = Schema.Struct({
  deletionAccess: DeletionAccessFact,
  user: UserAccessFact,
});

/** Current lifecycle facts owned by the User lifecycle module. */
export type UserLifecycleFacts = typeof UserLifecycleFacts.Type;

/** A request must stop and continue through trusted manual support. */
export const ManualSupportRequired = Schema.TaggedStruct("ManualSupportRequired", {
  message: Schema.String,
});

/** A request must stop and continue through trusted manual support. */
export type ManualSupportRequired = typeof ManualSupportRequired.Type;
