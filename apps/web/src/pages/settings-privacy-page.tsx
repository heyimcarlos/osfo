import { Link } from "@tanstack/react-router";
/* oxlint-disable effecttsgo/global-date, effecttsgo/global-timers -- React owns the rendered expiry timer and its lifecycle; the Worker remains the action-time authority. */
import type { AccountDeletionAction } from "@osfo/api";
import { BriefcaseBusiness, Sparkles, Trash2, type LucideIcon } from "lucide-react";
import { Effect } from "effect";
import { useEffect, useState } from "react";

import { useAccountDeletionReplayState } from "../account-deletion-replay-state";
import {
  accountDeletionRequestFor,
  presentAccountDeletion,
  requestAccountDeletion,
} from "../lib/api-client";
import {
  accountDeletionFailureDisposition,
  prepareBrowserAccountDeletionSubmission,
} from "../lib/account-deletion-replay";

export interface SettingsPrivacyDependencies {
  readonly presentAccountDeletion: typeof presentAccountDeletion;
  readonly requestAccountDeletion: typeof requestAccountDeletion;
}

const defaultDependencies: SettingsPrivacyDependencies = {
  presentAccountDeletion,
  requestAccountDeletion,
};

/** Route-owned privacy controls and policy access. */
export function SettingsPrivacyPage({
  dependencies = defaultDependencies,
}: {
  readonly dependencies?: SettingsPrivacyDependencies;
} = {}) {
  return <SettingsPrivacyContent dependencies={dependencies} />;
}

function SettingsPrivacyContent({
  dependencies,
}: {
  readonly dependencies: SettingsPrivacyDependencies;
}) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="data-controls-title">
        <h2 className="mb-2 text-sm font-bold" id="data-controls-title">
          Data Controls
        </h2>
        <div className="grid gap-2">
          <Link
            className="flex min-h-16 items-center gap-3 rounded-2xl border border-white/80 bg-white/68 px-3 hover:bg-white/85 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none"
            to="/settings/skills"
          >
            <PrivacyIcon icon={Sparkles} />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Learned preferences</span>
              <span className="block text-xs text-[#687896]">Review and manage your Skills</span>
            </span>
            <span className="text-sm text-[#687896]">Open</span>
          </Link>
          <Link
            className="flex min-h-16 items-center gap-3 rounded-2xl border border-white/80 bg-white/68 px-3 hover:bg-white/85 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none"
            search={{ lang: "en" }}
            to="/privacy"
          >
            <PrivacyIcon icon={BriefcaseBusiness} />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">Data Usage</span>
              <span className="block text-xs text-[#687896]">Read the complete privacy notice</span>
            </span>
            <span className="text-sm text-[#687896]">Open</span>
          </Link>
          <DeleteAccountControl dependencies={dependencies} />
        </div>
      </section>
    </div>
  );
}

