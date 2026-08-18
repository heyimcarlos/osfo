import { Link, Outlet } from "@tanstack/react-router";
import { ArrowLeft, CreditCard, LockKeyhole, MessageCircle, UserRound } from "lucide-react";

const settingsItems = [
  { label: "Overview", to: "/settings", icon: SettingsOverviewIcon },
  { label: "Messaging", to: "/settings/channels", icon: MessageCircle },
  { label: "Privacy", to: "/settings/privacy", icon: LockKeyhole },
  { label: "Profile", to: "/settings/profile", icon: UserRound },
  { label: "Billing", to: "/settings/billing", icon: CreditCard },
] as const;

function SettingsOverviewIcon() {
  return (
    <span aria-hidden="true" className="text-lg font-black">
      O
    </span>
  );
}

/** Responsive settings master-detail layout. */
export function SettingsShell() {
  return (
    <main className="grid min-h-dvh md:min-h-[calc(100dvh-2.5rem)] md:grid-cols-[minmax(15rem,0.36fr)_minmax(0,1fr)]">
      <nav aria-label="Settings" className="max-md:hidden border-r-2 p-5 md:p-8">
        <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">
          Control center
        </p>
        <h1 className="mt-2 text-4xl font-black uppercase">Settings</h1>
        <div className="mt-8 grid gap-2">
          {settingsItems.map(({ icon: Icon, label, to }) => (
            <Link
              activeOptions={{ exact: to === "/settings" }}
              activeProps={{ className: "bg-foreground text-background" }}
              className="flex items-center gap-3 rounded-xl px-4 py-3 font-black hover:bg-accent"
              key={to}
              to={to}
            >
              <Icon className="size-5" aria-hidden="true" />
              {label}
            </Link>
          ))}
        </div>
      </nav>
      <section className="min-w-0 p-5 md:p-10">
        <Link className="mb-6 inline-flex items-center gap-2 font-black md:hidden" to="/settings">
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to settings
        </Link>
        <Outlet />
      </section>
    </main>
  );
}
