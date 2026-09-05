import { Link } from "@tanstack/react-router";
import {
  Plug,
  ChevronRight,
  MessagesSquare,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

type Shortcut = {
  readonly accent: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly to:
    | "/settings/channels"
    | "/settings/privacy"
    | "/settings/skills"
    | "/settings/integrations";
};

const shortcuts: ReadonlyArray<Shortcut> = [
  {
    accent: "bg-[#e2f0ff] text-[#2f7df4]",
    description: "Connect Telegram or WhatsApp",
    icon: MessagesSquare,
    title: "Channels",
    to: "/settings/channels",
  },
  {
    accent: "bg-[#e2f0ff] text-[#2f7df4]",
    description: "Connect apps and review pending actions",
    icon: Plug,
    title: "Integrations",
    to: "/settings/integrations",
  },
  {
    accent: "bg-[#dcf7e9] text-[#28a66a]",
    description: "Data controls and privacy settings",
    icon: ShieldCheck,
    title: "Privacy",
    to: "/settings/privacy",
  },
  {
    accent: "bg-[#f0e5ff] text-[#8a5be8]",
    description: "Review and manage learned preferences",
    icon: Sparkles,
    title: "Skills",
    to: "/settings/skills",
  },
];

/** Direct access to the Agent's available settings. */
export function SettingsShortcuts() {
  return (
    <section aria-label="Agent settings" className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
      {shortcuts.map((shortcut) => (
        <Link className={shortcutClassName} key={shortcut.title} to={shortcut.to}>
          <ShortcutContent shortcut={shortcut} />
        </Link>
      ))}
    </section>
  );
}

const shortcutClassName =
  "group flex min-h-24 items-center gap-3 rounded-[1.2rem] border border-white/75 bg-[rgba(250,252,255,0.66)] p-3.5 text-left shadow-[0_10px_26px_rgba(70,103,145,0.1)] backdrop-blur-xl transition hover:-translate-y-1 hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none active:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0";

function ShortcutContent({ shortcut }: { readonly shortcut: Shortcut }) {
  const Icon = shortcut.icon;
  return (
    <>
      <span
        aria-hidden="true"
        className={`grid size-11 shrink-0 place-items-center rounded-full ${shortcut.accent}`}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-[#101936]">{shortcut.title}</span>
        <span className="mt-1 block text-xs leading-snug text-[#65718a]">
          {shortcut.description}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-4 shrink-0 text-[#91a0b7] transition group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
      />
    </>
  );
}