/** One explicit confirmation before the irreversible account deletion request. */
export function DeleteAccountControl({
  dependencies = defaultDependencies,
}: {
  readonly dependencies?: SettingsPrivacyDependencies;
} = {}) {
  const replay = useAccountDeletionReplayState();
  const [action, setAction] = useState<AccountDeletionAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [freshReason, setFreshReason] = useState<
    "expired" | "notAccepted" | "reauthenticate" | null
  >(null);
  useEffect(() => {
    if (action === null || freshReason !== null) return undefined;
    const remaining = action.expiresAt.getTime() - Date.now();
    if (remaining <= 0) {
      setFreshReason("expired");
      return undefined;
    }
    const timer = globalThis.setTimeout(() => setFreshReason("expired"), remaining);
    return () => globalThis.clearTimeout(timer);
  }, [action, freshReason]);
  const begin = () => {
    setBusy(true);
    setError(false);
    void Effect.runPromise(dependencies.presentAccountDeletion)
      .then((presented) => {
        setAction(presented);
        setFreshReason(null);
        setBusy(false);
      })
      .catch(() => {
        setBusy(false);
        setError(true);
      });
  };
  const remove = () => {
    if (action === null) return;
    if (action.expiresAt.getTime() <= Date.now()) {
      setFreshReason("expired");
      return;
    }
    const request = accountDeletionRequestFor(action);
    setBusy(true);
    setError(false);
    const submission = prepareBrowserAccountDeletionSubmission(
      replay.access,
      request,
      dependencies.requestAccountDeletion,
      () => {
        replay.complete();
        globalThis.location.assign("/");
      },
    );
    if (submission.replayAvailable) replay.retain(request);
    void Effect.runPromise(submission.effect).catch((cause: unknown) => {
      const disposition = accountDeletionFailureDisposition(cause);
      if (disposition !== "recover") {
        replay.complete();
        setBusy(false);
        setError(false);
        setFreshReason(disposition === "freshPresentation" ? "notAccepted" : "reauthenticate");
        return;
      }
      if (submission.replayAvailable) {
        globalThis.location.assign("/account-deletion/recovery");
        return;
      }
      setBusy(false);
      setError(true);
    });
  };
  return (
    <div className="rounded-2xl border border-white/80 bg-white/68 px-3 py-3">
      <div className="flex min-h-10 items-center gap-3">
        <PrivacyIcon icon={Trash2} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[#e54858]">Account Deletion</span>
          <span className="block text-xs text-[#687896]">
            Permanent account removal requires confirmation.
          </span>
        </span>
        <button
          className="min-h-11 rounded-full px-3 text-sm font-semibold text-[#c83242] hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-[#e54858] focus-visible:outline-none"
          disabled={busy}
          type="button"
          onClick={begin}
        >
          {busy && action === null ? "Preparing..." : "Delete Account"}
        </button>
      </div>
      {action === null && error ? (
        <p role="alert">Account deletion could not be presented. Please try again.</p>
      ) : null}
      {action !== null ? (
        <div className="mt-3 border-t border-red-100 pt-3">
          <p className="font-semibold text-[#7f2630]">{action.presentation.title}</p>
          <p className="text-sm text-[#7f2630]">{action.presentation.consequence}</p>
          {freshReason === "expired" ? (
            <p className="mt-3" role="alert">
              This confirmation has expired.
            </p>
          ) : null}
          {freshReason === "notAccepted" ? (
            <p className="mt-3" role="alert">
              Account deletion was not started.
            </p>
          ) : null}
          {freshReason === "reauthenticate" ? (
            <p className="mt-3" role="alert">
              Your session no longer authorizes this request.
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            {freshReason === null ? (
              <button
                className="min-h-11 rounded-full bg-[#d63243] px-4 text-sm font-semibold text-white disabled:opacity-60"
                disabled={busy}
                type="button"
                onClick={remove}
              >
                {busy ? "Deleting..." : "Confirm account deletion"}
              </button>
            ) : freshReason === "reauthenticate" ? (
              <a
                className="min-h-11 rounded-full bg-[#d63243] px-4 py-3 text-sm font-semibold text-white"
                href="/login"
              >
                Sign in
              </a>
            ) : (
              <button
                className="min-h-11 rounded-full bg-[#d63243] px-4 text-sm font-semibold text-white disabled:opacity-60"
                disabled={busy}
                type="button"
                onClick={begin}
              >
                {busy ? "Preparing..." : "Request fresh confirmation"}
              </button>
            )}
            <button
              className="min-h-11 rounded-full px-4 text-sm font-semibold"
              disabled={busy}
              type="button"
              onClick={() => {
                setAction(null);
                setFreshReason(null);
              }}
            >
              Cancel
            </button>
          </div>
          {error ? <p role="alert">Account deletion could not start. Please try again.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function PrivacyIcon({ icon: Icon }: { readonly icon: LucideIcon }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e7f1ff] text-[#2f7df4]">
      <Icon aria-hidden="true" className="size-5" />
    </span>
  );
}
