import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { StreamCallback, TurnContext } from "@cloudflare/think";
import { describe, expect, it, vi } from "@effect/vitest";
import { getAgentByName, getSubAgentByName } from "agents";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { Effect, Exit, Schema } from "effect";

import {
  PRESENT_LINK_TOOL_NAME,
  boundedTranscriptWindow,
  companyAddressKey,
  CompanyAgent,
  makeInvitePresenter,
  planTeardown,
  presentationAwareCallback,
  replyToCompanyMessenger,
} from "../src/agents/osfo/company-agent";
import { OsfoAgent } from "../src/agents/osfo/agent";
import { OSFO_DIRECTORY_NAME } from "../src/agents/osfo/directory";
import { UserId } from "../src/domain";
import { launchModelAccessPolicy } from "../src/domain/model-access-policy";
import { ChannelLinks } from "../src/services/channel-links";

/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/global-random, eslint/no-underscore-dangle, typescript/no-unsafe-type-assertion -- Think delivery callbacks and Agent RPC are Promise boundaries, the tested contracts use JavaScript Dates, Effect tagged unions use `_tag`, and tests fabricate framework contexts. */

const address = ChannelLinks.ChannelAddress.make({
  authorId: ChannelLinks.ChannelAuthorId.make("company-author"),
  channelId: ChannelLinks.ChannelId.make("telegram"),
});

const emptyUsage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};

