/* oxlint-disable vitest/no-standalone-expect -- The assertion executes inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";

import { composioApiKeyConfig } from "./WorkerConfig";

it.effect("rejects a whitespace-only production Composio credential", () =>
  Effect.gen(function* () {
    const provider = ConfigProvider.fromUnknown({ COMPOSIO_API_KEY: "   " });
    const error = yield* Effect.flip(composioApiKeyConfig("production").parse(provider));

    expect(error.message).toContain("COMPOSIO_API_KEY must not be blank");
  }),
);
