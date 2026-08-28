/* oxlint-disable effecttsgo/global-fetch-in-effect, vitest/no-standalone-expect -- This Effect test drives the owned loopback provider boundary. */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { UserId } from "../../domain";
import { startProviderEmulator } from "../../../test/emulators/provider-emulator";
import { directIntegrationProviderConfig } from "../../services/integrations";
import { LocalVerificationIntegrationProvider } from "./provider";

it.effect("connects and sends through one deterministic local Gmail provider boundary", () =>
  Effect.scoped(Effect.gen(function* () {
    const emulator = yield* Effect.acquireRelease(
      Effect.promise(startProviderEmulator),
      (provider) => Effect.promise(() => provider.close()),
    );
    const provider = LocalVerificationIntegrationProvider.make(emulator.origin);
    const userId = UserId.make("local-integration-user");
    const created = yield* provider.createSession(userId, directIntegrationProviderConfig);
    const redirect = yield* created.session.authorize(
      "gmail",
      new URL("http://127.0.0.1:4173/settings/integrations"),
    );
    expect((yield* Effect.promise(() => fetch(redirect))).status).toBe(200);
    const completed = yield* Effect.promise(() =>
      fetch(redirect, { method: "POST", redirect: "manual" }),
    );
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe(
      "http://127.0.0.1:4173/settings/integrations",
    );

    const evidence = yield* created.session.inspectToolkits(["gmail"]);
    expect(evidence).toMatchObject([
      { connectedAccount: { status: "ACTIVE" }, isActive: true, slug: "gmail" },
    ]);
    const accountId = evidence[0]?.connectedAccount?.id;
    expect(accountId).toBeDefined();
    if (accountId === undefined) return;
    const result = yield* created.session.execute(
      "GMAIL_SEND_EMAIL",
      {
        body: "Scheduled Email local provider boundary proof.",
        is_html: false,
        recipient_email: "recipient@example.test",
        subject: "Scheduled Email verification",
        user_id: "me",
      },
      accountId,
    );
    expect(result).toMatchObject({
      data: { id: "local-gmail-message-1" },
      error: null,
      logId: "local-gmail-log-1",
    });
    const ledger = yield* Effect.promise(() =>
      fetch(new URL("/_test/integrations/ledger", emulator.origin)).then((response) =>
        response.json(),
      ),
    );
    expect(ledger).toMatchObject([
      {
        providerSessionId: created.providerSessionId,
        providerTool: "GMAIL_SEND_EMAIL",
        resourceId: "local-gmail-message-1",
        userId,
      },
    ]);
  })),
);