describe("Company Conversation envelope", () => {
  it("keeps teardown expiry-only with acceptance before idle deadlines", () => {
    // planTeardown consumes plain Dates; Effect Clock ownership starts at the facet boundary.
    const lastActivityAt = new Date("2026-08-21T12:00:00.000Z");
    const at = (hours: number) => new Date(lastActivityAt.getTime() + hours * 3_600_000);

    expect(planTeardown({ lastActivityAt, linked: true, now: at(1) })).toEqual({
      _tag: "Destroy",
    });
    expect(planTeardown({ lastActivityAt, linked: false, now: at(25) })).toEqual({
      _tag: "Destroy",
    });
    expect(planTeardown({ lastActivityAt, linked: false, now: at(2) })).toEqual({
      _tag: "Wait",
      at: at(6),
    });
    expect(planTeardown({ lastActivityAt, linked: false, now: at(7) })).toEqual({
      _tag: "Wait",
      at: at(12),
    });
    expect(planTeardown({ lastActivityAt, linked: false, now: at(19) })).toEqual({
      _tag: "Wait",
      at: at(24),
    });
    expect(planTeardown({ lastActivityAt, linked: null, now: at(2) })._tag).toBe("Wait");
  });

  it("bounds the transcript window on a user-message boundary", () => {
    const short = [{ role: "user" }, { role: "assistant" }];
    const long = [
      { role: "user" },
      { role: "assistant" },
      { role: "tool" },
      { role: "user" },
      { role: "assistant" },
    ];

    expect(boundedTranscriptWindow(short, 12)).toEqual(short);
    expect(boundedTranscriptWindow(long, 2)).toEqual([{ role: "user" }, { role: "assistant" }]);
  });

  it.effect("collapses duplicate presentation requests into one delivered line", () =>
    Effect.gen(function* () {
      let ensureCalls = 0;
      const hold: HoldCell = { current: null };
      const reply = makeStreamRecorder();
      const presenter = presenterOver({
        applyHold: (next) => {
          hold.current = next;
        },
        countEnsure: () => {
          ensureCalls += 1;
        },
        readHold: () => hold.current,
      });

      yield* Effect.promise(async () => {
        const stream = presentationAwareCallback(reply.callback, presenter);
        await stream.onStart({ requestId: "turn" });
        await stream.onEvent(delta("Want the link?"));
        presenter.request();
        presenter.request();
        await stream.onDone();
      });

      expect(ensureCalls).toBe(1);
      expect(hold.current?.url.href).toContain("/verify/");
      expect(reply.deltas().filter((line) => line.includes("/verify/"))).toHaveLength(1);
    }),
  );

  it.effect("delivers the link when inference fails after a presentation request", () =>
    Effect.gen(function* () {
      let ensureCalls = 0;
      const hold: HoldCell = { current: null };
      const reply = makeStreamRecorder();

      yield* Effect.promise(() =>
        replyToCompanyMessenger(
          reply.callback,
          messengerContext(),
          userMessage(),
          turnDependencies({
            ensure: () => {
              ensureCalls += 1;
              return invited();
            },
            readHeld: () => hold.current,
            runModelTurn: async (turn) => {
              turn.presenter.request();
              throw new Error("provider exploded mid-turn");
            },
            writeHeld: (next) => {
              hold.current = next;
            },
          }),
        ),
      );

      expect(ensureCalls).toBe(1);
      expect(reply.terminal()).toBe("done");
      expect(reply.text()).toContain("https://osfo.test/verify/");
    }),
  );

  it.effect("never invents a link when inference fails without a request", () =>
    Effect.gen(function* () {
      let activityWrites = 0;
      let ensureCalls = 0;
      const reply = makeStreamRecorder();

      let rejected = false;
      yield* Effect.promise(() =>
        replyToCompanyMessenger(
          reply.callback,
          messengerContext(),
          userMessage(),
          turnDependencies({
            ensure: () => {
              ensureCalls += 1;
              return invited();
            },
            recordActivity: () => {
              activityWrites += 1;
              return Promise.resolve();
            },
            runModelTurn: () => Promise.reject(new Error("provider exploded")),
          }),
        ).catch(() => {
          rejected = true;
        }),
      );

      expect(rejected).toBe(true);
      expect(activityWrites).toBe(1);
      expect(ensureCalls).toBe(0);
      expect(reply.events).toHaveLength(0);
    }),
  );

  it.effect("resends the held unexpired invite without minting again", () =>
    Effect.gen(function* () {
      let ensureCalls = 0;
      const held = {
        expiresAtMs: Date.now() + 60_000,
        url: new URL("https://osfo.test/verify/held-token"),
      };
      const reply = makeStreamRecorder();

      yield* Effect.promise(async () => {
        const presenter = presenterOver({
          countEnsure: () => {
            ensureCalls += 1;
          },
          readHold: () => held,
        });
        const stream = presentationAwareCallback(reply.callback, presenter);
        await stream.onStart({ requestId: "turn" });
        await stream.onEvent(delta("Here you go:"));
        presenter.request();
        await stream.onDone();
      });

      expect(ensureCalls).toBe(0);
      expect(reply.text()).toContain("https://osfo.test/verify/held-token");
    }),
  );

  it.effect("answers a won linking race with fixed copy and no URL", () =>
    Effect.gen(function* () {
      const reply = makeStreamRecorder();

      const linkedOutcome: Exit.Exit<ChannelLinks.EnsureResult, unknown> = Exit.succeed({
        _tag: "Linked",
        link: ChannelLinks.ChannelLink.make({
          address,
          channelLinkId: ChannelLinks.ChannelLinkId.make("channel-link-race"),
          createdAt: new Date("2026-08-21T12:00:00.000Z"),
          revokedAt: null,
          userId: raceTestUserId(),
        }),
      });
      yield* presentOnce(reply, () => Promise.resolve(linkedOutcome));

      expect(reply.text()).toContain("This channel is linked");
      expect(reply.text()).not.toContain("/verify/");
    }),
  );

  it.effect("answers an unreadable invite authority without exposing any URL", () =>
    Effect.gen(function* () {
      const reply = makeStreamRecorder();

      yield* presentOnce(reply, () => Promise.resolve(Exit.die(new Error("pg down"))));

      expect(reply.text()).toContain("could not prepare");
      expect(reply.text()).not.toContain("/verify/");
    }),
  );

  it.effect("skips inference entirely for already received provider events", () =>
    Effect.gen(function* () {
      let activityWrites = 0;
      let modelTurns = 0;
      const reply = makeStreamRecorder();

      yield* Effect.promise(() =>
        replyToCompanyMessenger(
          reply.callback,
          messengerContext(),
          userMessage(),
          turnDependencies({
            readReceipt: () => Promise.resolve("completed"),
            recordActivity: () => {
              activityWrites += 1;
              return Promise.resolve();
            },
            runModelTurn: () => {
              modelTurns += 1;
              return Promise.resolve();
            },
          }),
        ),
      );

      expect(activityWrites).toBe(0);
      expect(modelTurns).toBe(0);
      expect(reply.events).toHaveLength(0);
    }),
  );

  it.effect("stops at the daily ceiling with deterministic copy and no model turn", () =>
    Effect.gen(function* () {
      let modelTurns = 0;
      const receipts: Array<string> = [];
      const reply = makeStreamRecorder();

      yield* Effect.promise(() =>
        replyToCompanyMessenger(
          reply.callback,
          messengerContext(),
          userMessage(),
          turnDependencies({
            dailyTurnLimit: 5,
            runModelTurn: () => {
              modelTurns += 1;
              return Promise.resolve();
            },
            turnsToday: () => Promise.resolve(5),
            writeReceipt: (_eventId, status) => {
              receipts.push(status);
              return Promise.resolve();
            },
          }),
        ),
      );

      expect(modelTurns).toBe(0);
      expect(receipts).toEqual(["completed"]);
      expect(reply.text()).toContain("message limit for today");
    }),
  );
});

