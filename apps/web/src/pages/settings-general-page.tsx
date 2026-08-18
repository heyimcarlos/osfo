import { ChevronRight, MessageCircle, Sparkles, Sun } from "lucide-react";

const settingRows = [
  { label: "Agent name", value: "Osfo" },
  { label: "Language", value: "English" },
  { label: "Timezone", value: "America/Toronto" },
  { label: "Appearance", value: "Light" },
] as const;

const preferences = [
  {
    description: "Allow Osfo to suggest helpful replies",
    enabled: true,
    icon: Sparkles,
    label: "Auto-reply suggestions",
  },
  {
    description: "Let others know when Osfo reads messages",
    enabled: true,
    icon: MessageCircle,
    label: "Message read confirmations",
  },
  {
    description: "Show more content in less space",
    enabled: false,
    icon: Sun,
    label: "Compact mode",
  },
] as const;

const rowClassName =
  "flex min-h-13 w-full items-center gap-3 rounded-2xl border border-white/80 bg-white/68 px-4 text-left shadow-[0_5px_14px_rgba(63,91,128,0.05)]";

/** Route-owned general settings preview. */
export function SettingsGeneralPage() {
  return (
    <div className="space-y-5">
      <section aria-labelledby="general-settings-title">
        <h2 className="mb-2 text-sm font-bold" id="general-settings-title">
          General
        </h2>
        <div className="grid gap-2">
          {settingRows.map(({ label, value }) => (
            <div className={rowClassName} key={label}>
              <span className="flex-1 font-semibold">{label}</span>
              <span className="text-sm text-[#687896]">{value}</span>
              <ChevronRight aria-hidden="true" className="size-4 text-[#8193b0]" />
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="preference-settings-title">
        <h2 className="mb-2 text-sm font-bold" id="preference-settings-title">
          Preferences
        </h2>
        <div className="grid gap-2">
          {preferences.map(({ description, enabled, icon: Icon, label }) => (
            <div className={rowClassName} key={label}>
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-[#e8f1ff] text-[#2f7df4]"
              >
                <Icon className="size-5" />
              </span>
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

      <section aria-labelledby="agent-defaults-title">
        <h2 className="mb-2 text-sm font-bold" id="agent-defaults-title">
          Agent defaults
        </h2>
        <div className="grid gap-2">
          <div className={rowClassName}>
            <span className="flex-1 font-semibold">Default channel</span>
            <span className="text-sm text-[#687896]">WhatsApp</span>
            <ChevronRight aria-hidden="true" className="size-4 text-[#8193b0]" />
          </div>
          <div className={rowClassName}>
            <span className="flex-1 font-semibold">Response style</span>
            <span className="text-sm text-[#687896]">Friendly</span>
            <ChevronRight aria-hidden="true" className="size-4 text-[#8193b0]" />
          </div>
        </div>
      </section>
      <p className="text-xs text-[#687896]">
        These values show the planned settings experience. Editing will be available when the
        related agent operations are supported.
      </p>
    </div>
  );
}
