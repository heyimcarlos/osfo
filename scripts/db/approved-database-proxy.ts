import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export class DatabaseConnectionRequiresApprovedProxy extends Data.TaggedError(
  "DatabaseConnectionRequiresApprovedProxy",
)<{ readonly hostname: string; readonly operation: string }> {}

export const requireApprovedDatabaseProxy = (
  databaseUrl: URL,
  operation: string,
): Effect.Effect<void, DatabaseConnectionRequiresApprovedProxy> =>
  loopbackHosts.has(databaseUrl.hostname)
    ? Effect.void
    : Effect.fail(
        new DatabaseConnectionRequiresApprovedProxy({
          hostname: databaseUrl.hostname,
          operation,
        }),
      );
