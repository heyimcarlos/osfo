/* oxlint-disable eslint/no-underscore-dangle -- Assertions use the canonical Effect outcome tag. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { executeBrowserInventory, makeBrowserTools } from "../agents/osfo/browser-tools";
import { CapabilityCatalogVersion, ThinkSubmissionId, UserId } from "../domain";
import { Browser } from "./browser-host";
import { Capabilities } from "./capabilities";

const userId = UserId.make("browser-owner");
const turnId = ThinkSubmissionId.make("browser-turn");
const binding: Browser.Binding = {
  hostSessionId: "hosted-agent",
  ownerUserId: userId,
};
const inspection = { operationId: "inventory-call", turnId, userId };

describe("managed browser inventory", () => {
  it.effect("fails closed before admission or transport for a missing host or another owner", () =>
    Effect.gen(function* () {
      for (const configured of [null, { ...binding, ownerUserId: "another-owner" }]) {
        const browser = Browser.make({
          binding: () => configured,
          authorize: () => Effect.die(new Error("unexpected admission")),
          dispatch: () => Effect.die(new Error("unexpected dispatch")),
        });
        expect((yield* Effect.flip(browser.inspect(inspection)))._tag).toBe("BrowserUnavailable");
      }
    }),
  );

  it.effect(
    "admits the current authenticated turn before dispatch and rejects a different response identity",
    () =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        const browser = Browser.make({
          binding: () => binding,
          authorize: () =>
            Effect.sync(() => {
              events.push("admit");
            }),
          dispatch: (request) =>
            Effect.sync(() => {
              events.push("dispatch");
              return {
                request: { ...request, turnId: "different-turn" },
                outcome: { _tag: "Observed", browsers: [], observedAt: 1 },
              };
            }),
        });
        expect((yield* Effect.flip(browser.inspect(inspection)))._tag).toBe("BrowserUnavailable");
        expect(events).toEqual(["admit", "dispatch"]);
      }),
  );

  it.effect("selects the real Tool only when the owner-bound availability fact is present", () =>
    Effect.gen(function* () {
      const capabilities = Capabilities.make();
      const tools = makeBrowserTools({
        browser: Browser.make({
          binding: () => null,
          authorize: () => Effect.void,
          dispatch: () => Effect.die(new Error("unexpected dispatch")),
        }),
        readActiveTurn: () => undefined,
      });
      for (const available of [false, true]) {
        const availableToolNames = Object.keys(tools);
        const index = yield* capabilities.eligibleIndex({
          availableIntegrationToolkits: [],
          availableRequirements: available
            ? ["browser-host", "personal-agent"]
            : ["personal-agent"],
          availableToolNames,
          catalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
          declaredRequirements: [],
          origin: "authSession",
          personalSkills: [],
          plan: "free",
          taskDescription: "Show my browser inventory",
          taskKinds: ["web"],
          userId,
        });
        const bundle = capabilities.assembleToolBundle({
          availableToolNames,
          index,
          loadedSkills: [],
        });
        expect(bundle.activeToolNames).toEqual(available ? ["inspectBrowserInventory"] : []);
      }
    }),
  );

  it.effect(
    "takes tool identity from active metadata and preserves approval-required without retry",
    () =>
      Effect.gen(function* () {
        const received: Array<Browser.Inspection> = [];
        const outcome = yield* Effect.promise(() =>
          executeBrowserInventory(
            {
              readActiveTurn: () => ({ authorityIdentity: { userId }, submissionId: turnId }),
              browser: {
                inspect: (request) =>
                  Effect.sync(() => {
                    received.push(request);
                    return { _tag: "ApprovalRequired" } as const;
                  }),
              },
            },
            "inventory-call",
          ),
        );
        expect(outcome).toEqual({ _tag: "ApprovalRequired" });
        expect(received).toEqual([inspection]);
      }),
  );
});
