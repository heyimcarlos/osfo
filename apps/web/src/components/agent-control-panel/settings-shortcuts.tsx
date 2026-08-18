import { Link } from "@tanstack/react-router";
import { Bell, Brain, ChevronRight, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";

type Shortcut = {
  readonly accent: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly title: string;
} & ({ readonly kind: "Link"; readonly to: "/settings/privacy" } | { readonly kind: "Explainer" });

const shortcuts: ReadonlyArray<Shortcut> = [
  {
    kind: "Explainer",
    accent: "bg-[#eee9ff] text-[#7867f2]",
    description: "Manage alerts and notification preferences",
    icon: Bell,
    title: "Notifications",
  },
  {
    kind: "Explainer",
    accent: "bg-[#e2f0ff] text-[#2f7df4]",
    description: "Control what your agent remembers",
    icon: Brain,
    title: "Memory",
  },
  {
    kind: "Link",
    accent: "bg-[#dcf7e9] text-[#28a66a]",
    description: "Data controls and privacy settings",
    icon: ShieldCheck,
    title: "Privacy",
    to: "/settings/privacy",
  },
  {
    kind: "Explainer",
    accent: "bg-[#f0e5ff] text-[#8a5be8]",
    description: "Customize tone and response behavior",
    icon: Sparkles,
    title: "Response Style",
  },
];

/** Compact settings shortcuts that do not invent unsupported mutations. */
export function SettingsShortcuts() {
  const [explainer, setExplainer] = useState<Shortcut | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (explainer === null) triggerRef.current?.focus();
    else closeButtonRef.current?.focus();
  }, [explainer]);
  const openExplainer = (shortcut: Shortcut, event: MouseEvent<HTMLButtonElement>) => {
    triggerRef.current = event.currentTarget;
    setExplainer(shortcut);
  };
  const closeExplainer = () => setExplainer(null);
  const containDialogFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeExplainer();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      closeButtonRef.current?.focus();
    }
  };
  return (
    <>
      <section
        aria-label="Agent settings"
        className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4"
        inert={explainer !== null}
      >
        {shortcuts.map((shortcut) => {
          const content = <ShortcutContent shortcut={shortcut} />;
          return shortcut.kind === "Link" ? (
            <Link className={shortcutClassName} key={shortcut.title} to={shortcut.to}>
              {content}
            </Link>
          ) : (
            <button
              className={shortcutClassName}
              key={shortcut.title}
              type="button"
              onClick={(event) => openExplainer(shortcut, event)}
            >
              {content}
            </button>
          );
        })}
      </section>
      {explainer === null ? null : (
        <div
          aria-labelledby="unavailable-setting-title"
          aria-modal="true"
          className="absolute inset-0 z-50 grid place-items-center bg-[#52647d]/20 p-5 backdrop-blur-sm"
          role="dialog"
          onKeyDown={containDialogFocus}
        >
          <div className="w-full max-w-sm rounded-3xl border border-white/80 bg-white/92 p-6 text-center shadow-[0_24px_70px_rgba(45,68,110,0.24)]">
            <h2 className="text-2xl font-bold text-[#101936]" id="unavailable-setting-title">
              {explainer.title}
            </h2>
            <p className="mt-3 text-[#65718a]">
              This control is not available yet. Osfo will show it here when it is supported.
            </p>
            <button
              className="mt-5 min-h-11 rounded-xl bg-[#2f7df4] px-5 font-semibold text-white focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:ring-offset-2 focus-visible:outline-none"
              ref={closeButtonRef}
              type="button"
              onClick={closeExplainer}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
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
