import { DrizzleQueryError } from "drizzle-orm/errors";
import { Result, Schema } from "effect";

const PostgresFailureIdentity = Schema.Struct({
  code: Schema.String,
  constraint_name: Schema.String,
});

/** Identify the Better Auth phone-number uniqueness conflict. */
export const isPhoneNumberUniqueViolation = (cause: unknown): boolean => {
  const databaseCause = cause instanceof DrizzleQueryError ? cause.cause : cause;
  const parsed = Schema.decodeUnknownResult(PostgresFailureIdentity)(databaseCause);
  return (
    Result.isSuccess(parsed) &&
    parsed.success.code === "23505" &&
    parsed.success.constraint_name === "users_phone_number_unique"
  );
};
