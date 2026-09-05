import { Check, ChevronRight } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";

import { channels, type Channel } from "./channel-model";

const surface =
  "rounded-[1.35rem] border border-white/75 bg-[rgba(250,252,255,0.66)] p-4 shadow-[0_12px_32px_rgba(70,103,145,0.11)] backdrop-blur-xl sm:p-5";

/** Interactive list of available messaging channels. */
export function ConnectedChannels({
  primaryChannel,
  onPrimaryChannelChange,
}: {
  readonly primaryChannel: Channel;
  readonly onPrimaryChannelChange: (channel: Channel) => void;
}) {
  return (
    <section className={surface} aria-labelledby="messaging-channels-title">
      <h2 className="mb-3 text-base font-bold text-[#101936]" id="messaging-channels-title">
        Messaging Channels
      </h2>
      <div className="grid gap-2.5">
        {channels.map(({ color, icon: Icon, id, label }) => {
          const primary = id === primaryChannel;
          return (
            <button
              aria-label={`${label}, ${primary ? "Preferred" : "Available"}`}
              aria-pressed={primary}
              className="group flex min-h-13 w-full items-center gap-3 rounded-2xl border border-[#d4e0ef]/70 bg-white/58 px-3.5 text-left shadow-[0_5px_14px_rgba(63,91,128,0.07)] transition hover:-translate-y-0.5 hover:bg-white/82 focus-visible:ring-2 focus-visible:ring-[#2f7df4] focus-visible:outline-none active:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              key={id}
              type="button"
              onClick={() => onPrimaryChannelChange(id)}
            >
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-full text-white shadow-sm"
                style={{ backgroundColor: color }}
              >
                <Icon className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1 font-semibold text-[#101936]">{label}</span>
              {primary ? (
                <span className="rounded-full border border-[#a9e0c2] bg-[#ddf7e9] px-2.5 py-1 text-xs font-bold text-[#257a50]">
                  Preferred
                </span>
              ) : null}
              <ChevronRight
                aria-hidden="true"
                className="size-4 text-[#91a0b7] transition group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Browser-local preferred-channel selector. */
export function MessagingSettings({
  primaryChannel,
  onPrimaryChannelChange,
}: {
  readonly primaryChannel: Channel;
  readonly onPrimaryChannelChange: (channel: Channel) => void;
}) {
  const radioRefs = useRef<Array<HTMLInputElement | null>>([]);
  const moveChannelSelection = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    const offset =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (offset === 0) return;
    event.preventDefault();
    const nextIndex = (index + offset + channels.length) % channels.length;
    const nextChannel = channels[nextIndex];
    if (nextChannel === undefined) return;
    onPrimaryChannelChange(nextChannel.id);
    radioRefs.current[nextIndex]?.focus();
  };
  return (
    <section className={surface} aria-labelledby="messaging-settings-title">
      <h2 className="mb-3 text-base font-bold text-[#101936]" id="messaging-settings-title">
        Messaging
      </h2>
      <div className="mt-2.5 rounded-2xl border border-[#d4e0ef]/70 bg-white/58 p-4">
        <h3 className="font-semibold text-[#101936]">Preferred Messaging Channel</h3>
        <p className="mt-0.5 text-xs text-[#65718a] sm:text-sm">
          Remember your preferred channel in this browser. Manage linked accounts in Channels.
        </p>
        <div
          aria-label="Preferred Messaging Channel"
          className="mt-3 grid grid-cols-2 rounded-xl border border-[#d6e1ef] bg-[#edf3fa]/75 p-1"
          role="radiogroup"
        >
          {channels.map(({ id, label }, index) => {
            const selected = id === primaryChannel;
            return (
              <label
                className={`flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition has-focus-visible:ring-2 has-focus-visible:ring-[#2f7df4] sm:text-sm motion-reduce:transition-none ${selected ? "bg-white text-[#101936] shadow-[0_3px_10px_rgba(54,83,123,0.15)]" : "text-[#65718a] hover:text-[#101936]"}`}
                key={id}
              >
                <input
                  checked={selected}
                  className="sr-only"
                  name="primary-messaging-channel"
                  ref={(element) => {
                    radioRefs.current[index] = element;
                  }}
                  type="radio"
                  value={id}
                  onKeyDown={(event) => moveChannelSelection(event, index)}
                  onChange={() => onPrimaryChannelChange(id)}
                />
                {label}
                {selected ? (
                  <span
                    aria-hidden="true"
                    className="grid size-4 place-items-center rounded-full bg-[#2f7df4] text-white"
                  >
                    <Check className="size-3" />
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>
    </section>
  );
}
