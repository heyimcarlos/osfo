/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { Denied } from "../../services/authorization";
import { DocumentBuild } from "../../services/document-build";
import { runDocumentBuildStartAction } from "./document-build-action";

it.effect("returns an expected Document Build denial as an Action result", () =>
  Effect.gen(function* () {
    const denial = {
      _tag: "Denied",
      reason: "missingEntitlement",
      resetAt: null,
    } satisfies Denied;

    const result = yield* Effect.promise(() => runDocumentBuildStartAction(Effect.fail(denial)));

    expect(result).toBe(denial);
  }),
);

it.effect("returns a successful Document Build Action result unchanged", () =>
  Effect.gen(function* () {
    const started = { _tag: "Started" as const };

    const result = yield* Effect.promise(() =>
      runDocumentBuildStartAction(Effect.succeed(started)),
    );

    expect(result).toBe(started);
  }),
);

it.effect("preserves an unexpected Document Build failure", () =>
  Effect.gen(function* () {
    const unavailable = new DocumentBuild.Unavailable({
      cause: "test provider unavailable",
      message: "The Document Build control is temporarily unavailable",
      operation: "start.test",
    });

    const result = yield* Effect.promise(() =>
      runDocumentBuildStartAction(Effect.fail(unavailable)).then(
        () => ({ _tag: "Resolved" as const }),
        (cause: unknown) => ({ _tag: "Rejected" as const, cause }),
      ),
    );

    expect(result).toEqual({ _tag: "Rejected", cause: unavailable });
  }),
);
