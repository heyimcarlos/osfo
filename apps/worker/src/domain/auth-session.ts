import { Schema } from "effect";

import { UserId } from "../domain";

/** Stable identity for one Better Auth session. */
export const AuthSessionId = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "must not be empty"),
).pipe(Schema.brand("AuthSessionId"));

/** Stable identity for one Better Auth session. */
export type AuthSessionId = typeof AuthSessionId.Type;

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
