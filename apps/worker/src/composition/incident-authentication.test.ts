/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect, vitest/no-standalone-expect -- Tests use fixed registration evidence and assertions inside Effects. */
import { expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect } from "effect";

import { IncidentControlsPostgres } from "../integrations/postgres/incident-controls";
import { IncidentAuthentication } from "./incident-authentication";

it.effect("silently suppresses new registration SMS while preserving existing-account login", () =>
  Effect.gen(function* () {
    const fixture = yield* makeTestDatabase;
    yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
    yield* applyMigrations(fixture.client);
    yield* Effect.promise(() =>
      fixture.database.insert(users).values({
        id: "registered",
        email: "registered@example.test",
        name: "Registered",
        phoneNumber: "+12025550101",
        phoneNumberVerified: true,
        registrationCompletedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    const calls: Array<string> = [];
    const send = IncidentAuthentication.sendCode(fixture.database, (phoneNumber) =>
      Effect.sync(() => {
        calls.push(phoneNumber);
      }),
    );
    const controls = IncidentControlsPostgres.makeFromDatabase(fixture.database);
    yield* send("+12025550102");
    expect(calls).toEqual(["+12025550102"]);
    yield* controls.set({
      control: "newCostlyWork",
      paused: true,
      actor: "test",
      reason: "incident",
    });
    expect(yield* send("+12025550102")).toBeUndefined();
    expect(yield* send("+12025550101")).toBeUndefined();
    expect(calls).toEqual(["+12025550102", "+12025550101"]);
    yield* controls.set({
      control: "newCostlyWork",
      paused: false,
      actor: "test",
      reason: "restored",
    });
    yield* controls.set({ control: "newIngress", paused: true, actor: "test", reason: "incident" });
    yield* send("+12025550102");
    expect(calls).toHaveLength(2);
  }),
);
