/* oxlint-disable effecttsgo/strict-effect-provide -- check owns one dispatch-scoped database connection, including its release. */
import type { Database } from "@osfo/db";
import { incidentControls } from "@osfo/db/schema/incident-controls";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";

import { Db } from "../../db";
import { IncidentControls } from "../../services/incident-controls";

const Row = Schema.Struct({ paused: Schema.Boolean });
const OperatorText = Schema.String.check(
  Schema.makeFilter((value) => value.trim().length > 0 || "Operator and reason must not be empty"),
);
export const Command = Schema.Struct({
  control: IncidentControls.Control,
  paused: Schema.Boolean,
  actor: OperatorText,
  reason: OperatorText,
});

/** Use the existing cache-disabled Hyperdrive connection; do not memoize these reads. */
export const makeFromDatabase = (database: Database) => {
  const read = Effect.fn("IncidentControlsPostgres.read")(function* (
    control: IncidentControls.Control,
  ) {
    const rows = yield* Effect.tryPromise({
      try: () =>
        database
          .select({
            paused:
              control === "newIngress"
                ? incidentControls.pause_new_ingress
                : incidentControls.pause_new_costly_work,
          })
          .from(incidentControls)
          .where(eq(incidentControls.id, true))
          .limit(1),
      catch: (cause) => new IncidentControls.Unavailable({ cause }),
    });
    const row = rows[0];
    if (row === undefined)
      return yield* new IncidentControls.Unavailable({
        cause: new Error("Incident controls have not been initialized"),
      });
    return (yield* Schema.decodeEffect(Row)(row).pipe(
      Effect.mapError((cause) => new IncidentControls.Unavailable({ cause })),
    )).paused;
  });
  return {
    ...IncidentControls.make(read),
    read,
    set: Effect.fn("IncidentControlsPostgres.set")(function* (input: typeof Command.Type) {
      const command = yield* Schema.decodeEffect(Command)(input).pipe(
        Effect.mapError((cause) => new IncidentControls.Unavailable({ cause })),
      );
      const updated = yield* Effect.tryPromise({
        try: () =>
          database
            .update(incidentControls)
            .set({
              ...(command.control === "newIngress"
                ? { pause_new_ingress: command.paused }
                : { pause_new_costly_work: command.paused }),
              actor: command.actor,
              reason: command.reason,
              changed_at: sql`clock_timestamp()`,
            })
            .where(eq(incidentControls.id, true))
            .returning({ id: incidentControls.id }),
        catch: (cause) => new IncidentControls.Unavailable({ cause }),
      });
      if (updated.length !== 1)
        return yield* new IncidentControls.Unavailable({
          cause: new Error("Incident controls have not been initialized"),
        });
      return undefined;
    }),
  };
};

export const make = Db.database.pipe(Effect.map(makeFromDatabase));

/** Current PostgreSQL authority; its database lifetime remains a Layer requirement. */
export const layer = Layer.effect(IncidentControls.Service, make);

/** Admission point for a host dispatch that owns one short database scope. */
export const check = (
  db: Pick<Hyperdrive, "connectionString">,
  control: IncidentControls.Control,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const controls = yield* IncidentControls.Service;
      yield* controls.check(control);
    }),
  ).pipe(Effect.provide(layer.pipe(Layer.provide(Db.layer({ db })))));

export * as IncidentControlsPostgres from "./incident-controls";
