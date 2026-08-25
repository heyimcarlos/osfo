import { Link } from "@tanstack/react-router";
import type { AccountDeletionActionPresentation } from "@osfo/api";
import { BriefcaseBusiness, Database, Download, ShieldCheck, Trash2 } from "lucide-react";
import { Effect } from "effect";
import { useState } from "react";

import { presentAccountDeletion, requestAccountDeletion } from "../lib/api-client";

const privacyPreferences = [
  {
    description: "Share anonymous usage data when this control becomes available",
    enabled: true,
    label: "Allow data collection to improve Osfo",
  },
  {
    description: "Help us understand how Osfo is used",
    enabled: true,
    label: "Allow analytics",
  },
  {
    description: "Allow Osfo to personalize responses",
    enabled: true,
    label: "Personalized responses",
  },
  {
    description: "Keep preferences consistent across messaging apps",
    enabled: false,
    label: "Use memory across channels",
  },
] as const;

/** Route-owned privacy controls and policy access. */
export function SettingsPrivacyPage() {
  return <SettingsPrivacyContent onDelete={deleteAccount} onPresent={presentDeletion} />;
}

const presentDeletion = () => Effect.runPromise(presentAccountDeletion);

const deleteAccount = (presentation: AccountDeletionActionPresentation) =>
  Effect.runPromise(requestAccountDeletion(presentation)).then(() => {
    globalThis.location.assign("/");
  });

/** Privacy settings content with an injectable destructive boundary for focused UI tests. */
export function SettingsPrivacyContent({
  onDelete,
  onPresent,
}: {
  readonly onDelete: (presentation: AccountDeletionActionPresentation) => Promise<void>;
  readonly onPresent: () => Promise<AccountDeletionActionPresentation>;
}) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="data-controls-title">
        <h2 className="mb-2 text-sm font-bold" id="data-controls-title">
          Data Controls
        </h2>
        <div className="grid gap-2">
          <UnavailablePrivacyRow
            description="Manage what Osfo remembers about you"
            icon={Database}
            label="Memory"
          />
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
          <UnavailablePrivacyRow
            description="Download a copy of your data"
            icon={Download}
            label="Export My Data"
          />
          <DeleteAccountControl onDelete={onDelete} onPresent={onPresent} />
        </div>
      </section>

      <section aria-labelledby="privacy-preferences-title">
        <h2 className="mb-2 text-sm font-bold" id="privacy-preferences-title">
          Privacy Preferences
        </h2>
        <div className="grid gap-2">
          {privacyPreferences.map(({ description, enabled, label }) => (
            <div
              className="flex min-h-16 items-center gap-3 rounded-2xl border border-white/80 bg-white/68 px-3"
              key={label}
            >
              <PrivacyIcon icon={ShieldCheck} />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{label}</span>
                <span className="block text-xs text-[#687896]">{description}</span>
              </span>
              <span
                aria-label={`${label}: ${enabled ? "on" : "off"}, preview only`}
                className={`relative h-7 w-12 shrink-0 rounded-full ${enabled ? "bg-[#2f7df4]" : "bg-[#aebdd2]"}`}
                role="img"
              >
                <span
                  aria-hidden="true"
                  className={`absolute top-1 size-5 rounded-full bg-white shadow ${enabled ? "right-1" : "left-1"}`}
                />
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3 rounded-2xl border border-[#a9dfc3] bg-[#e5f7ee]/80 p-4 text-[#236b49]">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-[#d1f2e0]">
          <ShieldCheck aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h2 className="font-semibold">Privacy protections are active</h2>
          <p className="text-xs text-[#4e8169]">
            Your account uses the recommended privacy settings.
          </p>
        </div>
      </div>
    </div>
  );
}

/** One explicit confirmation before the irreversible account deletion request. */
export function DeleteAccountControl({
  onDelete,
  onPresent,
}: {
  readonly onDelete: (presentation: AccountDeletionActionPresentation) => Promise<void>;
  readonly onPresent: () => Promise<AccountDeletionActionPresentation>;
}) {
  const [presentation, setPresentation] = useState<AccountDeletionActionPresentation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const begin = () => {
    setBusy(true);
    setError(false);
    void onPresent()
      .then((presented) => {
        setPresentation(presented);
        setBusy(false);
      })
      .catch(() => {
        setBusy(false);
        setError(true);
      });
  };
  const remove = () => {
    if (presentation === null) return;
    setBusy(true);
    setError(false);
    void onDelete(presentation).catch(() => {
      setBusy(false);
      setError(true);
    });
  };
  return (
    <div className="rounded-2xl border border-white/80 bg-white/68 px-3 py-3">
      <div className="flex min-h-10 items-center gap-3">
        <PrivacyIcon icon={Trash2} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-[#e54858]">Delete My Data</span>
          <span className="block text-xs text-[#687896]">Permanently delete your data</span>
        </span>
        <button
          className="min-h-11 rounded-full px-3 text-sm font-semibold text-[#c83242] hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-[#e54858] focus-visible:outline-none"
          disabled={busy}
          type="button"
          onClick={begin}
        >
          {busy && presentation === null ? "Preparing…" : "Delete My Data"}
        </button>
      </div>
      {presentation === null && error ? (
        <p role="alert">Account deletion could not be presented. Please try again.</p>
      ) : null}
      {presentation !== null ? (
        <div className="mt-3 border-t border-red-100 pt-3">
          <p className="text-sm text-[#7f2630]">{presentation.consequence}.</p>
          <div className="mt-3 flex gap-2">
            <button
              className="min-h-11 rounded-full bg-[#d63243] px-4 text-sm font-semibold text-white disabled:opacity-60"
              disabled={busy}
              type="button"
              onClick={remove}
            >
              {busy ? "Deleting…" : "Confirm account deletion"}
            </button>
            <button
              className="min-h-11 rounded-full px-4 text-sm font-semibold"
              disabled={busy}
              type="button"
              onClick={() => setPresentation(null)}
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

function PrivacyIcon({ icon: Icon }: { readonly icon: typeof ShieldCheck }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e7f1ff] text-[#2f7df4]">
      <Icon aria-hidden="true" className="size-5" />
    </span>
  );
}

function UnavailablePrivacyRow({
  danger = false,
  description,
  icon: Icon,
  label,
}: {
  readonly danger?: boolean;
  readonly description: string;
  readonly icon: typeof ShieldCheck;
  readonly label: string;
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 rounded-2xl border border-white/80 bg-white/68 px-3">
      <PrivacyIcon icon={Icon} />
      <span className="min-w-0 flex-1">
        <span className={`block font-semibold ${danger ? "text-[#e54858]" : ""}`}>{label}</span>
        <span className="block text-xs text-[#687896]">{description}</span>
      </span>
      <span className="text-[10px] text-[#687896]">Coming soon</span>
    </div>
  );
}
