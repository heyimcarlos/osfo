import { BrowserRenderingError, listBrowserTargets } from "agents/browser";
import type { createBrowserSession } from "agents/browser";
import { BrowserInteraction } from "@osfo/api/browser-host";
import { HostedBrowserProvider } from "hosted-browser-provider-under-test";
import { Data, Effect, Result, Schema } from "effect";

class AdapterQualificationFailure extends Data.TaggedError("AdapterQualificationFailure")<{
  message: string;
  cause?: unknown;
}> {}

/** Exercise the application adapter against only this Worker's synthetic fixture. */
export const adapterQualify = Effect.fn("HostedBrowserQualification.adapter")(function* (
  binding: Parameters<typeof createBrowserSession>[0],
  fixtureUrl: string,
) {
  const provider = HostedBrowserProvider.make(binding);
  const sessionId = yield* provider.create;
  const checks = ["application-provider-create"];
  const origin = new URL(fixtureUrl).origin;
  const reference = "adapter-qualification-synthetic";
  const outcome = yield* Effect.result(
    Effect.gen(function* () {
      const opened = yield* provider.open(sessionId, fixtureUrl);
      const original = yield* provider.observe(sessionId, opened.targetId, origin);
      if (!original.text.includes("No receipt recorded."))
        return yield* new AdapterQualificationFailure({
          message: "Fixture did not start without a receipt",
        });
      const input = original.text.split("\n").flatMap((line) => {
        const match = /^(\d+) textbox Synthetic reference(?: |$)/.exec(line);
        return match?.[1] ? [match[1]] : [];
      });
      const inputTarget = input[0];
      if (input.length !== 1 || inputTarget === undefined)
        return yield* new AdapterQualificationFailure({
          message: "Fixture accessibility observation did not identify one reference input",
        });
      checks.push("application-provider-open-and-ax-observe");
      const filled = yield* provider.interact(
        sessionId,
        opened.targetId,
        origin,
        original,
        BrowserInteraction.cases.Fill.make({ target: inputTarget, value: reference }),
      );
      if (!Schema.is(HostedBrowserProvider.Page)(filled))
        return yield* new AdapterQualificationFailure({
          message: "Fresh input observation was rejected as stale",
        });
      const fresh = yield* provider.observe(sessionId, opened.targetId, origin);
      if (!fresh.text.includes(reference))
        return yield* new AdapterQualificationFailure({
          message: "Filled value missing from fresh accessibility observation",
        });
      checks.push("application-provider-fill");
      const buttons = fresh.text.split("\n").flatMap((line) => {
        const match = /^(\d+) button Record test receipt$/.exec(line);
        return match?.[1] ? [match[1]] : [];
      });
      const buttonTarget = buttons[0];
      if (buttons.length !== 1 || buttonTarget === undefined)
        return yield* new AdapterQualificationFailure({
          message: "Fixture accessibility observation did not identify one receipt button",
        });
      const click = BrowserInteraction.cases.Click.make({ target: buttonTarget });
      const clicked = yield* provider.interact(sessionId, opened.targetId, origin, fresh, click);
      if (!Schema.is(HostedBrowserProvider.Page)(clicked))
        return yield* new AdapterQualificationFailure({
          message: "Fresh button observation was rejected as stale",
        });
      const receipt = yield* provider.observe(sessionId, opened.targetId, origin);
      if (!receipt.text.includes(`Test receipt recorded: ${reference}`))
        return yield* new AdapterQualificationFailure({
          message: "Visible synthetic receipt was not confirmed after click",
        });
      checks.push("application-provider-click-and-visible-receipt");
      const stale = yield* provider.interact(sessionId, opened.targetId, origin, original, click);
      if (Schema.is(HostedBrowserProvider.Page)(stale))
        return yield* new AdapterQualificationFailure({
          message: "Old page observation incorrectly authorized another action",
        });
      const afterStale = yield* provider.observe(sessionId, opened.targetId, origin);
      if (afterStale.text !== receipt.text || afterStale.url !== receipt.url)
        return yield* new AdapterQualificationFailure({
          message: "Stale action changed the observed page",
        });
      checks.push("application-provider-stale-action-rejected");
      return undefined;
    }),
  );
  const cleanup = yield* Effect.result(
    provider.close(sessionId).pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => listBrowserTargets(binding, sessionId),
          catch: (cause) =>
            new AdapterQualificationFailure({ message: "Checking adapter cleanup", cause }),
        }).pipe(
          Effect.matchEffect({
            onSuccess: () =>
              Effect.fail(
                new AdapterQualificationFailure({
                  message: "Session remains accessible after provider close",
                }),
              ),
            onFailure: (error) =>
              error.cause instanceof BrowserRenderingError &&
              [404, 410].includes(error.cause.status)
                ? Effect.void
                : Effect.fail(error),
          }),
        ),
      ),
    ),
  );
  if (Result.isSuccess(cleanup)) checks.push("application-provider-close-confirmed-absent");
  const failures = [outcome, cleanup].flatMap((result) =>
    Result.isFailure(result) ? [result.failure.message] : [],
  );
  return {
    passed: failures.length === 0 && checks.length === 6,
    checks,
    failures,
    createdSessions: 1,
    deletedSessions: Result.isSuccess(cleanup) ? 1 : 0,
  };
});
