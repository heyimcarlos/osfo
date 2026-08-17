import { Schema } from "effect";

import { UserId } from "../domain";

/** Stable identity for one User Suspension history event. */
export const UserSuspensionEventId = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "must not be empty"),
).pipe(Schema.brand("UserSuspensionEventId"));

/** Stable identity for one User Suspension history event. */
export type UserSuspensionEventId = typeof UserSuspensionEventId.Type;

/** Current User Suspension fact consumed by Authorization. */
export const UserAccessFact = Schema.Union([
  Schema.TaggedStruct("ActiveUser", { userId: UserId }),
  Schema.TaggedStruct("SuspendedUser", { userId: UserId }),
]);

/** Current User Suspension fact consumed by Authorization. */
export type UserAccessFact = typeof UserAccessFact.Type;
