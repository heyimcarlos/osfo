import { Link, Outlet } from "@tanstack/react-router";
import { MessageCircle, Settings } from "lucide-react";

/** Frame authenticated Think and detail pages with compact control-center navigation. */
export function ControlCenterShell() {
  return (
    <div className="min-h-dvh bg-[radial-gradient(circle_at_top,oklch(0.96_0.035_250),oklch(0.985_0.006_250)_42%,oklch(0.965_0.008_250))] p-0 text-foreground md:p-5">
      <div className="mx-auto grid min-h-dvh max-w-7xl bg-background shadow-[0_24px_80px_oklch(0.2_0.025_258/0.14)] md:min-h-[calc(100dvh-2.5rem)] md:grid-cols-[5rem_1fr] md:overflow-hidden md:rounded-[2rem] md:border-2">
        <aside className="fixed inset-x-0 bottom-0 z-20 flex h-16 items-center justify-around border-t-2 bg-background px-4 md:static md:h-auto md:flex-col md:justify-start md:border-r-2 md:border-t-0 md:py-6">
          <Link
            aria-label="Osfo Think"
            className="hidden size-11 place-items-center rounded-full bg-primary text-xl font-black text-primary-foreground md:grid"
            to="/think"
          >
            O
          </Link>
          <nav
            aria-label="Control center"
            className="flex w-full justify-around md:mt-10 md:flex-col md:items-center md:gap-4"
          >
            <Link
              activeProps={{ className: "bg-primary text-primary-foreground" }}
              className="grid size-11 place-items-center rounded-xl text-muted-foreground hover:bg-accent"
              to="/think"
            >
              <MessageCircle aria-hidden="true" />
              <span className="sr-only">Think</span>
            </Link>
            <Link
              activeOptions={{ includeSearch: false }}
              activeProps={{ className: "bg-primary text-primary-foreground" }}
              className="grid size-11 place-items-center rounded-xl text-muted-foreground hover:bg-accent"
              to="/settings"
            >
              <Settings aria-hidden="true" />
              <span className="sr-only">Settings</span>
            </Link>
          </nav>
        </aside>
        <div className="min-w-0 pb-16 md:pb-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
