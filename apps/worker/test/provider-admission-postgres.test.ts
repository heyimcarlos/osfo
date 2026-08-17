import { describe, expect, it } from "@effect/vitest";
import { applyMigrations, closeTestDatabase, makeTestDatabase } from "@osfo/db/testing";
import { Effect } from "effect";

import * as Db from "../src/db";
import { AgentId, ChannelBindingId, ChannelIdentity, ProviderMessageId } from "../src/domain";
import * as ProviderAuthorization from "../src/integrations/postgres/provider-authorization";
import * as ProviderEventRouting from "../src/integrations/postgres/provider-event-routing";

/* oxlint-disable effecttsgo/global-date-in-effect, effecttsgo/strict-effect-provide -- These PostgreSQL test entry points own deterministic Date and Layer boundaries. */

describe("shared provider admission PostgreSQL", () => {
  it.effect("reports provider-neutral authorization failure for a missing Telegram binding", () =>
    Effect.acquireUseRelease(
      makeTestDatabase,
      (fixture) =>
        Effect.gen(function* () {
          yield* applyMigrations(fixture.client);
          const failure = yield* ProviderAuthorization.make({
            now: Effect.succeed(new Date("2026-08-17T00:00:00.000Z")),
            provider: "telegram",
          }).pipe(
            Effect.flatMap((authorization) =>
              authorization.admit({
                _tag: "Bound",
                agentId: AgentId.make("agent-missing"),
                channelBindingId: ChannelBindingId.make("binding-missing"),
              }),
            ),
            Effect.flip,
            Effect.provide(Db.layerFromDatabase(fixture.database)),
          );

          expect(failure).toMatchObject({
            _tag: "ProviderAuthorizationPersistenceUnavailable",
            message: "PostgreSQL could not load provider authorization facts",
            provider: "telegram",
          });
        }),
      closeTestDatabase,
    ),
  );

  describe.each(["telegram", "whatsapp"] as const)("$0 event routing", (provider) => {
    it("describes provider-event persistence failures without exposing their cause", () => {
      const failure = new ProviderEventRouting.ProviderEventRoutingUnavailable({
        cause: "database-secret",
        message: "PostgreSQL could not fix the provider event route",
        provider,
      });

      expect(failure.message).toBe("PostgreSQL could not fix the provider event route");
      expect(failure.message).not.toContain("database-secret");
    });

    it.effect("fixes the first unbound route and rejects changed replay facts", () =>
      Effect.acquireUseRelease(
        makeTestDatabase,
        (fixture) =>
          Effect.gen(function* () {
            yield* applyMigrations(fixture.client);
            const input: ProviderEventRouting.Input = {
              channelIdentity: ChannelIdentity.make(`${provider}:shared-route`),
              contentDigest: "a".repeat(64),
              eventScope: provider === "telegram" ? "telegram" : "14165550000",
              messageKind: "text",
              provider,
              providerMessageId: ProviderMessageId.make(`${provider}-event-shared-route`),
            };

            const first = yield* ProviderEventRouting.route(
              fixture.database,
              input,
              new Date("2026-08-17T00:00:00.000Z"),
            );
            const conflict = yield* ProviderEventRouting.route(
              fixture.database,
              { ...input, contentDigest: "b".repeat(64) },
              new Date("2026-08-17T00:00:01.000Z"),
            );

            expect(first).toEqual({ _tag: "Unbound" });
            expect(conflict).toEqual({ _tag: "Conflict" });
          }),
        closeTestDatabase,
      ),
    );
  });
});
