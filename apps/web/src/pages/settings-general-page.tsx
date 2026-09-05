import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

const settings = [
  {
    title: "Reminders",
    description: "Review and approve the exact reminders Osfo has prepared.",
    to: "/settings/reminders",
  },
  {
    title: "Messaging channels",
    description: "Connect Telegram or WhatsApp and manage linked accounts.",
    to: "/settings/channels",
  },
  {
    title: "Integrations and approvals",
    description: "Connect apps and review actions waiting for your approval.",
    to: "/settings/integrations",
  },
  {
    title: "Skills",
    description: "Review, archive, restore, or delete learned preferences.",
    to: "/settings/skills",
  },
  {
    title: "Profile and sign-in",
    description: "View your account identity and add email and password sign-in.",
    to: "/settings/profile",
  },
  {
    title: "Billing",
    description: "Check your allowance and manage your plan and payments.",
    to: "/settings/billing",
  },
  {
    title: "Privacy",
    description: "Read how Osfo handles your data or delete your account.",
    to: "/settings/privacy",
  },
] as const;

/** Supported settings, linked to the page that owns each operation. */
export function SettingsGeneralPage() {
  return (
    <nav aria-label="Available settings" className="grid gap-3">
      {settings.map((setting) => (
        <Link
          className="flex min-h-20 items-center gap-3 rounded-2xl border border-white/80 bg-white/68 p-4 shadow-[0_5px_14px_rgba(63,91,128,0.05)] hover:bg-white/85 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none"
          key={setting.to}
          to={setting.to}
        >
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">{setting.title}</span>
            <span className="mt-1 block text-sm text-[#687896]">{setting.description}</span>
          </span>
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[#8193b0]" />
        </Link>
      ))}
    </nav>
  );
}
