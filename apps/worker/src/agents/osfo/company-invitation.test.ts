import type { StreamCallback } from "@cloudflare/think";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ChannelLinks } from "../../services/channel-links";
import { makeInvitePresenter } from "./company-invitation";

/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Channel Links and @effect/vitest use tagged unions and Effect callbacks. */

const address = ChannelLinks.ChannelAddress.make({
  authorId: ChannelLinks.ChannelAuthorId.make("company-author"),
  channelId: ChannelLinks.ChannelId.make("telegram"),
});

describe("Company invitation presentation", () => {
  it.effect("reuses a held URL only while the same linking attempt is current", () =>
    Effect.gen(function* () {
      let ensureCalls = 0;
      const heldUrl = new URL("https://osfo.test/verify/aB12cD34");
      const reply = makeReplyRecorder();
      const presenter = makeInvitePresenter({
        address,
        channelLinks: channelLinks({
          ensure: () => {
            ensureCalls += 1;
            return Effect.die(new Error("Held invitations must not be reminted"));
          },
          previousChannelLinkId: null,
        }),
        previousChannelLinkId: null,
        readHeld: () => ({ expiresAtMs: Number.MAX_SAFE_INTEGER, url: heldUrl }),
        requestId: "message-1",
        writeHeld: () => undefined,
      });

      presenter.request();
      yield* presenter.flush(reply.callback, true);

      expect(ensureCalls).toBe(0);
      expect(reply.events.join("\n")).toContain(heldUrl.href);
    }),
  );

  it.effect("refuses a held URL after the linking attempt advances", () =>
    Effect.gen(function* () {
      let ensureCalls = 0;
      let heldCleared = false;
      const heldUrl = new URL("https://osfo.test/verify/aB12cD34");
      const reply = makeReplyRecorder();
      const presenter = makeInvitePresenter({
        address,
        channelLinks: channelLinks({
          ensure: () => {
            ensureCalls += 1;
            return Effect.die(new Error("A stale attempt must not mint"));
          },
          previousChannelLinkId: ChannelLinks.ChannelLinkId.make("channel-link-after-revocation"),
        }),
        previousChannelLinkId: null,
        readHeld: () => ({ expiresAtMs: Number.MAX_SAFE_INTEGER, url: heldUrl }),
        requestId: "message-2",
        writeHeld: (held) => {
          heldCleared = held === null;
        },
      });

      presenter.request();
      yield* presenter.flush(reply.callback, true);

      expect(heldCleared).toBe(true);
      expect(ensureCalls).toBe(0);
      expect(reply.events.join("\n")).toContain("linking attempt has ended");
      expect(reply.events.join("\n")).not.toContain(heldUrl.href);
    }),
  );
});

const channelLinks = (options: {
  readonly ensure: ChannelLinks.Interface["ensure"];
  readonly previousChannelLinkId: ChannelLinks.ChannelLinkId | null;
}): ChannelLinks.Interface => ({
  accept: () => Effect.die(new Error("Unused Channel Links operation")),
  ensure: options.ensure,
  inspect: () => Effect.die(new Error("Unused Channel Links operation")),
  listActive: () => Effect.die(new Error("Unused Channel Links operation")),
  resolve: () => Effect.die(new Error("Unused Channel Links operation")),
  resolveConversation: () =>
    Effect.succeed({
      _tag: "Unlinked" as const,
      previousChannelLinkId: options.previousChannelLinkId,
    }),
  revoke: () => Effect.die(new Error("Unused Channel Links operation")),
});

const makeReplyRecorder = () => {
  const events: Array<string> = [];
  const callback = {
    onDone: () => undefined,
    onError: () => undefined,
    onEvent: (event: string) => {
      events.push(event);
    },
    onStart: () => undefined,
  } satisfies StreamCallback;
  return { callback, events };
};
