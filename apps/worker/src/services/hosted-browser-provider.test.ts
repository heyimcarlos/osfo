/* oxlint-disable vitest/no-standalone-expect -- Effect Vitest it.effect callbacks are test bodies. */
import { beforeEach, describe, expect, it } from "@effect/vitest";
import type { BrowserBinding, CdpSession } from "agents/browser";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { vi } from "vitest";
import { HostedBrowserProvider } from "./hosted-browser-provider";

const sdk = (() => {
  // oxlint-disable-next-line effecttsgo/extends-native-error -- Reproduces the external SDK error class at its adapter boundary.
  class BrowserRenderingError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  const send = vi.fn<CdpSession["send"]>();
  const disconnect = vi.fn<() => void>();
  return {
    BrowserRenderingError,
    send,
    disconnect,
    connectBrowserSession: vi.fn<
      () => Promise<Pick<CdpSession, "send" | "attachToTarget" | "disconnect">>
    >(() =>
      Promise.resolve({ send, attachToTarget: () => Promise.resolve("attached"), disconnect }),
    ),
    createBrowserSession: vi.fn<() => Promise<{ sessionId: string }>>(() =>
      Promise.resolve({ sessionId: "session" }),
    ),
    deleteBrowserSession: vi.fn<(browser: BrowserBinding, sessionId: string) => Promise<void>>(),
  };
})();

const url = "https://portal.example/form";
const origin = "https://portal.example";
const page = { url, text: "7 button Submit" };
const provider = () =>
  HostedBrowserProvider.make(
    {
      fetch: () => Promise.reject(new Error("Unexpected binding fetch")),
    },
    sdk,
  );

const reply = (method: string) => {
  switch (method) {
    case "Target.createTarget":
      return { targetId: "target" };
    case "Runtime.evaluate":
      return { result: { value: { url, ready: true } } };
    case "Page.getFrameTree":
      return { frameTree: { frame: { url } } };
    case "Accessibility.getFullAXTree":
      return {
        nodes: [{ backendDOMNodeId: 7, role: { value: "button" }, name: { value: "Submit" } }],
      };
    case "DOM.resolveNode":
      return { object: { objectId: "node" } };
    case "Runtime.callFunctionOn":
      return { result: { value: true } };
    case "Cloudflare.getHandoffState":
      return { active: false };
    case "Cloudflare.handoff":
      return { handoffId: "handoff" };
    case "Cloudflare.getLiveView":
      return { devtoolsFrontendUrl: "https://live.browser.run/ui/view?mode=tab&token=test" };
    default:
      return {};
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  sdk.send.mockImplementation((method) => Promise.resolve(reply(method)));
  sdk.deleteBrowserSession.mockResolvedValue(undefined);
});

