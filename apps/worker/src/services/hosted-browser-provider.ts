/* oxlint-disable eslint/no-underscore-dangle -- Browser outcomes use the canonical wire discriminator. */
import type {
  BrowserBinding,
  BrowserRenderingError,
  CdpSession,
  createBrowserSession,
  deleteBrowserSession,
} from "agents/browser";
import { Effect, Schedule, Schema } from "effect";
import type { BrowserInteraction } from "@osfo/api/browser-host";

type Connection = Pick<CdpSession, "send" | "attachToTarget" | "disconnect">;
interface NativeBrowser {
  readonly createBrowserSession: typeof createBrowserSession;
  readonly deleteBrowserSession: typeof deleteBrowserSession;
  readonly BrowserRenderingError: typeof BrowserRenderingError;
  readonly connectBrowserSession: (
    browser: BrowserBinding,
    sessionId: string,
    timeoutMs?: number,
  ) => Promise<Connection>;
}

export class Unavailable extends Schema.TaggedError<Unavailable>()("HostedBrowserUnavailable", {
  message: Schema.String,
}) {}
export const unavailable = () =>
  new Unavailable({ message: "The hosted browser operation could not be confirmed." });
export const Page = Schema.Struct({ url: Schema.String, text: Schema.String });
export type Page = typeof Page.Type;
export interface Provider {
  readonly create: Effect.Effect<string, Unavailable>;
  readonly open: (
    sessionId: string,
    url: string,
  ) => Effect.Effect<{ readonly targetId: string; readonly page: Page }, Unavailable>;
  readonly observe: (
    sessionId: string,
    targetId: string,
    origin: string,
  ) => Effect.Effect<Page, Unavailable>;
  readonly interact: (
    sessionId: string,
    targetId: string,
    origin: string,
    expected: Page,
    interaction: BrowserInteraction,
  ) => Effect.Effect<Page | { readonly _tag: "Stale" }, Unavailable>;
  readonly close: (sessionId: string) => Effect.Effect<void, Unavailable>;
  readonly liveView: (
    sessionId: string,
    targetId: string,
  ) => Effect.Effect<
    { readonly url: string; readonly expiresInMs: number; readonly handoffId: string },
    Unavailable
  >;
  readonly resume: (
    sessionId: string,
    targetId: string,
    handoffId: string,
  ) => Effect.Effect<void, Unavailable>;
}
const boundary = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable });
// oxlint-disable-next-line osfo/no-unknown-parameters -- This is the decoder for untrusted CDP responses.
const decode = <A>(schema: Schema.Codec<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(unavailable));
const Target = Schema.Struct({ targetId: Schema.String });
const FrameTree = Schema.Struct({
  frameTree: Schema.Struct({ frame: Schema.Struct({ url: Schema.String }) }),
});
const AxValue = Schema.Struct({
  value: Schema.optional(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
});
const AxTree = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      ignored: Schema.optional(Schema.Boolean),
      backendDOMNodeId: Schema.optional(Schema.Int),
      role: Schema.optional(AxValue),
      name: Schema.optional(AxValue),
      value: Schema.optional(AxValue),
      properties: Schema.optional(
        Schema.Array(Schema.Struct({ name: Schema.String, value: AxValue })),
      ),
    }),
  ),
});
const Resolved = Schema.Struct({ object: Schema.Struct({ objectId: Schema.String }) });
const Called = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Boolean) }),
  exceptionDetails: Schema.optional(Schema.Unknown),
});
const Handoff = Schema.Struct({ handoffId: Schema.NonEmptyString });
const HandoffState = Schema.Struct({
  active: Schema.Boolean,
  handoffId: Schema.optionalKey(Schema.NonEmptyString),
});
const LiveView = Schema.Struct({ devtoolsFrontendUrl: Schema.String });
const Navigation = Schema.Struct({ errorText: Schema.optionalKey(Schema.String) });
const Ready = Schema.Struct({
  result: Schema.Struct({
    value: Schema.Struct({ url: Schema.String, ready: Schema.Boolean }),
  }),
});
class PageLoading extends Schema.TaggedError<PageLoading>()("HostedBrowserPageLoading", {}) {}
class SessionAbsent extends Schema.TaggedError<SessionAbsent>()("HostedBrowserSessionAbsent", {}) {}

