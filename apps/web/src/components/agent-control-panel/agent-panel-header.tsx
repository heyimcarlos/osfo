import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";

/** Logo, status, title, and accessible overflow actions for the Agent panel. */
export function AgentPanelHeader({ status }: { readonly status: { readonly kind: "Active" } }) {
  return (
    <header className="relative z-20 grid grid-cols-[1fr_auto] items-start gap-3 md:grid-cols-[1fr_1.6fr_1fr] md:items-center">
      <img
        alt="Osfo"
        className="h-auto w-[108px] object-contain sm:w-[120px]"
        height={160}
        src="/osfo/osfo-logo.webp"
        width={480}
      />
      <div className="col-span-2 row-start-2 text-center md:col-span-1 md:col-start-2 md:row-start-1">
        <h1
          className="text-[clamp(1.85rem,3vw,2.4rem)] leading-none font-semibold tracking-[-0.035em] text-[#101936]"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Manage your agent
        </h1>
        <span className="mt-3 inline-flex min-h-8 items-center gap-2 rounded-full border border-white/80 bg-white/65 px-4 text-sm font-semibold text-[#2e5e49] shadow-[0_6px_20px_rgba(62,102,131,0.12)]">
          <span aria-hidden="true" className="size-2 rounded-full bg-[#28b66f]" />
          {status.kind === "Active" ? "Agent Active" : null}
        </span>
      </div>
      <details className="group relative z-30 justify-self-end md:col-start-3">
        <summary
          aria-label="Agent menu"
          className="grid size-11 cursor-pointer list-none place-items-center rounded-full border border-white/80 bg-white/55 text-[#18223f] shadow-[0_8px_20px_rgba(45,68,110,0.12)] transition hover:bg-white/80 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:ring-offset-2 focus-visible:outline-none [&::-webkit-details-marker]:hidden"
        >
          <MoreHorizontal aria-hidden="true" className="size-5" />
        </summary>
        <div className="absolute top-13 right-0 grid min-w-44 gap-1 rounded-2xl border border-white/85 bg-white/90 p-2 text-sm font-semibold text-[#101936] shadow-[0_18px_45px_rgba(45,68,110,0.2)] backdrop-blur-xl">
          <Link
            className="flex min-h-11 items-center rounded-xl px-3 py-2.5 hover:bg-[#edf4ff] focus-visible:outline-2"
            to="/settings/profile"
          >
            Agent details
          </Link>
          <span
            aria-disabled="true"
            className="flex min-h-11 cursor-not-allowed items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-[#65718a]"
          >
            Pause agent <small>Unavailable</small>
          </span>
          <Link
            className="flex min-h-11 items-center rounded-xl px-3 py-2.5 hover:bg-[#edf4ff] focus-visible:outline-2"
            search={{ lang: "en" }}
            to="/privacy"
          >
            Help
          </Link>
        </div>
      </details>
    </header>
  );
}