describe("hosted browser provider", () => {
  it.effect("waits for a loaded document after navigation before exposing page evidence", () =>
    Effect.gen(function* () {
      let reads = 0;
      sdk.send.mockImplementation((method) => {
        if (method === "Runtime.evaluate") {
          reads += 1;
          return Promise.resolve({
            result: { value: { url: reads === 1 ? "about:blank" : url, ready: reads > 2 } },
          });
        }
        return Promise.resolve(reply(method));
      });
      const opening = yield* provider().open("session", url).pipe(Effect.forkChild);
      yield* TestClock.adjust("200 millis");
      expect(yield* Fiber.join(opening)).toEqual({ targetId: "target", page });
      expect(reads).toBe(3);
      expect(sdk.send.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(1);
      expect(sdk.disconnect).toHaveBeenCalledOnce();
    }),
  );

  it.effect("does not navigate when the browser rejects its network restrictions", () =>
    Effect.gen(function* () {
      sdk.send.mockImplementation((method) =>
        method === "Network.setBlockedURLs"
          ? Promise.reject(new Error("unsupported"))
          : Promise.resolve(reply(method)),
      );
      yield* Effect.flip(provider().open("session", url));
      expect(sdk.send.mock.calls.some(([method]) => method === "Page.navigate")).toBe(false);
      expect(sdk.disconnect).toHaveBeenCalledOnce();
    }),
  );

  it.effect("refuses a navigation error without treating the old page as an observation", () =>
    Effect.gen(function* () {
      sdk.send.mockImplementation((method) =>
        Promise.resolve(
          method === "Page.navigate" ? { errorText: "net::ERR_BLOCKED_BY_CLIENT" } : reply(method),
        ),
      );
      yield* Effect.flip(provider().open("session", url));
      expect(sdk.send.mock.calls.some(([method]) => method === "Accessibility.getFullAXTree")).toBe(
        false,
      );
    }),
  );

  it.effect("refuses an interaction after the document navigates outside its approved origin", () =>
    Effect.gen(function* () {
      sdk.send.mockImplementation((method) =>
        Promise.resolve(
          method === "Runtime.evaluate"
            ? { result: { value: { url: "https://other.example/form", ready: true } } }
            : reply(method),
        ),
      );
      yield* Effect.flip(
        provider().interact("session", "target", origin, page, { _tag: "Click", target: "7" }),
      );
      expect(sdk.send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(
        false,
      );
    }),
  );

  it.effect("does not dispatch when the retained target label has changed", () =>
    Effect.gen(function* () {
      const outcome = yield* provider().interact(
        "session",
        "target",
        origin,
        { ...page, text: "7 button Cancel" },
        { _tag: "Click", target: "7" },
      );
      expect(outcome).toEqual({ _tag: "Stale" });
      expect(sdk.send.mock.calls.some(([method]) => method === "Runtime.callFunctionOn")).toBe(
        false,
      );
    }),
  );

  it.effect("starts native handoff before issuing a tab view and retains its identity", () =>
    Effect.gen(function* () {
      expect(yield* provider().liveView("session", "target")).toEqual({
        url: "https://live.browser.run/ui/view?mode=tab&token=test",
        expiresInMs: 300_000,
        handoffId: "handoff",
      });
      expect(sdk.send.mock.calls.map(([method]) => method)).toEqual([
        "Cloudflare.getHandoffState",
        "Cloudflare.handoff",
        "Cloudflare.getLiveView",
      ]);
    }),
  );

  it.effect("recovers an active handoff without replacing it when a view response was lost", () =>
    Effect.gen(function* () {
      sdk.send.mockImplementation((method) =>
        Promise.resolve(
          method === "Cloudflare.getHandoffState"
            ? { active: true, handoffId: "retained-handoff" }
            : reply(method),
        ),
      );
      expect((yield* provider().liveView("session", "target")).handoffId).toBe("retained-handoff");
      expect(sdk.send.mock.calls.some(([method]) => method === "Cloudflare.handoff")).toBe(false);
      yield* Effect.flip(provider().resume("session", "target", "retained-handoff"));
      yield* Effect.flip(provider().observe("session", "target", origin));
      expect(sdk.send.mock.calls.some(([method]) => method === "Runtime.evaluate")).toBe(false);
    }),
  );

  it.effect("requires provider-confirmed inactive handoff state and rejects malformed state", () =>
    Effect.gen(function* () {
      yield* provider().resume("session", "target", "handoff");
      for (const state of [{}, { active: "false" }, { active: false, handoffId: "other" }]) {
        sdk.send.mockImplementation((method) =>
          Promise.resolve(method === "Cloudflare.getHandoffState" ? state : reply(method)),
        );
        yield* Effect.flip(provider().resume("session", "target", "handoff"));
      }
    }),
  );

  it.effect("accepts HTTP410 as deleted while preserving actual cleanup failures", () =>
    Effect.gen(function* () {
      sdk.deleteBrowserSession.mockRejectedValue(new sdk.BrowserRenderingError("gone", 410));
      yield* provider().close("session");
      sdk.deleteBrowserSession.mockRejectedValue(new sdk.BrowserRenderingError("failed", 503));
      yield* Effect.flip(provider().close("session"));
      expect(sdk.deleteBrowserSession).toHaveBeenCalledTimes(2);
    }),
  );
});
