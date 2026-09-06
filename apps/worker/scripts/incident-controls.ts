/* oxlint-disable effecttsgo/strict-effect-provide -- This operator CLI owns the database scope. */
import { Config, Effect, Result, Schema } from "effect";

import { Db } from "../src/db";
import { IncidentControlsPostgres } from "../src/integrations/postgres/incident-controls";

const command = process.argv.slice(2);
const program = Effect.gen(function* () {
  const databaseUrl = yield* Config.string("INCIDENT_DATABASE_URL");
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const controls = yield* IncidentControlsPostgres.make;
      if (command[0] === "set" && command.length === 5) {
        const update = yield* Schema.decodeUnknownEffect(IncidentControlsPostgres.Command)({
          control: command[1],
          paused: command[2] === "paused" ? true : command[2] === "active" ? false : null,
          actor: command[3],
          reason: command[4],
        });
        yield* controls.set(update);
      } else if (command[0] !== "inspect" || command.length !== 1) {
        return yield* Effect.die(
          new Error(
            "Usage: incident-controls.ts inspect | set <newIngress|newCostlyWork> <paused|active> <actor> <reason>",
          ),
        );
      }
      return {
        newIngress: yield* controls.read("newIngress"),
        newCostlyWork: yield* controls.read("newCostlyWork"),
      };
    }).pipe(Effect.provide(Db.layer({ db: { connectionString: databaseUrl } }))),
  );
});

// oxlint-disable-next-line effecttsgo/top-level-run-effect -- Trusted operator CLI boundary handles errors without printing database details.
const result = await Effect.runPromise(program.pipe(Effect.result));
if (Result.isSuccess(result)) {
  // oxlint-disable-next-line effecttsgo/global-console, eslint/no-console -- Operator readback contains only control state.
  console.log(JSON.stringify(result.success));
} else {
  // oxlint-disable-next-line effecttsgo/global-console, eslint/no-console -- Never print raw connection or database errors.
  console.error(
    "Incident controls command failed. Verify the command, target database and migration state.",
  );
  process.exitCode = 1;
}
