import { Effect, Schema } from "effect";

/** Incident controls apply only to admission and new provider dispatch. */
export const Control = Schema.Literals(["newIngress", "newCostlyWork"]);
export type Control = typeof Control.Type;

/** Operator action currently prevents this new work. */
export class Paused extends Schema.TaggedError<Paused>()("IncidentWorkPaused", {
  control: Control,
}) {}

/** Current incident state could not be read or updated. */
export class Unavailable extends Schema.TaggedError<Unavailable>()("IncidentControlsUnavailable", {
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly check: (control: Control) => Effect.Effect<void, Paused | Unavailable>;
}

/** Read on every invocation, including retries; never retain an admission decision. */
export const make = (
  read: (control: Control) => Effect.Effect<boolean, Unavailable>,
): Interface => ({
  check: Effect.fn("IncidentControls.check")(function* (control) {
    if (yield* read(control)) return yield* new Paused({ control });
    return undefined;
  }),
});

export * as IncidentControls from "./incident-controls";
