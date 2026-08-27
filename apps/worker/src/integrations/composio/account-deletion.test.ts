/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Promise fakes model the Composio API boundary; assertions run inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../../domain";
import { makeFromClient } from "./account-deletion";

it.effect("discovers, revokes upstream, and confirms every User-owned Google authority", () => {
  const userId = UserId.make("user-1");
  const remaining = ["gmail-1", "calendar-1", "drive-1"];
  const listed: Array<{
    connected_account_ids?: Array<string>;
    cursor?: string;
    limit: number;
    toolkit_slugs: Array<string>;
    user_ids: Array<string>;
  }> = [];
  const deleted: Array<{ id: string; revoke: boolean }> = [];
  const adapter = makeFromClient({
    delete: async (id, options) => {
      deleted.push({ id, revoke: options.revoke_on_delete });
      remaining.splice(remaining.indexOf(id), 1);
      return { revoke_job_id: `job-${id}`, success: true };
    },
    list: async (options) => {
      listed.push(options);
      return {
        items: remaining
          .filter((id) =>
            options.connected_account_ids === undefined
              ? true
              : options.connected_account_ids.includes(id),
          )
          .map((id) => ({ id })),
        next_cursor: null,
      };
    },
  });

  return Effect.gen(function* () {
    const targets = yield* adapter.pending(userId);
    expect(targets.map(({ connectionId }) => connectionId)).toEqual([
      "gmail-1",
      "calendar-1",
      "drive-1",
    ]);
    for (const target of targets) yield* adapter.revoke(target);
    expect(yield* adapter.pending(userId)).toEqual([]);
    expect(deleted).toEqual([
      { id: "gmail-1", revoke: true },
      { id: "calendar-1", revoke: true },
      { id: "drive-1", revoke: true },
    ]);
    expect(listed[0]).toEqual({
      limit: 100,
      toolkit_slugs: ["gmail", "googlecalendar", "googledrive"],
      user_ids: ["user-1"],
    });
  });
});
