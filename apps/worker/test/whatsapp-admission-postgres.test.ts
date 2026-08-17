import { expect, layer } from "@effect/vitest";
import { agents } from "@osfo/db/schema/agents";
import { allowancePeriods } from "@osfo/db/schema/allowances";
import { users } from "@osfo/db/schema/auth";
import { billingSubscriptions } from "@osfo/db/schema/billing";
import { channelBindings } from "@osfo/db/schema/onboarding";
import { applyMigrations, makeTestDatabase } from "@osfo/db/testing";
import { eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";

import { layerFromDatabase } from "../src/db";
import { ChannelBindingId, ChannelIdentity, ProviderMessageId, UserId } from "../src/domain";
import { isCurrentBinding, make } from "../src/integrations/postgres/whatsapp-admission";

const fixture = Effect.runSync(makeTestDatabase);
await Effect.runPromise(applyMigrations(fixture.client));

layer(layerFromDatabase(fixture.database))("WhatsApp admission PostgreSQL", (it) => {
  it.effect("keeps the first binding after revocation and replacement", () =>
    Effect.gen(function* () {
      const admission = yield* make({ now: Effect.succeed(date("2026-08-16T12:00:00.000Z")) });
      const database = fixture.database;
      yield* Effect.promise(() => seedBoundUser(database, "old", "14165550123"));
      const first = yield* admission.route(routeInput());
      yield* Effect.promise(() =>
        database
          .update(channelBindings)
          .set({ revokedAt: date("2026-08-16T12:05:00.000Z") })
          .where(eq(channelBindings.channelBindingId, "binding-old")),
      );
      yield* Effect.promise(() => seedBoundUser(database, "new", "14165550123"));

      const repeated = yield* admission.route(routeInput());
      const oldAuthority = yield* isCurrentBinding(
        ChannelBindingId.make("binding-old"),
        UserId.make("user-old"),
      );
      const newAuthority = yield* isCurrentBinding(
        ChannelBindingId.make("binding-new"),
        UserId.make("user-new"),
      );

      expect(first).toMatchObject({ _tag: "Bound", channelBindingId: "binding-old" });
      expect(repeated).toMatchObject({
        _tag: "Bound",
        authorization: { authority: { _tag: "RevokedChannelBinding" } },
        channelBindingId: "binding-old",
      });
      expect(oldAuthority).toBe(false);
      expect(newAuthority).toBe(true);
    }),
  );

  it.effect("keeps an unbound first resolution after later enrollment", () =>
    Effect.gen(function* () {
      const admission = yield* make({ now: Effect.succeed(date("2026-08-16T12:00:00.000Z")) });
      const database = fixture.database;
      const input = {
        ...routeInput(),
        channelIdentity: ChannelIdentity.make("14165550124"),
        providerMessageId: ProviderMessageId.make("wamid.unbound"),
      };
      const first = yield* admission.route(input);
      yield* Effect.promise(() => seedBoundUser(database, "later", "14165550124"));

      const repeated = yield* admission.route(input);

      expect(first).toEqual({ _tag: "Unbound" });
      expect(repeated).toEqual({ _tag: "Unbound" });
    }),
  );

  it.effect("rejects changed message facts under one provider event key", () =>
    Effect.gen(function* () {
      const admission = yield* make({ now: Effect.succeed(date("2026-08-16T12:00:00.000Z")) });
      const input = {
        ...routeInput(),
        channelIdentity: ChannelIdentity.make("14165550125"),
        providerMessageId: ProviderMessageId.make("wamid.conflict"),
      };
      yield* admission.route(input);

      const conflict = yield* Effect.flip(
        admission.route({ ...input, contentDigest: "changed-digest", message: "Changed" }),
      );

      expect(conflict).toMatchObject({ _tag: "InboundWhatsAppEventConflict" });
    }),
  );
});

const routeInput = () => ({
  _tag: "TextMessage" as const,
  channelIdentity: ChannelIdentity.make("14165550123"),
  contentDigest: "digest-1",
  message: "Please help",
  phoneNumberId: "phone-1",
  providerMessageId: ProviderMessageId.make("wamid.1"),
});

// oxlint-disable-next-line effecttsgo/async-function -- test fixture: Drizzle setup is a contained Promise boundary.
const seedBoundUser = async (
  database: typeof fixture.database,
  suffix: string,
  channelIdentity: string,
) => {
  const userId = `user-${suffix}`;
  await database.insert(users).values({
    email: `${userId}@invalid.example`,
    id: userId,
    name: `User ${suffix}`,
  });
  await database.insert(agents).values({
    agentId: `agent-${suffix}`,
    createdAt: "2026-08-16T12:00:00.000Z",
    userId,
  });
  await database.insert(billingSubscriptions).values({
    billingSubscriptionId: `subscription-${suffix}`,
    plan: "free",
    planPolicyVersion: "launch-v1",
    userId,
  });
  await database.insert(allowancePeriods).values({
    allowancePeriodId: `period-${suffix}`,
    billingSubscriptionId: `subscription-${suffix}`,
    endsAt: date("2026-09-01T00:00:00.000Z"),
    plan: "free",
    planPolicyVersion: "launch-v1",
    startsAt: date("2026-08-01T00:00:00.000Z"),
    userId,
  });
  await database.insert(channelBindings).values({
    channelBindingId: `binding-${suffix}`,
    channelIdentity,
    provider: "whatsapp",
    userId,
  });
};

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