/** Managed sessions and fixed CDP commands; no caller-supplied JavaScript reaches the browser. */
export const make = (browser: BrowserBinding, native?: NativeBrowser): Provider => {
  const sdk: Effect.Effect<NativeBrowser, Unavailable> =
    native === undefined ? boundary(() => import("agents/browser")) : Effect.succeed(native);
  const connect = (sessionId: string) =>
    sdk.pipe(
      Effect.flatMap((runtime) =>
        boundary(() => runtime.connectBrowserSession(browser, sessionId, 10_000)),
      ),
    );
  const withTarget = <A>(
    sessionId: string,
    targetId: string,
    use: (cdp: Connection, attached: string) => Effect.Effect<A, Unavailable>,
  ) =>
    Effect.acquireUseRelease(
      connect(sessionId),
      (cdp) =>
        boundary(() => cdp.attachToTarget(targetId)).pipe(
          Effect.flatMap((attached) => use(cdp, attached)),
        ),
      (cdp) => Effect.sync(() => cdp.disconnect()),
    );
  return {
    create: sdk.pipe(
      Effect.flatMap((runtime) =>
        boundary(() => runtime.createBrowserSession(browser, { keepAliveMs: 600_000 })),
      ),
      Effect.map((session) => session.sessionId),
    ),
    open: Effect.fn("HostedBrowserProvider.open")(function* (sessionId, url) {
      return yield* Effect.acquireUseRelease(
        connect(sessionId),
        (cdp) =>
          Effect.gen(function* () {
            const created = yield* boundary(() =>
              cdp.send("Target.createTarget", { url: "about:blank" }),
            ).pipe(Effect.flatMap((raw) => decode(Target, raw)));
            const attached = yield* boundary(() => cdp.attachToTarget(created.targetId));
            yield* boundary(() => cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }));
            yield* restrictNetwork(cdp, attached);
            const navigation = yield* boundary(() =>
              cdp.send("Page.navigate", { url }, { sessionId: attached }),
            ).pipe(Effect.flatMap((raw) => decode(Navigation, raw)));
            if (navigation.errorText !== undefined) return yield* unavailable();
            const page = yield* observe(cdp, attached, new URL(url).origin);
            return { targetId: created.targetId, page };
          }),
        (cdp) => Effect.sync(() => cdp.disconnect()),
      );
    }),
    observe: (sessionId, targetId, origin) =>
      withTarget(sessionId, targetId, (cdp, attached) =>
        ensureAutomation(cdp, attached).pipe(
          Effect.andThen(restrictNetwork(cdp, attached)),
          Effect.andThen(observe(cdp, attached, origin)),
        ),
      ),
    interact: Effect.fn("HostedBrowserProvider.interact")(
      function* (sessionId, targetId, origin, expected, interaction) {
        return yield* withTarget(sessionId, targetId, (cdp, attached) =>
          Effect.gen(function* () {
            yield* ensureAutomation(cdp, attached);
            yield* restrictNetwork(cdp, attached);
            const page = yield* observe(cdp, attached, origin);
            if (
              page.url !== expected.url ||
              page.text !== expected.text ||
              !/^\d+$/.test(interaction.target) ||
              !Number.isSafeInteger(Number(interaction.target)) ||
              !page.text.split("\n").some((line) => line.startsWith(`${interaction.target} `))
            )
              return { _tag: "Stale" } as const;
            const resolved = yield* boundary(() =>
              cdp.send(
                "DOM.resolveNode",
                { backendNodeId: Number(interaction.target) },
                { sessionId: attached },
              ),
            ).pipe(Effect.flatMap((raw) => decode(Resolved, raw)));
            const result = yield* boundary(() =>
              cdp.send(
                "Runtime.callFunctionOn",
                {
                  objectId: resolved.object.objectId,
                  functionDeclaration:
                    interaction._tag === "Click" ? clickElement : setElementValue,
                  arguments:
                    interaction._tag === "Click"
                      ? []
                      : [{ value: interaction.value }, { value: interaction._tag === "Select" }],
                  returnByValue: true,
                  userGesture: true,
                },
                { sessionId: attached },
              ),
            ).pipe(Effect.flatMap((raw) => decode(Called, raw)));
            if (result.exceptionDetails !== undefined || result.result.value !== true)
              return yield* unavailable();
            return yield* observe(cdp, attached, origin);
          }),
        );
      },
    ),
    close: Effect.fn("HostedBrowserProvider.close")(function* (sessionId) {
      const runtime = yield* sdk;
      yield* Effect.tryPromise({
        try: () => runtime.deleteBrowserSession(browser, sessionId),
        catch: (error) =>
          error instanceof runtime.BrowserRenderingError && error.status === 410
            ? new SessionAbsent()
            : unavailable(),
      }).pipe(Effect.catchTag("HostedBrowserSessionAbsent", () => Effect.void));
    }),
    liveView: Effect.fn("HostedBrowserProvider.liveView")(function* (sessionId, targetId) {
      return yield* withTarget(sessionId, targetId, (cdp, attached) =>
        Effect.gen(function* () {
          const state = yield* handoffState(cdp, attached);
          const handoff = state.active
            ? yield* decode(Handoff, state)
            : yield* boundary(() =>
                cdp.send(
                  "Cloudflare.handoff",
                  {
                    instructions:
                      "Complete your step, then choose Done to return control to Osfo. Osfo will read the page again before continuing.",
                  },
                  { sessionId: attached },
                ),
              ).pipe(Effect.flatMap((raw) => decode(Handoff, raw)));
          const view = yield* boundary(() =>
            cdp.send(
              "Cloudflare.getLiveView",
              { mode: "tab", expiresInMs: 300_000 },
              { sessionId: attached },
            ),
          ).pipe(Effect.flatMap((raw) => decode(LiveView, raw)));
          const url = URL.parse(view.devtoolsFrontendUrl);
          if (url === null || url.protocol !== "https:" || url.hostname !== "live.browser.run")
            return yield* unavailable();
          return { url: url.href, expiresInMs: 300_000, handoffId: handoff.handoffId };
        }),
      );
    }),
    resume: Effect.fn("HostedBrowserProvider.resume")(function* (sessionId, targetId, handoffId) {
      return yield* withTarget(sessionId, targetId, (cdp, attached) =>
        Effect.gen(function* () {
          const state = yield* handoffState(cdp, attached);
          if (
            handoffId.length === 0 ||
            state.active ||
            (state.handoffId !== undefined && state.handoffId !== handoffId)
          )
            return yield* unavailable();
          return undefined;
        }),
      );
    }),
  };
};

