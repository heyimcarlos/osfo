import { describe, expect, it } from "@effect/vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";

import { isPhoneNumberUniqueViolation } from "../src/postgres-failure";

describe("Phone Account PostgreSQL failures", () => {
  it("accepts only code 23505 for the Better Auth phone uniqueness constraint", () => {
    const collision = postgresFailure("23505", "users_phone_number_unique");
    const wrappedCollision = new DrizzleQueryError("update users", [], collision);
    const otherUniqueConstraint = postgresFailure("23505", "users_email_unique");
    const otherPostgresFailure = postgresFailure("23503", "users_phone_number_unique");
    const humanReadableImpostor = new Error(
      'duplicate key violates constraint "users_phone_number_unique"',
    );

    expect(isPhoneNumberUniqueViolation(collision)).toBe(true);
    expect(isPhoneNumberUniqueViolation(wrappedCollision)).toBe(true);
    expect(isPhoneNumberUniqueViolation(otherUniqueConstraint)).toBe(false);
    expect(isPhoneNumberUniqueViolation(otherPostgresFailure)).toBe(false);
    expect(isPhoneNumberUniqueViolation(humanReadableImpostor)).toBe(false);
    expect(isPhoneNumberUniqueViolation(null)).toBe(false);
  });
});

const postgresFailure = (code: string, constraintName: string) =>
  Object.assign(new Error("opaque PostgreSQL failure"), {
    code,
    constraint_name: constraintName,
  });
