/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Promise fakes model the Composio API boundary; assertions run inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { UserId } from "../../domain";
import { AccountDeletion } from "../../services/account-deletion";
import { makeFromClient } from "./account-deletion";

it.effect("revokes, removes, and confirms every private User-owned Google authority", () => {
  const userId = UserId.make("user-1");
  const unrelatedUserId = UserId.make("user-2");
  const owners = new Map([
    ["gmail-1", userId],
    ["calendar-1", userId],
    ["drive-1", userId],
    ["unrelated-gmail", unrelatedUserId],
  ]);
  const statuses = new Map([...owners].map(([id]) => [id, "ACTIVE"]));
  const listed: Array<{
    account_type: "PRIVATE";
    connected_account_ids?: Array<string>;
    cursor?: string;
    limit: number;
    toolkit_slugs: Array<string>;
    user_ids: Array<string>;
  }> = [];
  const revoked: Array<string> = [];
  const deleted: Array<string> = [];
  const adapter = makeFromClient({
    delete: async (id) => {
      deleted.push(id);
      if (statuses.get(id) !== "REVOKED") return { success: false };
      owners.delete(id);
      statuses.delete(id);
      return { success: true };
    },
    list: async (options) => {
      listed.push(options);
      return {
        items: [...owners]
          .filter(
            ([id, owner]) =>
              options.user_ids.includes(owner) &&
              (options.connected_account_ids === undefined ||
                options.connected_account_ids.includes(id)),
          )
          .map(([id]) => ({ id, status: statuses.get(id) ?? "ACTIVE" })),
        next_cursor: null,
      };
    },
    revoke: async (id) => {
      revoked.push(id);
      statuses.set(id, "REVOKED");
      return { id, status: "REVOKED" };
    },
  });

  return Effect.gen(function* () {
    const targets = yield* adapter.pending(userId);
    expect(targets.map(({ connectionId }) => connectionId)).toEqual([
      "gmail-1",
      "calendar-1",
      "drive-1",
    ]);
    for (const target of targets) {
      yield* adapter.revoke(target);
      yield* adapter.remove(target);
    }
    expect(yield* adapter.pending(userId)).toEqual([]);
    expect(yield* adapter.pending(unrelatedUserId)).toEqual([
      {
        connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("unrelated-gmail"),
        userId: unrelatedUserId,
      },
    ]);
    expect(revoked).toEqual(["gmail-1", "calendar-1", "drive-1"]);
    expect(deleted).toEqual(["gmail-1", "calendar-1", "drive-1"]);
    expect(listed[0]).toEqual({
      account_type: "PRIVATE",
      limit: 100,
      toolkit_slugs: ["gmail", "googlecalendar", "googledrive"],
      user_ids: ["user-1"],
    });
  });
});

it.effect("fails closed when a pending target disappears before synchronous revocation", () => {
  const userId = UserId.make("user-1");
  const target = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("missing-connection"),
    userId,
  };
  const adapter = makeFromClient({
    delete: async () => ({ success: true }),
    list: async () => ({ items: [], next_cursor: null }),
    revoke: async (id) => ({ id, status: "REVOKED" }),
  });

  return Effect.gen(function* () {
    const result = yield* adapter.revoke(target).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(AccountDeletion.AccountDeletionUnavailable);
    }
    yield* adapter.remove(target);
  });
});

it.effect("requires exact synchronous revoke identity and status", () => {
  const userId = UserId.make("user-1");
  const target = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
    userId,
  };
  const adapter = makeFromClient({
    delete: async () => ({ success: true }),
    list: async () => ({
      items: [{ id: target.connectionId, status: "ACTIVE" }],
      next_cursor: null,
    }),
    revoke: async () => ({ id: "different-connection", status: "REVOKED" }),
  });

  return Effect.gen(function* () {
    expect(Result.isFailure(yield* adapter.revoke(target).pipe(Effect.result))).toBe(true);
  });
});

it.effect("accepts provider-visible revocation when replay resumes before durable progress", () => {
  const userId = UserId.make("user-1");
  const target = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
    userId,
  };
  let revokeCalls = 0;
  const adapter = makeFromClient({
    delete: async () => ({ success: true }),
    list: async () => ({
      items: [{ id: target.connectionId, status: "REVOKED" }],
      next_cursor: null,
    }),
    revoke: async (id) => {
      revokeCalls += 1;
      return { id, status: "REVOKED" };
    },
  });

  return Effect.gen(function* () {
    yield* adapter.revoke(target);
    expect(revokeCalls).toBe(0);
  });
});

it.effect("maps malformed connected-account lists into typed unavailability", () => {
  const adapter = makeFromClient({
    delete: async () => ({ success: true }),
    list: async () => ({ items: null, next_cursor: null }),
    revoke: async (id) => ({ id, status: "REVOKED" }),
  });

  return Effect.gen(function* () {
    const result = yield* adapter.pending(UserId.make("user-1")).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "AccountDeletionUnavailable",
        operation: "discoverIntegrationAuthorities",
      });
    }
  });
});

it.effect("maps malformed delete confirmation into typed unavailability", () => {
  const userId = UserId.make("user-1");
  const target = {
    connectionId: AccountDeletion.IntegrationAuthorityTargetId.make("connection-1"),
    userId,
  };
  let listCalls = 0;
  const adapter = makeFromClient({
    delete: async () => ({ success: "yes" }),
    list: async () => {
      listCalls += 1;
      return listCalls === 1
        ? { items: [{ id: target.connectionId, status: "REVOKED" }], next_cursor: null }
        : { items: [], next_cursor: null };
    },
    revoke: async (id) => ({ id, status: "REVOKED" }),
  });

  return Effect.gen(function* () {
    const result = yield* adapter.remove(target).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: "AccountDeletionUnavailable",
        operation: "removeIntegrationAuthority",
      });
    }
  });
});
