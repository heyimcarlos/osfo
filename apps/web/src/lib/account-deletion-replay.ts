import { AccountDeletionRequest } from "@osfo/api";
import { Data, Effect, Option, Schema } from "effect";

const storageKey = "osfo-account-deletion-replay";

const StoredAccountDeletionReplay = Schema.Struct({
  request: AccountDeletionRequest,
  version: Schema.Literal(1),
});
const encodeStoredReplay = Schema.encodeSync(Schema.fromJsonString(StoredAccountDeletionReplay));
const decodeStoredReplay = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredAccountDeletionReplay),
);

export type AccountDeletionReplayRequest = AccountDeletionRequest;

export type AccountDeletionReplay =
  | { readonly request: AccountDeletionReplayRequest; readonly status: "available" }
  | { readonly status: "invalid" }
  | { readonly status: "missing" }
  | { readonly status: "unavailable" };

/** Read one exact retained deletion request without repairing or accepting malformed data. */
export const loadAccountDeletionReplay = (
  storage: Pick<Storage, "getItem">,
): AccountDeletionReplay =>
  Effect.runSync(
    Effect.try({
      try: () => storage.getItem(storageKey),
      catch: () => new AccountDeletionReplayStorageUnavailable(),
    }).pipe(
      Effect.map((stored) => {
        if (stored === null) return { status: "missing" } as const;
        return Option.match(decodeStoredReplay(stored), {
          onNone: () => ({ status: "invalid" }) as const,
          onSome: ({ request }) => ({ request, status: "available" }) as const,
        });
      }),
      Effect.catchTag("AccountDeletionReplayStorageUnavailable", () =>
        Effect.succeed({ status: "unavailable" } as const),
      ),
    ),
  );

/** Read the retained request from the current browser without assuming storage is available. */
export const loadBrowserAccountDeletionReplay = (): AccountDeletionReplay =>
  Effect.runSync(
    Effect.try({
      try: () => loadAccountDeletionReplay(globalThis.localStorage),
      catch: () => new AccountDeletionReplayStorageUnavailable(),
    }).pipe(
      Effect.catchTag("AccountDeletionReplayStorageUnavailable", () =>
        Effect.succeed({ status: "unavailable" } as const),
      ),
    ),
  );

/** Persist the immutable exact request before its first destructive HTTP attempt. */
export const saveAccountDeletionReplay = (
  storage: Pick<Storage, "setItem">,
  request: AccountDeletionReplayRequest,
) =>
  Effect.runSync(
    Effect.try({
      try: () => storage.setItem(storageKey, encodeStoredReplay({ request, version: 1 })),
      catch: () => new AccountDeletionReplayStorageUnavailable(),
    }),
  );

/** Remove a retained request only after success or an explicit User clear action. */
export const clearAccountDeletionReplay = (storage: Pick<Storage, "removeItem">) =>
  Effect.runSync(
    Effect.try({
      try: () => storage.removeItem(storageKey),
      catch: () => new AccountDeletionReplayStorageUnavailable(),
    }),
  );

class AccountDeletionReplayStorageUnavailable extends Data.TaggedError(
  "AccountDeletionReplayStorageUnavailable",
) {}
