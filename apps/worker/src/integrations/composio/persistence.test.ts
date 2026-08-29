/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Assertions inspect tagged outcomes inside the Effect returned directly to it.effect. */
/* oxlint-disable typescript/no-unsafe-type-assertion, osfo/no-chained-type-assertions -- The test stub implements the exact DurableObjectStorage members exercised by this adapter. */
/* oxlint-disable osfo/no-object-parameters -- The generic DurableObjectStorage test double retains opaque encoded values without inspecting them. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ActionId } from "../../domain/action-execution";
import { ManifestVersion } from "../../domain";
import { make } from "./persistence";

describe("Composio persistence", () => {
  it.effect("retains and replays every current protected integration effect", () =>
    Effect.gen(function* () {
      const persistence = make(makeStorage());
      const effects = [
        ["gmail-v1", "GMAIL_SEND_EMAIL", "gmail"],
        ["calendar-v1", "CALENDAR_CREATE_EVENT", "googlecalendar"],
        ["calendar-v1", "CALENDAR_UPDATE_EVENT", "googlecalendar"],
        ["calendar-v1", "CALENDAR_DELETE_EVENT", "googlecalendar"],
        ["drive-v1", "DRIVE_DELIVER_ARTIFACT", "googledrive"],
      ] as const;

      for (const [index, [manifestVersion, operation, toolkit]] of effects.entries()) {
        const actionId = ActionId.make(`action-${index}`);
        const retained = {
          _tag: "Applied" as const,
          digest: `${index}`.repeat(64),
          result: {
            _tag: "IntegrationEffectCompleted" as const,
            evidence: {
              providerLogId: `provider-log-${index}`,
              providerResourceId: `provider-resource-${index}`,
            },
            manifestVersion: ManifestVersion.make(manifestVersion),
            mutations: 1 as const,
            operation,
            toolkit,
          },
        };

        yield* persistence.retainAction(actionId, retained);
        expect(yield* persistence.readAction(actionId)).toEqual(retained);
      }
    }),
  );

  it.effect(
    "allows only one Action to claim a provider execution under concurrent settlement",
    () =>
      Effect.gen(function* () {
        const persistence = make(makeStorage());
        const firstActionId = ActionId.make("concurrent-action-1");
        const secondActionId = ActionId.make("concurrent-action-2");
        const firstDigest = "1".repeat(64);
        const secondDigest = "2".repeat(64);
        const correlation = {
          connectedAccountId: "private-account",
          providerRequestId: "attempt-request",
          providerSessionId: "provider-session",
          providerTool: "GMAIL_SEND_EMAIL",
          startedAt: 1_000,
        } as const;
        yield* persistence.retainAction(firstActionId, {
          _tag: "Ambiguous",
          correlation,
          digest: firstDigest,
        });
        yield* persistence.retainAction(secondActionId, {
          _tag: "Ambiguous",
          correlation: { ...correlation, providerRequestId: "later-attempt-request" },
          digest: secondDigest,
        });
        const settled = yield* Effect.all(
          [
            persistence.settleAction(firstActionId, "attempt-request", resultFor(firstDigest)),
            persistence.settleAction(
              secondActionId,
              "later-attempt-request",
              resultFor(secondDigest),
            ),
          ],
          { concurrency: "unbounded" },
        );

        expect(settled.filter((action) => action._tag === "Applied")).toHaveLength(1);
        expect(settled.filter((action) => action._tag === "Ambiguous")).toHaveLength(1);
        const retained = yield* Effect.all([
          persistence.readAction(firstActionId),
          persistence.readAction(secondActionId),
        ]);
        expect(retained.filter((action) => action?._tag === "Applied")).toHaveLength(1);
        expect(retained.filter((action) => action?._tag === "Ambiguous")).toHaveLength(1);
      }),
  );

  it.effect("rejects evidence from an earlier attempt after the same Action starts again", () =>
    Effect.gen(function* () {
      const persistence = make(makeStorage());
      const actionId = ActionId.make("restarted-action");
      const digest = "3".repeat(64);
      const correlation = {
        connectedAccountId: "private-account",
        providerSessionId: "shared-provider-session",
        providerTool: "GMAIL_SEND_EMAIL",
        startedAt: 1_000,
      } as const;
      yield* persistence.retainAction(actionId, {
        _tag: "Pending",
        correlation: { ...correlation, providerRequestId: "current-attempt-request" },
        digest,
      });

      const settlement = yield* persistence.settleAction(actionId, "earlier-attempt-request", {
        _tag: "NotApplied",
        digest,
        providerLogId: "earlier-provider-log",
      });

      expect(settlement).toMatchObject({
        _tag: "Pending",
        correlation: { providerRequestId: "current-attempt-request" },
      });
      expect(yield* persistence.readAction(actionId)).toEqual(settlement);
    }),
  );
});

const resultFor = (digest: string) => ({
  _tag: "Applied" as const,
  digest,
  result: {
    _tag: "IntegrationEffectCompleted" as const,
    evidence: {
      providerLogId: "one-provider-log",
      providerResourceId: "one-provider-message",
    },
    manifestVersion: ManifestVersion.make("gmail-v1"),
    mutations: 1 as const,
    operation: "GMAIL_SEND_EMAIL" as const,
    toolkit: "gmail" as const,
  },
});

const makeStorage = (): DurableObjectStorage => {
  const values = new Map<string, unknown>();
  let transactionTail = Promise.resolve();
  const transaction = {
    get: (key: string) => Promise.resolve(values.get(key)),
    put: (key: string, value: object) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
  // SAFETY: The persistence test exercises only get, put, and transaction, all of which are
  // implemented above with the same Promise contract as DurableObjectStorage.
  return {
    get: transaction.get,
    put: transaction.put,
    transaction: <T>(callback: (storage: typeof transaction) => Promise<T>) => {
      const result = transactionTail.then(() => callback(transaction));
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as DurableObjectStorage;
};
