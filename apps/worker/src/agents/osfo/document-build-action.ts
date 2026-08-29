import { Effect } from "effect";

import type { Denied } from "../../services/authorization";
import type { DocumentBuild } from "../../services/document-build";

type StartFailure =
  | Denied
  | DocumentBuild.Conflict
  | DocumentBuild.NotFound
  | DocumentBuild.SourceChanged
  | DocumentBuild.SourceRejected
  | DocumentBuild.Unavailable;

export const runDocumentBuildStartAction = <Success>(
  effect: Effect.Effect<Success, StartFailure>,
): Promise<Denied | Success> =>
  Effect.runPromise(effect.pipe(Effect.catchTag("Denied", (denial) => Effect.succeed(denial))));
