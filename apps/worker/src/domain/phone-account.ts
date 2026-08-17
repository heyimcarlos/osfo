import { Schema } from "effect";

/** One verified E.164 Phone Account identifier. */
export const PhoneNumber = Schema.String.check(
  Schema.makeFilter((value) => /^\+[1-9]\d{7,14}$/u.test(value) || "must be an E.164 phone number"),
).pipe(Schema.brand("PhoneNumber"));

/** One verified E.164 Phone Account identifier. */
export type PhoneNumber = typeof PhoneNumber.Type;
