import { MessageCircle, Send } from "lucide-react";

/** Route-owned instructions for starting a private Channel Link journey. */
export function SettingsChannelsPage() {
  return (
    <div className="rounded-[1.5rem] border border-white/85 bg-white/68 p-6 shadow-[0_14px_36px_rgba(63,88,124,0.11)]">
      <h2 className="text-xl font-bold">Link a messaging channel</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#687896]">
        Send Osfo a private message from the external account you want to link. Osfo replies there
        with a private invitation. Links are never posted in group conversations.
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <ChannelCard color="bg-[#2f8fe8]" icon={Send} label="Telegram" />
        <ChannelCard color="bg-[#25d366]" icon={MessageCircle} label="WhatsApp" />
      </div>
    </div>
  );
}

function ChannelCard({
  color,
  icon: Icon,
  label,
}: {
  readonly color: string;
  readonly icon: typeof Send;
  readonly label: string;
}) {
  return (
    <section className="rounded-2xl border border-white/85 bg-white/72 p-5">
      <div className="flex items-center gap-4">
        <span className={`grid size-12 place-items-center rounded-full text-white ${color}`}>
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-lg font-black">{label}</h3>
          <p className="text-sm text-muted-foreground">Message Osfo privately from {label}.</p>
        </div>
      </div>
    </section>
  );
}