const observe = Effect.fn("HostedBrowserProvider.observe")(function* (
  cdp: Connection,
  attached: string,
  origin: string,
) {
  // Page.navigate acknowledges navigation before the new document is ready.
  yield* Effect.gen(function* () {
    const state = yield* boundary(() =>
      cdp.send(
        "Runtime.evaluate",
        {
          expression:
            '({ url: location.href, ready: document.readyState === "complete" && document.body !== null })',
          returnByValue: true,
        },
        { sessionId: attached },
      ),
    ).pipe(Effect.flatMap((raw) => decode(Ready, raw)));
    if (state.result.value.url === "about:blank") return yield* new PageLoading();
    if (!matchesOrigin(state.result.value.url, origin)) return yield* unavailable();
    if (!state.result.value.ready) return yield* new PageLoading();
    return undefined;
  }).pipe(
    Effect.retry({
      while: Schema.is(PageLoading),
      schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 100 })),
    }),
    Effect.mapError(unavailable),
  );
  const frames = yield* boundary(() =>
    cdp.send("Page.getFrameTree", {}, { sessionId: attached }),
  ).pipe(Effect.flatMap((raw) => decode(FrameTree, raw)));
  const url = URL.parse(frames.frameTree.frame.url);
  if (url === null || !matchesOrigin(url.href, origin)) return yield* unavailable();
  const tree = yield* boundary(() =>
    cdp.send("Accessibility.getFullAXTree", {}, { sessionId: attached }),
  ).pipe(Effect.flatMap((raw) => decode(AxTree, raw)));
  const text = tree.nodes
    .filter((node) => !node.ignored && node.backendDOMNodeId !== undefined)
    .map((node) => {
      const protectedValue = node.properties?.some(
        (property) => property.name === "protected" && property.value.value === true,
      );
      return `${node.backendDOMNodeId} ${node.role?.value ?? "element"} ${node.name?.value ?? ""}${protectedValue || node.value?.value === undefined ? "" : ` ${node.value.value}`}`
        .replace(/[\r\n]+/g, " ")
        .trimEnd();
    })
    .join("\n");
  if (text.length === 0 || text.length > 48_000) return yield* unavailable();
  return { url: url.href, text };
});