describe("Company Conversation facet surface", () => {
  it("shares Osfo identity across the company and personal partitions", () => {
    const companyPrompt = CompanyAgent.prototype.getSystemPrompt();
    const personalPrompt = OsfoAgent.prototype.getSystemPrompt();

    expect(companyPrompt).toContain("You are Osfo, a personal AI agent");
    expect(personalPrompt).toContain("You are Osfo, a personal AI agent");
    expect(companyPrompt).toContain("before someone registers");
    expect(personalPrompt).toContain("registered, private Osfo Agent");
  });

  it.effect("exposes only the presentation capability to its model", () =>
    Effect.gen(function* () {
      const agent = env.COMPANY_AGENT_TEST_FACET.getByName("company-surface-check");

      const tools = yield* Effect.promise(() =>
        runInDurableObject(agent, (instance) => instance.getTools()),
      );
      const turnOutcome = yield* Effect.promise(() =>
        runInDurableObject(agent, (instance) =>
          Promise.resolve(instance.beforeTurn(fabricatedTurnContext())),
        ),
      );
      const systemPrompt = yield* Effect.promise(() =>
        runInDurableObject(agent, (instance) => Promise.resolve(instance.getSystemPrompt())),
      );
      const modelRoute = yield* Effect.promise(() =>
        runInDurableObject(agent, (instance) => Promise.resolve(instance.getModel())),
      );
      const turnConfig = turnOutcome ?? {};

      expect(Object.keys(tools)).toEqual([PRESENT_LINK_TOOL_NAME]);
      expect(turnConfig.activeTools).toEqual([PRESENT_LINK_TOOL_NAME]);
      expect(turnConfig.messages).toHaveLength(2);
      expect(systemPrompt).toContain(PRESENT_LINK_TOOL_NAME);
      expect(systemPrompt).toContain("Never claim this person is registered or linked.");
      expect(systemPrompt).not.toContain("/verify/");
      expect(modelRoute).toBe(launchModelAccessPolicy.plans.free.route);
    }),
  );

  // Live clock: the teardown poll sleeps real time while destruction lands.
  it.live("destroys itself when its lifecycle state is missing", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        getAgentByName(env.OSFO_DIRECTORY, OSFO_DIRECTORY_NAME),
      );
      const key = yield* Effect.promise(() => companyAddressKey("telegram", "teardown-author"));
      yield* Effect.promise(() => directory.ensureCompanyConversation(key));
      const facet = yield* Effect.promise(() => getSubAgentByName(directory, CompanyAgent, key));

      // The sub-agent stub proxies into the facet; destruction aborts the
      // isolate mid-call by design, so a rejected RPC still means teardown ran.
      yield* Effect.promise(() => facet.expireCompanyConversation().catch(() => undefined));

      const registryHasFacet = async () => {
        try {
          return await directory.hasSubAgent(CompanyAgent.name, key);
        } catch {
          return true;
        }
      };
      let removed = !(yield* Effect.promise(registryHasFacet));
      for (let attempt = 0; attempt < 20 && !removed; attempt += 1) {
        yield* Effect.sleep("50 millis");
        removed = !(yield* Effect.promise(registryHasFacet));
      }
      expect(removed).toBe(true);
    }),
  );

  it.effect("records activity from a serialized messenger snapshot", () =>
    Effect.gen(function* () {
      const agent = env.COMPANY_AGENT_TEST_FACET.getByName("company-snapshot-activity");
      const reply = makeStreamRecorder();
      const observed = yield* Effect.promise(() =>
        runInDurableObject(agent, async (instance) => {
          const model = new MockLanguageModelV3({
            provider: "osfo-test",
            modelId: "company-snapshot-activity",
            doGenerate: async () => ({
              content: [{ text: "Hello", type: "text" }],
              finishReason: { raw: "stop", unified: "stop" },
              usage: emptyUsage,
              warnings: [],
            }),
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { id: "answer", type: "text-start" },
                  { delta: "Hello", id: "answer", type: "text-delta" },
                  { id: "answer", type: "text-end" },
                  {
                    finishReason: { raw: "stop", unified: "stop" },
                    type: "finish",
                    usage: emptyUsage,
                  },
                ],
                chunkDelayInMs: null,
                initialDelayInMs: null,
              }),
            }),
          });
          vi.spyOn(instance, "resolveModel").mockReturnValue(model);
          await instance.onStart();
          await instance.chatWithMessengerContext(
            "hello",
            reply.callback,
            serializedMessengerContext(),
          );
          await instance.chatWithMessengerContext(
            "hello again",
            reply.callback,
            serializedMessengerContext("company-message-2"),
          );
          return {
            config: instance.getConfig<unknown>(),
            messages: instance.messages,
            schedules: (await instance.listSchedules()).map(({ callback, type }) => ({
              callback,
              type,
            })),
          };
        }),
      );

      expect(observed.config).toMatchObject({
        addressAuthorId: "company-author",
        addressChannelId: "telegram",
      });
      expect(observed.schedules).toContainEqual({
        callback: "expireCompanyConversation",
        type: "scheduled",
      });
      expect(
        observed.schedules.filter(({ callback }) => callback === "expireCompanyConversation"),
      ).toHaveLength(1);
      const transcript = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        observed.messages,
      );
      expect(transcript).toContain("hello");
      expect(transcript).not.toContain("/verify/");
    }),
  );
});

