import { MessageCircle } from "lucide-react";

/** Route-owned messaging channel status. */
export function SettingsChannelsPage() {
  return (
    <div>
      <p className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground">
        Messaging
      </p>
      <h2 className="mt-2 text-4xl font-black uppercase md:text-6xl">Messaging channel</h2>
      <div className="mt-8 max-w-xl border-2 p-6 shadow-[6px_6px_0_var(--foreground)]">
        <div className="flex items-center gap-4">
          <span className="grid size-12 place-items-center rounded-full bg-[#25d366] text-white">
            <MessageCircle aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-xl font-black">WhatsApp</h3>
            <p className="text-sm text-muted-foreground">Osfo's supported v1 messaging channel</p>
          </div>
        </div>
        <p className="mt-6 leading-relaxed">
          Channel changes need verified identity and safe conflict handling. Self-service connection
          controls are not available yet.
        </p>
      </div>
    </div>
  );
}
