import { AccountDeletionRequest } from "@osfo/api";
import { Data, Effect, Option, Schema } from "effect";

const storageKey = "osfo-account-deletion-replay";

const StoredAccountDeletionReplay = Schema.Struct({
  request: AccountDeletionRequest,
  version: Schema.Literal(2),
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

export interface PreparedAccountDeletionSubmission<A, E, R> {
  readonly effect: Effect.Effect<A, E, R>;
  readonly replayAvailable: boolean;
}

type AccountDeletionReplayStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type BrowserAccountDeletionReplayStorage =
  | { readonly status: "available"; readonly storage: AccountDeletionReplayStorage }
  | { readonly status: "unavailable" };

export interface BrowserAccountDeletionReplayCapture {
  readonly access: BrowserAccountDeletionReplayStorage;
  readonly replay: AccountDeletionReplay;
}

/** Acquire browser replay storage once without trusting that its global getter is readable. */
export const accessBrowserAccountDeletionReplayStorage = (): BrowserAccountDeletionReplayStorage =>
  Effect.runSync(
    Effect.try({
      try: () => globalThis.localStorage,
      catch: () => new AccountDeletionReplayStorageUnavailable(),
    }).pipe(
      Effect.map((storage) => ({ status: "available" as const, storage })),
      Effect.catchTag("AccountDeletionReplayStorageUnavailable", () =>
        Effect.succeed({ status: "unavailable" } as const),
      ),
    ),
  );

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
        // The browser can prove only the supported immutable presentation shape. The opaque
        // Action identity and replay bearer remain untrusted until the Worker matches them to
        // the exact consumed Action and fenced Deletion Case.
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
export const loadBrowserAccountDeletionReplay = (
  access = accessBrowserAccountDeletionReplayStorage(),
): AccountDeletionReplay =>
  access.status === "available"
    ? loadAccountDeletionReplay(access.storage)
    : { status: "unavailable" };

/** Capture the storage boundary and retained request once for one application lifetime. */
export const captureBrowserAccountDeletionReplay = (): BrowserAccountDeletionReplayCapture => {
  const access = accessBrowserAccountDeletionReplayStorage();
  return { access, replay: loadBrowserAccountDeletionReplay(access) };
};

/** Clear the captured browser replay storage without reading its global getter again. */
export const clearBrowserAccountDeletionReplay = (
  access: BrowserAccountDeletionReplayStorage,
): "cleared" | "unavailable" =>
  access.status === "available" ? clearAccountDeletionReplay(access.storage) : "unavailable";

/** Persist the immutable exact request before its first destructive HTTP attempt. */
export const saveAccountDeletionReplay = (
  storage: Pick<Storage, "setItem">,
  request: AccountDeletionReplayRequest,
): "saved" | "unavailable" =>
  Effect.runSync(
    Effect.try({
      try: () => storage.setItem(storageKey, encodeStoredReplay({ request, version: 2 })),
      catch: () => new AccountDeletionReplayStorageUnavailable(),
    }).pipe(
      Effect.as("saved" as const),
      Effect.catchTag("AccountDeletionReplayStorageUnavailable", () =>
        Effect.succeed("unavailable" as const),
      ),
    ),
  );

/** Remove a retained request only after success or an explicit User clear action. */
export const clearAccountDeletionReplay = (
  storage: Pick<Storage, "removeItem">,
): "cleared" | "unavailable" =>
  Effect.runSync(
    Effect.try({
      try: () => storage.removeItem(storageKey),
      catch: () => new AccountDeletionReplayStorageUnavailable(),
    }).pipe(
      Effect.as("cleared" as const),
      Effect.catchTag("AccountDeletionReplayStorageUnavailable", () =>
        Effect.succeed("unavailable" as const),
      ),
    ),
  );

/** Prepare one primary deletion submission with optional browser replay retention. */
export const prepareAccountDeletionSubmission = <A, E, R>(
  storage: Pick<Storage, "removeItem" | "setItem">,
  request: AccountDeletionReplayRequest,
  submit: (request: AccountDeletionReplayRequest) => Effect.Effect<A, E, R>,
  onSuccess: () => void,
): PreparedAccountDeletionSubmission<A, E, R> => ({
  effect: Effect.suspend(() => submit(request)).pipe(
    Effect.tap(() => Effect.sync(() => clearAccountDeletionReplay(storage))),
    Effect.tap(() => Effect.sync(onSuccess)),
  ),
  replayAvailable: saveAccountDeletionReplay(storage, request) === "saved",
});

/** Prepare primary deletion from one captured browser-storage lookup. */
export const prepareBrowserAccountDeletionSubmission = <A, E, R>(
  access: BrowserAccountDeletionReplayStorage,
  request: AccountDeletionReplayRequest,
  submit: (request: AccountDeletionReplayRequest) => Effect.Effect<A, E, R>,
  onSuccess: () => void,
): PreparedAccountDeletionSubmission<A, E, R> =>
  access.status === "available"
    ? prepareAccountDeletionSubmission(access.storage, request, submit, onSuccess)
    : {
        effect: Effect.suspend(() => submit(request)).pipe(
          Effect.tap(() => Effect.sync(onSuccess)),
        ),
        replayAvailable: false,
      };

class AccountDeletionReplayStorageUnavailable extends Data.TaggedError(
  "AccountDeletionReplayStorageUnavailable",
) {}