interface HeldSnapshot {
  readonly expiresAtMs: number;
  readonly url: URL;
}

/** Mutable test cell so closures can observe holds without narrowing tricks. */
interface HoldCell {
  current: HeldSnapshot | null;
}

const invited = async (): Promise<Exit.Exit<ChannelLinks.EnsureResult, unknown>> =>
  Exit.succeed({
    _tag: "Invited",
    expiresAt: new Date(Date.now() + 600_000),
    verificationUrl: new URL(`https://osfo.test/verify/presented-${Math.random()}`),
  });

type CompanyTurnDependencies = Parameters<typeof replyToCompanyMessenger>[3];

const turnDependencies = (
  overrides: Partial<CompanyTurnDependencies> = {},
): CompanyTurnDependencies => ({
  dailyTurnLimit: null,
  ensure: () => invited(),
  readHeld: () => null,
  readReceipt: () => Promise.resolve(null),
  recordActivity: () => Promise.resolve(),
  recordTurn: () => Promise.resolve(),
  runModelTurn: () => Promise.resolve(),
  turnsToday: () => Promise.resolve(0),
  writeHeld: () => undefined,
  writeReceipt: () => Promise.resolve(),
  ...overrides,
});

const presenterOver = (options: {
  readonly applyHold?: (held: HeldSnapshot | null) => void;
  readonly countEnsure?: () => void;
  readonly readHold: () => HeldSnapshot | null;
}) =>
  makeInvitePresenter({
    address,
    ensure: () => {
      options.countEnsure?.();
      return invited();
    },
    readHeld: options.readHold,
    requestId: "presenter-request",
    writeHeld: (held) => options.applyHold?.(held),
  });

