/* oxlint-disable effecttsgo/global-fetch-in-effect, vitest/no-standalone-expect -- This Effect test drives the owned loopback provider boundary. */
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { UserId } from "../../domain";
import {
  startProviderEmulator,
  startRunProviderEmulator,
} from "../../../test/emulators/provider-emulator";
import { directIntegrationProviderConfig } from "../../services/integrations";
import { LocalVerificationIntegrationProvider } from "./provider";

it.effect("renders delivered Telegram replies in the run-owned provider inbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const emulator = yield* Effect.acquireRelease(
        Effect.promise(() => startRunProviderEmulator("verify-provider-inbox")),
        (provider) => Effect.promise(() => provider.close()),
      );
      const deliveredReply = "Document Build is not available on your current plan.";

      yield* Effect.promise(() =>
        fetch(new URL("/botverification/sendMessage", emulator.origin), {
          body: '{"chat_id":700001,"text":"Earlier Telegram delivery."}',
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      yield* Effect.promise(() =>
        fetch(new URL("/botverification/editMessageText", emulator.origin), {
          body: '{"chat_id":700001,"message_id":900001,"text":"Document Build is not available on your current plan."}',
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
      );
      const inbox = yield* Effect.promise(() =>
        fetch(new URL("/inbox", emulator.origin)).then((response) =>
          response.text().then((body) => ({
            body,
            contentType: response.headers.get("content-type"),
            status: response.status,
          })),
        ),
      );

      expect(inbox).toMatchObject({
        contentType: "text/html; charset=utf-8",
        status: 200,
      });
      expect(inbox.body).toContain("verify-provider-inbox");
      expect(inbox.body).toContain(deliveredReply);
      expect(inbox.body).toContain("editMessageText");
      expect(inbox.body).not.toContain("Earlier Telegram delivery.");
    }),
  ),
);

it.effect("connects and sends through one deterministic local Gmail provider boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
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
      expect(completed.headers.get("location")).toBe("http://127.0.0.1:4173/settings/integrations");

      const evidence = yield* created.session.inspectToolkits(["gmail"]);
      expect(evidence).toMatchObject([
        { connectedAccount: { status: "ACTIVE" }, isActive: true, slug: "gmail" },
      ]);
      const accountId = evidence[0]?.connectedAccount?.id;
      expect(accountId).toBeDefined();
      if (accountId === undefined) return;
      const correlation = {
        connectedAccountId: accountId,
        providerRequestId: "local-attempt-request-1",
        providerSessionId: created.providerSessionId,
        providerTool: "GMAIL_SEND_EMAIL",
        startedAt: 0,
      } as const;
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
        undefined,
        correlation,
      );
      expect(result).toMatchObject({
        data: { id: "local-gmail-message-1" },
        error: null,
        logId: "local-gmail-log-1",
      });
      const inspectExecution = created.session.inspectExecution;
      if (inspectExecution === undefined) throw new Error("provider inspection is missing");
      expect(
        yield* inspectExecution(correlation, {
          body: "Scheduled Email local provider boundary proof.",
          is_html: false,
          recipient_email: "recipient@example.test",
          subject: "Scheduled Email verification",
          user_id: "me",
        }),
      ).toMatchObject({ _tag: "Applied", execution: { logId: "local-gmail-log-1" } });
      const ledger = yield* Effect.promise(() =>
        fetch(new URL("/_test/integrations/ledger", emulator.origin)).then((response) =>
          response.json(),
        ),
      );
      expect(ledger).toMatchObject([
        {
          providerSessionId: created.providerSessionId,
          providerRequestId: "local-attempt-request-1",
          providerTool: "GMAIL_SEND_EMAIL",
          resourceId: "local-gmail-message-1",
          userId,
        },
      ]);
    }),
  ),
);
