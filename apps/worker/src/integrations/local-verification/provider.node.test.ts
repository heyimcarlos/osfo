/* oxlint-disable effecttsgo/global-fetch-in-effect, vitest/no-standalone-expect -- This Effect test drives the owned loopback provider boundary. */
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { UserId } from "../../domain";
import {
  startProviderEmulator,
  startRunProviderEmulator,
} from "../../../test/emulators/provider-emulator";
import { directIntegrationProviderConfig, type ProviderSession } from "../../services/integrations";
import { ResearchVerificationProvider } from "../cloudflare/research-verification-provider";
import { LocalVerificationIntegrationProvider } from "./provider";

it.effect("does not replay the stable immediate Gmail Action after Approval continuation", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const request =
          "Send this exact Gmail message now: recipient=person@example.test; subject=Exact subject; body=Exact body";
        const gmailTool = {
          function: {
            name: "gmailSendEmail",
            parameters: { properties: {}, type: "object" },
          },
          type: "function" as const,
        };
        const initial = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [{ content: request, role: "user" }],
            tools: [gmailTool],
          }),
        );
        const continued = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              { content: request, role: "user" },
              {
                content: '{"status":"paused"}',
                name: "gmailSendEmail",
                role: "tool",
                tool_call_id: "verification-gmailSendEmail",
              },
              {
                content:
                  "Continue your previous response from exactly where it left off. Do not repeat any of it.",
                role: "user",
              },
            ],
            tools: [gmailTool],
          }),
        );
        expect(initial).toMatchObject({
          tool_calls: [{ id: "verification-gmailSendEmail", name: "gmailSendEmail" }],
        });
        expect(continued).toMatchObject({
          finish_reason: "stop",
          response: "The approved immediate Gmail Action is complete.",
        });
        expect(continued).not.toHaveProperty("tool_calls");
        const ledger = yield* Effect.promise(() =>
          fetch(`${emulator.origin}/_test/research/ledger`).then((response) => response.json()),
        );
        const toolSelections = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              kind: Schema.String,
              operationId: Schema.NullOr(Schema.String),
              selectedTool: Schema.optionalKey(Schema.String),
              subject: Schema.String,
            }),
          ),
        )(ledger).pipe(
          Effect.map((entries) =>
            entries.filter(
              (entry) => entry.kind === "tool-selection" && entry.selectedTool === "gmailSendEmail",
            ),
          ),
        );
        expect(toolSelections).toEqual([
          {
            kind: "tool-selection",
            operationId: "verification-gmailSendEmail",
            selectedTool: "gmailSendEmail",
            subject: "person@example.test|Exact subject|Exact body",
          },
        ]);
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);

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

      const history = yield* Effect.promise(() =>
        fetch(new URL("/inbox?history=1", emulator.origin)).then((response) => response.text()),
      );
      expect(history).toContain("Earlier Telegram delivery.");
      expect(history).toContain(deliveredReply);
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
      yield* created.session.disconnect(accountId);
      expect(yield* created.session.inspectToolkits(["gmail"])).toEqual([
        {
          connectedAccount: { id: accountId, status: "REVOKED" },
          isActive: false,
          slug: "gmail",
        },
      ]);
    }),
  ),
);

it.effect(
  "deletes only the selected User connection and preserves the immutable send ledger on replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const emulator = yield* Effect.acquireRelease(
          Effect.promise(startProviderEmulator),
          (provider) => Effect.promise(() => provider.close()),
        );
        const provider = LocalVerificationIntegrationProvider.make(emulator.origin);
        const deletingUserId = UserId.make("local-deleting-user");
        const unrelatedUserId = UserId.make("local-unrelated-user");
        const deleting = yield* provider.createSession(
          deletingUserId,
          directIntegrationProviderConfig,
        );
        const unrelated = yield* provider.createSession(
          unrelatedUserId,
          directIntegrationProviderConfig,
        );
        const deletingAccountId = yield* connectLocalGmail(deleting.session);
        const unrelatedAccountId = yield* connectLocalGmail(unrelated.session);
        const correlation = {
          connectedAccountId: deletingAccountId,
          providerRequestId: "local-deletion-send-request-1",
          providerSessionId: deleting.providerSessionId,
          providerTool: "GMAIL_SEND_EMAIL",
          startedAt: 0,
        } as const;
        yield* deleting.session.execute(
          "GMAIL_SEND_EMAIL",
          {
            body: "Immutable send ledger proof.",
            is_html: false,
            recipient_email: "recipient@example.test",
            subject: "Provider deletion verification",
            user_id: "me",
          },
          deletingAccountId,
          undefined,
          correlation,
        );
        const ledgerBefore = yield* Effect.promise(() =>
          fetch(new URL("/_test/integrations/ledger", emulator.origin)).then((response) =>
            response.json(),
          ),
        );
        const deletion = LocalVerificationIntegrationProvider.makeAccountDeletion(emulator.origin);
        const targets = yield* deletion.pending(deletingUserId);
        expect(targets).toEqual([{ connectionId: deletingAccountId, userId: deletingUserId }]);
        const target = targets[0];
        if (target === undefined) return yield* Effect.die(new Error("target is missing"));

        yield* Effect.promise(() =>
          fetch(new URL("/_test/integrations/fail-next-revoke", emulator.origin), {
            method: "POST",
          }),
        );
        expect(yield* deletion.revoke(target).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(yield* deletion.pending(deletingUserId)).toEqual(targets);

        yield* deletion.revoke(target);
        yield* Effect.promise(() =>
          fetch(new URL("/_test/integrations/fail-next-delete", emulator.origin), {
            method: "POST",
          }),
        );
        expect(yield* deletion.remove(target).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(yield* deletion.pending(deletingUserId)).toEqual(targets);
        yield* deletion.remove(target);
        yield* deletion.remove(target);
        expect(yield* deletion.pending(deletingUserId)).toEqual([]);
        expect(yield* deletion.pending(unrelatedUserId)).toEqual([
          { connectionId: unrelatedAccountId, userId: unrelatedUserId },
        ]);
        expect(yield* deleting.session.inspectToolkits(["gmail"])).toEqual([
          { connectedAccount: null, isActive: false, slug: "gmail" },
        ]);
        expect(yield* unrelated.session.inspectToolkits(["gmail"])).toMatchObject([
          {
            connectedAccount: { id: unrelatedAccountId, status: "ACTIVE" },
            isActive: true,
            slug: "gmail",
          },
        ]);
        expect(
          yield* Effect.promise(() =>
            fetch(new URL("/_test/integrations/ledger", emulator.origin)).then((response) =>
              response.json(),
            ),
          ),
        ).toEqual(ledgerBefore);
        return undefined;
      }),
    ),
);

const connectLocalGmail = (providerSession: ProviderSession) =>
  Effect.gen(function* () {
    const redirect = yield* providerSession.authorize(
      "gmail",
      new URL("http://127.0.0.1:4173/settings/integrations"),
    );
    const completed = yield* Effect.promise(() =>
      fetch(redirect, { method: "POST", redirect: "manual" }),
    );
    expect(completed.status).toBe(303);
    const evidence = yield* providerSession.inspectToolkits(["gmail"]);
    const accountId = evidence[0]?.connectedAccount?.id;
    if (accountId === undefined) return yield* Effect.die(new Error("connection is missing"));
    return accountId;
  });
