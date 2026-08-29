/* oxlint-disable effecttsgo/global-date, effecttsgo/global-date-in-effect -- Fixed lifecycle bounds make the provisioning proof deterministic. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect generators. */
import { BrowserCrypto } from "@effect/platform-browser";
import { expect, it } from "@effect/vitest";
import { users } from "@osfo/db/schema/auth";
import { qualificationParticipantProvisions } from "@osfo/db/schema/qualification-cohorts";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";

import { Db } from "../db";
import { UserId } from "../domain";
import {
  canonicalQualificationJson,
  qualificationChecksum,
} from "../qualification/qualification-checksum";
import {
  decodeQualificationCohortManifest,
  type QualificationCohortManifest,
} from "../qualification/qualification-cohort";
import { qualificationEnrollmentDigest } from "../qualification/qualification-enrollment";
import { makeQualificationCohortAuthority } from "../integrations/postgres/qualification-cohort";
import { AgentRegistration, make } from "./registration";

const secret = Redacted.make("qualification-enrollment-secret-at-least-32-characters");
const expiresAt = new Date("2099-08-30T17:00:00.000Z");

const cohort = (): QualificationCohortManifest => {
  const content = {
    cohortId: "registration-cohort",
    createdAtUtc: "2026-08-29T12:00:00.000Z",
    executionId: "registration-execution",
    expiresAtUtc: expiresAt.toISOString(),
    grantPrefix: "qualification/executions/registration-execution/cohort/grants",
    manifestChecksum: "registration-manifest",
    notBeforeUtc: "2026-08-29T12:01:00.000Z",
    participantCounts: { adventurer: 1, free: 3 },
    planChecksum: "registration-plan",
    sourceVersion: "registration-source",
    teardownPolicy: "permanentAccountDeletion" as const,
  };
  const decoded = decodeQualificationCohortManifest(
    canonicalQualificationJson({ ...content, artifactChecksum: qualificationChecksum(content) }),
  );
  if (decoded === null) throw new Error("Registration cohort fixture must decode");
  return decoded;
};

it.effect(
  "consumes only a pre-User verified-phone provision and ignores email spoof or backdating",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeTestDatabase;
      yield* Effect.addFinalizer(() => closeTestDatabase(fixture));
      yield* applyMigrations(fixture.client);
      const authority = makeQualificationCohortAuthority(fixture.database);
      const manifest = cohort();
      yield* authority.begin(manifest);
      const cases = [
        {
          email: "qualification-valid@example.test",
          index: 0,
          phone: "+14165550101",
          provisionPhone: "+14165550101",
          userCreatedAfterProvision: true,
          userId: "qualification-valid",
        },
        {
          email: "+14165550102",
          index: 1,
          phone: "+14165550999",
          provisionPhone: "+14165550102",
          userCreatedAfterProvision: true,
          userId: "qualification-email-spoof",
        },
        {
          email: "qualification-preexisting@example.test",
          index: 2,
          phone: "+14165550103",
          provisionPhone: "+14165550103",
          userCreatedAfterProvision: false,
          userId: "qualification-preexisting",
        },
      ] as const;
      yield* Effect.forEach(cases, (entry) =>
        Effect.gen(function* () {
          const enrollmentDigest = yield* qualificationEnrollmentDigest(
            secret,
            entry.provisionPhone,
          );
          const provisioned = yield* authority.provision({
            cohortId: manifest.cohortId,
            enrollmentDigest,
            executionId: manifest.executionId,
            expiresAt,
            participantIndex: entry.index,
            plan: "free",
            provisionId: `provision-${entry.userId}`,
          });
          expect(provisioned.status).toBe("CREATED");
          const committedAt = "createdAt" in provisioned ? provisioned.createdAt : new Date();
          yield* Effect.promise(() =>
            fixture.database.insert(users).values({
              createdAt: entry.userCreatedAfterProvision
                ? new Date(committedAt.getTime() + 1_000)
                : new Date("2020-01-01T00:00:00.000Z"),
              email: entry.email,
              id: entry.userId,
              name: entry.userId,
              phoneNumber: entry.phone,
              phoneNumberVerified: true,
            }),
          );
        }),
      );

      const registration = yield* make(secret).pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The integration test composes the complete registration entry point.
        Effect.provide(
          Layer.mergeAll(
            BrowserCrypto.layer,
            Db.layerFromDatabase(fixture.database),
            Layer.succeed(AgentRegistration, {
              initialize: () => Effect.void,
            }),
          ),
        ),
      );
      yield* Effect.forEach(cases, (entry) =>
        registration.complete({
          profile: { helpAreas: [], locale: "en", preferredName: null },
          userId: UserId.make(entry.userId),
        }),
      );
      const retained = yield* Effect.promise(() =>
        fixture.database
          .select({
            provisionId: qualificationParticipantProvisions.provision_id,
            state: qualificationParticipantProvisions.state,
            userId: qualificationParticipantProvisions.user_id,
          })
          .from(qualificationParticipantProvisions),
      );
      expect(retained).toEqual(
        expect.arrayContaining([
          {
            provisionId: "provision-qualification-valid",
            state: "CONSUMED",
            userId: "qualification-valid",
          },
          {
            provisionId: "provision-qualification-email-spoof",
            state: "PENDING",
            userId: null,
          },
          {
            provisionId: "provision-qualification-preexisting",
            state: "PENDING",
            userId: null,
          },
        ]),
      );
      expect(
        yield* Effect.promise(() =>
          fixture.database
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, "qualification-valid")),
        ),
      ).toHaveLength(1);
    }),
);
