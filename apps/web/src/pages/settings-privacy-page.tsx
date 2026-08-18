import { Link } from "@tanstack/react-router";
import { LockKeyhole } from "lucide-react";

/** Route-owned privacy settings summary. */
export function SettingsPrivacyPage() {
  return (
    <div>
      <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">
        Your data
      </p>
      <h2 className="mt-2 text-4xl font-black uppercase md:text-6xl">Privacy</h2>
      <div className="mt-8 max-w-xl border-2 p-6">
        <LockKeyhole className="size-8" aria-hidden="true" />
        <h3 className="mt-6 text-xl font-black uppercase">Private by default</h3>
        <p className="mt-3 leading-relaxed text-muted-foreground">
          Your Osfo Agent, conversation context, and connected authority belong to your User. Osfo
          does not present unsupported deletion or export controls as working actions.
        </p>
        <Link
          className="mt-6 inline-block font-black underline"
          search={{ lang: "en" }}
          to="/privacy"
        >
          Read the complete privacy notice
        </Link>
      </div>
    </div>
  );
}
