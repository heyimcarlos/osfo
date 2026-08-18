import { MessageCircle } from "lucide-react";

/** Route-owned messaging channel status. */
export function SettingsChannelsPage() {
  return (
    <div className="rounded-[1.5rem] border border-white/85 bg-white/68 p-6 shadow-[0_14px_36px_rgba(63,88,124,0.11)]">
      <h2 className="font-bold">Supported channel</h2>
      <div className="mt-5 max-w-xl">
        <div className="flex items-center gap-4">
          <span className="grid size-12 place-items-center rounded-full bg-[#25d366] text-white">
            <MessageCircle aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-xl font-black">WhatsApp</h3>
            <p className="text-sm text-muted-foreground">Osfo's supported v1 messaging channel</p>
          </div>
        </div>
        <p className="mt-6 leading-relaxed text-[#687896]">
          Channel changes need verified identity and safe conflict handling. Self-service connection
          controls are not available yet.
        </p>
      </div>
    </div>
  );
}
