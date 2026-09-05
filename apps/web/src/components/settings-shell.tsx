import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeft,
  CreditCard,
  LogOut,
  MessagesSquare,
  MoreHorizontal,
  Plug,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  type LucideIcon,
} from "lucide-react";

import { authClient } from "../lib/auth-client";

type SettingsDestination =
  | "/settings/general"
  | "/settings/channels"
  | "/settings/integrations"
  | "/settings/profile"
  | "/settings/privacy"
  | "/settings/billing"
  | "/settings/skills";

type SettingsNavigationItem = {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly to: SettingsDestination;
};

const settingsItems: ReadonlyArray<SettingsNavigationItem> = [
  { icon: Settings, label: "Settings", to: "/settings/general" },
  { icon: MessagesSquare, label: "Channels", to: "/settings/channels" },
  { icon: Plug, label: "Integrations", to: "/settings/integrations" },
  { icon: UserRound, label: "Profile", to: "/settings/profile" },
  { icon: ShieldCheck, label: "Privacy", to: "/settings/privacy" },
  { icon: CreditCard, label: "Billing", to: "/settings/billing" },
  { icon: Sparkles, label: "Skills", to: "/settings/skills" },
];

const pageDetails = {
  "/settings/billing": { subtitle: "Manage your plan and payments", title: "Billing" },
  "/settings/channels": {
    subtitle: "Manage how people reach your agent",
    title: "Messaging channel",
  },
  "/settings/general": { subtitle: "Manage your agent and account", title: "Settings" },
  "/settings/integrations": {
    subtitle: "Connect the services Osfo may use with your approval",
    title: "Integrations",
  },
  "/settings/privacy": { subtitle: "Control your data and privacy settings", title: "Privacy" },
  "/settings/profile": { subtitle: "Manage your account information", title: "Profile" },
  "/settings/skills": { subtitle: "Review what Osfo has learned", title: "Skills" },
} as const;

const getPageDetails = (pathname: string) => {
  switch (pathname) {
    case "/settings/billing":
    case "/settings/channels":
    case "/settings/general":
    case "/settings/integrations":
    case "/settings/privacy":
    case "/settings/profile":
    case "/settings/skills":
      return pageDetails[pathname];
    default:
      return pageDetails["/settings/general"];
  }
};

/** Responsive glass settings shell shared by authenticated control-panel details. */
export function SettingsShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const router = useRouter();
  const details = getPageDetails(pathname);

  return (
    <main
      className="min-h-dvh overflow-x-hidden bg-cover bg-center px-3 py-3 text-[#16213f] sm:px-6 sm:py-6 lg:grid lg:place-items-center"
      style={{ backgroundImage: "url('/osfo/agent-background.webp')" }}
    >
      <section className="relative mx-auto flex min-h-[calc(100dvh-1.5rem)] w-full max-w-[1184px] flex-col overflow-hidden rounded-[2rem] border border-white/80 bg-[rgba(239,244,252,0.78)] p-4 shadow-[0_30px_90px_rgba(45,68,110,0.24),inset_0_1px_0_rgba(255,255,255,0.92)] backdrop-blur-[24px] sm:min-h-[calc(100dvh-3rem)] sm:p-7 lg:min-h-[min(914px,calc(100dvh-3rem))]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/35 to-transparent" />
        <header className="relative z-20 grid grid-cols-[1fr_auto] items-start gap-3 md:grid-cols-[1fr_1.6fr_1fr] md:items-center">
          <Link
            className="w-fit rounded-lg focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none"
            to="/settings"
          >
            <img
              alt="Osfo dashboard"
              className="h-auto w-[108px] object-contain sm:w-[120px]"
              height={160}
              src="/osfo/osfo-logo.webp"
              width={480}
            />
          </Link>
          <div className="col-span-2 row-start-2 text-center md:col-span-1 md:col-start-2 md:row-start-1">
            <h1
              className="text-[clamp(2rem,3vw,2.65rem)] leading-none font-semibold tracking-[-0.035em] text-[#101936]"
              style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              {details.title}
            </h1>
            <p className="mt-1 text-sm text-[#687896]">{details.subtitle}</p>
          </div>
          <div className="flex items-center gap-2 justify-self-end md:col-start-3">
            <details className="group relative z-30">
              <summary
                aria-label="Open account menu"
                className="grid size-11 cursor-pointer list-none place-items-center rounded-full border border-white/80 bg-white/60 text-[#172442] shadow-[0_8px_20px_rgba(45,68,110,0.12)] transition hover:bg-white/85 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none motion-reduce:transition-none [&::-webkit-details-marker]:hidden"
              >
                <MoreHorizontal aria-hidden="true" className="size-5" />
              </summary>
              <div className="absolute top-13 right-0 grid min-w-48 gap-1 rounded-2xl border border-white/85 bg-white/92 p-2 text-sm font-semibold shadow-[0_18px_45px_rgba(45,68,110,0.2)] backdrop-blur-xl">
                <Link className="rounded-xl px-3 py-2.5 hover:bg-[#edf4ff]" to="/settings/profile">
                  Profile
                </Link>
                <Link className="rounded-xl px-3 py-2.5 hover:bg-[#edf4ff]" to="/settings/billing">
                  Billing
                </Link>
                <button
                  className="rounded-xl px-3 py-2.5 text-left text-[#d64556] hover:bg-[#fff0f2]"
                  type="button"
                  onClick={() =>
                    void authClient.signOut({
                      fetchOptions: { onSuccess: () => void router.navigate({ to: "/" }) },
                    })
                  }
                >
                  Log out
                </button>
              </div>
            </details>
          </div>
        </header>

        <div className="relative z-10 mt-6 grid min-h-0 flex-1 gap-5 md:grid-cols-[250px_minmax(0,1fr)] md:gap-8">
          <aside className="flex flex-col rounded-[1.5rem] border border-white/80 bg-white/58 p-3 shadow-[0_12px_34px_rgba(64,91,128,0.08)] backdrop-blur-xl md:p-4">
            <Link
              className="mb-3 flex min-h-11 items-center gap-2 rounded-xl px-2 text-sm font-medium text-[#5f7192] hover:bg-white/60 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none"
              to="/settings"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Back to dashboard
            </Link>
            <nav
              aria-label="Settings"
              className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-1"
            >
              {settingsItems.map(({ icon: Icon, label, to }) => (
                <Link
                  activeProps={{
                    className: "bg-[#dce9fc] text-[#135fdd] before:opacity-100",
                  }}
                  className="relative flex min-h-13 items-center gap-3 rounded-xl px-3 font-medium text-[#16213f] before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-full before:bg-[#2f7df4] before:opacity-0 hover:bg-white/65 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none"
                  key={to}
                  to={to}
                >
                  <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.6} />
                  <span className="truncate">{label}</span>
                </Link>
              ))}
            </nav>
            <button
              className="mt-auto hidden min-h-11 items-center gap-3 rounded-xl px-3 text-left font-medium hover:bg-white/65 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none md:flex"
              type="button"
              onClick={() =>
                void authClient.signOut({
                  fetchOptions: { onSuccess: () => void router.navigate({ to: "/" }) },
                })
              }
            >
              <LogOut aria-hidden="true" className="size-5 text-[#65799c]" />
              Log out
            </button>
          </aside>
          <section className="min-w-0 pb-2">
            <Outlet />
          </section>
        </div>
      </section>
    </main>
  );
}
