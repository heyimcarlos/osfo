import { ChannelLinkChannel } from "@osfo/api";

import { ChannelId } from "../domain/channel-link";

/** Configured messenger endpoints and their safe Settings presentation kind. */
export const ChannelPresentationEndpoints = {
  telegram: {
    channelId: ChannelId.make("telegram"),
    presentation: ChannelLinkChannel.make("telegram"),
  },
  whatsapp: {
    channelId: ChannelId.make("whatsapp"),
    presentation: ChannelLinkChannel.make("whatsapp"),
  },
};

/** Resolve an opaque endpoint identity only through the configured presentation registry. */
export const channelPresentationOf = (channelId: typeof ChannelId.Type) => {
  const endpoint = Object.values(ChannelPresentationEndpoints).find(
    (candidate) => candidate.channelId === channelId,
  );
  return endpoint?.presentation ?? null;
};