const presentOnce = (
  reply: ReturnType<typeof makeStreamRecorder>,
  customEnsure: () => Promise<Exit.Exit<ChannelLinks.EnsureResult, unknown>>,
) =>
  Effect.promise(async () => {
    let held: HeldSnapshot | null = null;
    const presenter = makeInvitePresenter({
      address,
      ensure: customEnsure,
      readHeld: () => held,
      requestId: "presenter-request",
      writeHeld: (next) => {
        held = next;
      },
    });
    const stream = presentationAwareCallback(reply.callback, presenter);
    await stream.onStart({ requestId: "turn" });
    await stream.onEvent(delta("One sec:"));
    presenter.request();
    await stream.onDone();
  });

const makeStreamRecorder = () => {
  const events: Array<string> = [];
  let terminal: string | undefined;
  const deltas = (): Array<string> =>
    events.flatMap((event) => {
      try {
        return [String(JSON.parse(event).delta)];
      } catch {
        return [];
      }
    });
  const callback = {
    onDone: () => {
      terminal = "done";
    },
    onError: () => {
      terminal = "error";
    },
    onEvent: (event: string) => {
      events.push(event);
    },
    onStart: () => undefined,
  } satisfies StreamCallback;
  return {
    callback,
    deltas,
    events,
    terminal: () => terminal,
    text: () => deltas().join("\n"),
  };
};

const delta = (text: string) => JSON.stringify({ delta: text, type: "text-delta" });

const raceTestUserId = () => Schema.decodeSync(UserId)("company-user-race");

// SAFETY: tests only exercise fields the gate and receipt logic read; the full MessengerContext carries optional transport fields we do not model.
const messengerContext = (): Parameters<typeof replyToCompanyMessenger>[1] =>
  ({
    author: { userId: "company-author" },
    capabilities: {},
    kind: "direct-message",
    message: {
      attachments: [],
      author: { userId: "company-author" },
      id: "company-message-1",
      providerMessageId: "company-message-1",
      text: "hello",
    },
    messengerId: "telegram",
    provider: "telegram",
    thread: {
      id: "company-thread-1",
      isDirectMessage: true,
      providerThreadId: "company-thread-1",
    },
  }) as never;

const serializedMessengerContext = (
  eventId = "company-message-1",
): Parameters<typeof replyToCompanyMessenger>[1] => {
  const context = messengerContext();
  const { author: _author, ...serialized } = context;
  if (serialized.message === undefined) return serialized;
  return {
    ...serialized,
    message: { ...serialized.message, id: eventId, providerMessageId: eventId },
  };
};

const userMessage = (): string => "hello";

// SAFETY: beforeTurn reads only messages/system/tools/model shape; Think owns richer internal fields the test does not fabricate.
const fabricatedTurnContext = (): TurnContext =>
  ({
    continuation: false,
    messages: [
      { content: "hi", role: "user" },
      { content: "hello", role: "assistant" },
    ],
    model: {},
    system: "",
    tools: {},
  }) as TurnContext;
