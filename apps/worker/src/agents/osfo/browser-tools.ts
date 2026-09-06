import { tool, type ToolSet } from "ai";
import { Effect, Schema } from "effect";

import type { ThinkSubmissionId, UserId } from "../../domain";
import type { Browser } from "../../services/browser-host";
import { effectToolSchema } from "./effect-tool-schema";

export interface Dependencies<Error> {
  readonly browser: Browser.Interface<Error>;
  readonly readActiveTurn: () =>
    | {
        readonly authorityIdentity: { readonly userId: UserId };
        readonly submissionId: ThinkSubmissionId;
      }
    | undefined;
}

/** The model selects a fixed read operation. Authority and host identity are never model inputs. */
export const makeBrowserTools = <Error>(dependencies: Dependencies<Error>): ToolSet => ({
  inspectBrowserInventory: tool({
    description:
      "Inspect the available browsers and tab counts on your private provisioned browser host. This does not open, select, navigate, or read tabs.",
    inputSchema: effectToolSchema(Schema.Struct({})),
    execute: (_input, context) => executeBrowserInventory(dependencies, context.toolCallId),
  }),
});

export const executeBrowserInventory = <Error>(
  dependencies: Dependencies<Error>,
  operationId: string,
) => {
  const active = dependencies.readActiveTurn();
  const unavailable = { _tag: "Unavailable" } as const;
  if (active === undefined) return Promise.resolve(unavailable);
  return Effect.runPromise(
    dependencies.browser
      .inspect({
        operationId,
        turnId: active.submissionId,
        userId: active.authorityIdentity.userId,
      })
      .pipe(Effect.match({ onFailure: () => unavailable, onSuccess: (outcome) => outcome })),
  );
};