const handoffState = (cdp: Connection, attached: string) =>
  boundary(() => cdp.send("Cloudflare.getHandoffState", {}, { sessionId: attached })).pipe(
    Effect.flatMap((raw) => decode(HandoffState, raw)),
  );

const ensureAutomation = Effect.fn("HostedBrowserProvider.ensureAutomation")(function* (
  cdp: Connection,
  attached: string,
) {
  if ((yield* handoffState(cdp, attached)).active) return yield* unavailable();
  return undefined;
});

const matchesOrigin = (value: string, origin: string) => {
  const url = URL.parse(value);
  return url !== null && url.origin === origin && url.username === "" && url.password === "";
};

const restrictNetwork = Effect.fn("HostedBrowserProvider.restrictNetwork")(function* (
  cdp: Connection,
  attached: string,
) {
  yield* boundary(() => cdp.send("Network.enable", {}, { sessionId: attached }));
  // Keep public CDN resources usable. These CDP rules reject literal private destinations,
  // including redirects; document origin is checked separately before every interaction.
  yield* boundary(() =>
    cdp.send(
      "Network.setBlockedURLs",
      {
        urls: [
          "http://*",
          "file://*",
          "ftp://*",
          "*://[*",
          ...["localhost", "local", "internal"]
            .flatMap((host) => [host, `${host}.`])
            .flatMap((host) => [
              `*://${host}/*`,
              `*://${host}:*/*`,
              `*://*.${host}/*`,
              `*://*.${host}:*/*`,
            ]),
          ...[
            "0.*",
            "10.*",
            "127.*",
            "169.254.*",
            "192.168.*",
            ...Array.from({ length: 16 }, (_, index) => `172.${index + 16}.*`),
            ...Array.from({ length: 64 }, (_, index) => `100.${index + 64}.*`),
          ].map((host) => `*://${host}/*`),
        ],
      },
      { sessionId: attached },
    ),
  );
});

const clickElement = `function() {
  if (!(this instanceof HTMLElement) || !this.isConnected || this.closest('[inert]') || this.matches(':disabled')) return false;
  this.click();
  return true;
}`;
const setElementValue = `function(value, select) {
  if (!this.isConnected || this.closest('[inert]') || this.matches(':disabled')) return false;
  if (select) {
    if (!(this instanceof HTMLSelectElement) || !Array.from(this.options).some(option => option.value === value && !option.disabled)) return false;
  } else if (!(this instanceof HTMLInputElement) && !(this instanceof HTMLTextAreaElement)) return false;
  if (this instanceof HTMLInputElement && ['file', 'password', 'hidden'].includes(this.type)) return false;
  const prototype = this instanceof HTMLSelectElement ? HTMLSelectElement.prototype : this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

export * as HostedBrowserProvider from "./hosted-browser-provider";
