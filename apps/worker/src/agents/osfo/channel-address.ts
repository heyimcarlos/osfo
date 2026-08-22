import type { MessengerContext } from "@cloudflare/think/messengers";

import { ChannelLinks } from "../../services/channel-links";

/** Read the author from a live event or Think's serializable messenger snapshot. */
export const messengerAuthorId = (context: MessengerContext): string | undefined =>
  context.message?.author.userId ?? context.author?.userId;

/** Translate Think's normalized messenger identity into Channel Link authority identity. */
export const channelAddressOf = (messengerId: string, authorId: string) =>
  ChannelLinks.ChannelAddress.make({
    authorId: ChannelLinks.ChannelAuthorId.make(authorId),
    channelId: ChannelLinks.ChannelId.make(messengerId),
  });
