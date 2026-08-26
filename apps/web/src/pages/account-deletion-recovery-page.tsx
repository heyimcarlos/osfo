import { Link } from "@tanstack/react-router";
import { Effect } from "effect";
import { useState } from "react";

import { requestAccountDeletion } from "../lib/api-client";
import {
  clearAccountDeletionReplay,
  loadBrowserAccountDeletionReplay,
  type AccountDeletionReplay,
} from "../lib/account-deletion-replay";

/** Public, deletion-only recovery for one exact retained request after normal access is fenced. */
export function AccountDeletionRecoveryPage() {
  const [replay, setReplay] = useState(loadBrowserAccountDeletionReplay);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const clear = () => {
    if (clearAccountDeletionReplay(globalThis.localStorage) === "cleared") {
      setReplay({ status: "missing" });
      setFailed(false);
      return;
    }
    setReplay({ status: "unavailable" });
  };
  const retry = (available: Extract<AccountDeletionReplay, { readonly status: "available" }>) => {
    setBusy(true);
    setFailed(false);
    void Effect.runPromise(requestAccountDeletion(available.request))
      .then(() => {
        clearAccountDeletionReplay(globalThis.localStorage);
        globalThis.location.assign("/");
      })
      .catch(() => {
        setBusy(false);
        setFailed(true);
      });
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-5 py-10">
      <section className="w-full rounded-3xl border border-white/80 bg-white/80 p-6 shadow-sm">
        <p className="text-sm font-semibold text-[#c83242]">Account Deletion</p>
        <h1 className="mt-1 text-2xl font-bold">Account Deletion Recovery</h1>
        {replay.status === "available" ? (
          <div className="mt-5">
            <p className="font-semibold text-[#7f2630]">
              {replay.request.approval.presentation.title}
            </p>
            <p className="mt-1 text-sm text-[#7f2630]">
              {replay.request.approval.presentation.consequence}
            </p>
            <p className="mt-3 text-sm text-[#687896]">
              Normal account access stays fenced. Retry only this exact saved request to recover a
              response that may have been lost.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className="min-h-11 rounded-full bg-[#d63243] px-4 text-sm font-semibold text-white disabled:opacity-60"
                disabled={busy}
                type="button"
                onClick={() => retry(replay)}
              >
                {busy ? "Retrying..." : "Retry Account Deletion"}
              </button>
              <button
                className="min-h-11 rounded-full px-4 text-sm font-semibold"
                disabled={busy}
                type="button"
                onClick={clear}
              >
                Clear saved request
              </button>
            </div>
            {failed ? (
              <p className="mt-3" role="alert">
                The saved request could not be resumed. It may be stale or no longer exact.
              </p>
            ) : null}
          </div>
        ) : (
          <RecoveryUnavailable replay={replay} onClear={clear} />
        )}
      </section>
    </main>
  );
}

function RecoveryUnavailable({
  onClear,
  replay,
}: {
  readonly onClear: () => void;
  readonly replay: Exclude<AccountDeletionReplay, { readonly status: "available" }>;
}) {
  if (replay.status === "invalid") {
    return (
      <div className="mt-5">
        <p role="alert">The saved deletion request is altered or invalid and cannot be sent.</p>
        <button
          className="mt-4 min-h-11 rounded-full px-4 font-semibold"
          type="button"
          onClick={onClear}
        >
          Clear saved request
        </button>
      </div>
    );
  }
  if (replay.status === "unavailable") {
    return (
      <p className="mt-5" role="alert">
        Browser storage is unavailable. No request was sent.
      </p>
    );
  }
  return (
    <div className="mt-5">
      <p>There is no saved account deletion request to resume.</p>
      <Link className="mt-4 inline-block font-semibold text-[#2f7df4]" to="/">
        Return home
      </Link>
    </div>
  );
}
