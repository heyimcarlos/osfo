import { Link } from "@tanstack/react-router";
import { BriefcaseBusiness, Database, Download, ShieldCheck, Trash2 } from "lucide-react";

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
          <UnavailablePrivacyRow
            danger
            description="Permanently delete your data"
            icon={Trash2}
            label="Delete My Data"
          />
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
