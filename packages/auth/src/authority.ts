import type { Database } from "@osfo/db";
import { sessions, users } from "@osfo/db/schema/auth";
import { and, eq, ne } from "drizzle-orm";

import { isPhoneNumberUniqueViolation } from "./postgres-failure";

/* oxlint-disable effecttsgo/async-function -- This package exposes Better Auth-owned Promise capabilities to request adapters. */

/** Stored AuthSession fact returned through the Better Auth ownership seam. */
export interface AuthSessionRecord {
  readonly expiresAt: Date;
  readonly userId: string;
}

/** Result of revoking one User-owned AuthSession. */
export type RevokeAuthSessionResult = "absent" | "revoked" | "wrong-user";

/** Request-scoped owner of Better Auth AuthSession reads and mutations. */
export interface AuthSessionAuthority {
  readonly inspect: (userId: string, authSessionId: string) => Promise<AuthSessionRecord | null>;
  readonly revoke: (userId: string, authSessionId: string) => Promise<RevokeAuthSessionResult>;
  readonly revokeAll: (userId: string) => Promise<void>;
}

/** Current Phone Account facts needed for support-approved replacement. */
export type PhoneAccountRecord =
  | { readonly _tag: "MissingUser" }
  | { readonly _tag: "UnverifiedPhoneAccount" }
  | {
      readonly _tag: "VerifiedPhoneAccount";
      readonly currentPhoneNumber: string;
      readonly hasCollision: boolean;
    };

/** Result of atomically replacing a Phone Account and revoking its AuthSessions. */
export type ReplacePhoneAccountResult =
  | "deletion-requested"
  | "phone-collision"
  | "phone-unverified"
  | "replaced"
  | "unchanged"
  | "user-missing";

/** Request-scoped owner of Better Auth Phone Account reads and mutations. */
export interface PhoneAccountAuthority {
  readonly inspectReplacement: (userId: string, phoneNumber: string) => Promise<PhoneAccountRecord>;
  readonly replaceAndRevokeSessions: (
    userId: string,
    phoneNumber: string,
  ) => Promise<ReplacePhoneAccountResult>;
}

/** Application-owned fence checked inside the Better Auth Phone Account transaction. */
export interface PhoneAccountAuthorityOptions {
  readonly replacementBlocked: (
    transaction: Pick<Database, "select">,
    userId: string,
  ) => Promise<boolean>;
}

/** Construct the request-scoped Better Auth AuthSession authority. */
export const createAuthSessionAuthority = (database: Database): AuthSessionAuthority => ({
  inspect: async (userId, authSessionId) => {
    const [record] = await database
      .select({ expiresAt: sessions.expiresAt, userId: sessions.userId })
      .from(sessions)
      .where(and(eq(sessions.id, authSessionId), eq(sessions.userId, userId)))
      .limit(1);
    return record ?? null;
  },
  revoke: (userId, authSessionId) =>
    database.transaction(async (transaction) => {
      const [session] = await transaction
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.id, authSessionId))
        .for("update")
        .limit(1);
      if (session === undefined) return "absent";
      if (session.userId !== userId) return "wrong-user";
      await transaction.delete(sessions).where(eq(sessions.id, authSessionId));
      return "revoked";
    }),
  revokeAll: async (userId) => {
    await database.delete(sessions).where(eq(sessions.userId, userId));
  },
});

/** Construct the request-scoped Better Auth Phone Account authority. */
export const createPhoneAccountAuthority = (
  database: Database,
  options: PhoneAccountAuthorityOptions,
): PhoneAccountAuthority => ({
  inspectReplacement: async (userId, phoneNumber) => {
    const [[user], [collision]] = await Promise.all([
      database
        .select({ phoneNumber: users.phoneNumber, phoneNumberVerified: users.phoneNumberVerified })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
      database
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.phoneNumber, phoneNumber), ne(users.id, userId)))
        .limit(1),
    ]);
    if (user === undefined) return { _tag: "MissingUser" };
    if (user.phoneNumber === null || user.phoneNumberVerified !== true) {
      return { _tag: "UnverifiedPhoneAccount" };
    }
    return {
      _tag: "VerifiedPhoneAccount",
      currentPhoneNumber: user.phoneNumber,
      hasCollision: collision !== undefined,
    };
  },
  replaceAndRevokeSessions: async (userId, phoneNumber) => {
    try {
      return await database.transaction(async (transaction) => {
        const [user] = await transaction
          .select({
            phoneNumber: users.phoneNumber,
            phoneNumberVerified: users.phoneNumberVerified,
          })
          .from(users)
          .where(eq(users.id, userId))
          .for("update")
          .limit(1);
        if (user === undefined) return "user-missing";
        if (user.phoneNumber === null || user.phoneNumberVerified !== true) {
          return "phone-unverified";
        }
        const [collision] = await transaction
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.phoneNumber, phoneNumber), ne(users.id, userId)))
          .limit(1);
        if (collision !== undefined) return "phone-collision";
        if (await options.replacementBlocked(transaction, userId)) return "deletion-requested";
        if (user.phoneNumber === phoneNumber) return "unchanged";
        await transaction
          .update(users)
          .set({ phoneNumber, phoneNumberVerified: true })
          .where(eq(users.id, userId));
        await transaction.delete(sessions).where(eq(sessions.userId, userId));
        return "replaced";
      });
    } catch (cause) {
      if (isPhoneNumberUniqueViolation(cause)) return "phone-collision";
      throw cause;
    }
  },
});
