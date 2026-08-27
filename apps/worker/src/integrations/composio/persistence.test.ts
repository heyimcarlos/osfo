/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
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
            evidence: { providerLogId: `provider-log-${index}` },
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
});

const makeStorage = (): DurableObjectStorage => {
  const values = new Map<string, unknown>();
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
    transaction: <T>(callback: (storage: typeof transaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as DurableObjectStorage;
};
