/* oxlint-disable effecttsgo/strict-effect-provide, vitest/no-standalone-expect -- Tests own the isolated database and assert effects inside their scope. */
import { expect, it } from "@effect/vitest";
import { incidentControls } from "@osfo/db/schema/incident-controls";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect } from "effect";

import { IncidentControlsPostgres } from "./incident-controls";

it.effect("reads current controls on every admission and retains independent switches", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    const controls = IncidentControlsPostgres.makeFromDatabase(fixture.database);
    yield* controls.check("newIngress");
    yield* controls.check("newCostlyWork");
    yield* controls.set({
      control: "newCostlyWork",
      paused: true,
      actor: "test",
      reason: "dispatch incident",
    });
    yield* controls.check("newIngress");
    expect(yield* controls.check("newCostlyWork").pipe(Effect.result)).toMatchObject({
      failure: { _tag: "IncidentWorkPaused", control: "newCostlyWork" },
    });
    yield* controls.set({
      control: "newIngress",
      paused: true,
      actor: "test",
      reason: "ingress incident",
    });
    yield* controls.set({
      control: "newCostlyWork",
      paused: false,
      actor: "test",
      reason: "dispatch restored",
    });
    yield* controls.check("newCostlyWork");
    expect(yield* controls.read("newIngress")).toBe(true);
  }),
);

it.effect("fails closed when the control row is missing", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* Effect.promise(() => fixture.database.delete(incidentControls));
    const controls = IncidentControlsPostgres.makeFromDatabase(fixture.database);
    expect(yield* controls.check("newCostlyWork").pipe(Effect.result)).toMatchObject({
      failure: { _tag: "IncidentControlsUnavailable" },
    });
  }),
);
