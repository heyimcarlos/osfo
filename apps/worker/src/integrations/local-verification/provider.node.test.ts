/* oxlint-disable effecttsgo/async-function, effecttsgo/global-fetch, effecttsgo/global-fetch-in-effect, vitest/no-standalone-expect -- This Effect test drives the owned loopback provider boundary and injects an observing Fetch boundary. */
import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { expect } from "vitest";

import { UserId } from "../../domain";
import {
  startProviderEmulator,
  startRunProviderEmulator,
} from "../../../test/emulators/provider-emulator";
import { directIntegrationProviderConfig, type ProviderSession } from "../../services/integrations";
import { ResearchVerificationProvider } from "../cloudflare/research-verification-provider";
import { LocalVerificationIntegrationProvider } from "./provider";

it.effect("reports provider Session owners without changing their authority", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const provider = LocalVerificationIntegrationProvider.make(emulator.origin);
        const userId = UserId.make("session-owner");
        const otherUserId = UserId.make("other-session-owner");
        const browsing = yield* provider.createSession(userId, directIntegrationProviderConfig);
        const action = yield* provider.createSession(userId, directIntegrationProviderConfig);
        const other = yield* provider.createSession(otherUserId, directIntegrationProviderConfig);
        const expected = [
          { providerSessionId: browsing.providerSessionId, userId },
          { providerSessionId: action.providerSessionId, userId },
          { providerSessionId: other.providerSessionId, userId: otherUserId },
        ];
        expect(
          yield* Effect.promise(() =>
            fetch(new URL("/_test/integrations/sessions", emulator.origin)).then((response) =>
              response.json(),
            ),
          ),
        ).toEqual(expected);
        const mismatched = yield* provider.useSession(otherUserId, action.providerSessionId);
        expect(
          Result.isFailure(yield* mismatched.inspectToolkits(["gmail"]).pipe(Effect.result)),
        ).toBe(true);
        expect(yield* action.session.inspectToolkits(["gmail"])).toEqual([
          { connectedAccount: null, isActive: false, slug: "gmail" },
        ]);
      }),
    (emulator) => Effect.promise(() => emulator.close()),
  ),
);

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

it.effect("selects Scheduled Email after an earlier completed immediate Gmail request", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const result = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              {
                content:
                  "Send this exact Gmail message now: recipient=first@example.test; subject=First; body=First body",
                role: "user",
              },
              { content: "The approved immediate Gmail Action is complete.", role: "assistant" },
              {
                content:
                  "Schedule this exact Gmail message: recipient=scheduled@example.test; subject=Scheduled; body=Scheduled body; sendAt=2026-09-06T01:11:57.202Z",
                role: "user",
              },
            ],
            tools: ["gmailSendEmail", "scheduleEmail"].map((name) => ({
              function: { name, parameters: { properties: {}, type: "object" } },
              type: "function" as const,
            })),
          }),
        );
        expect(result).toMatchObject({
          tool_calls: [
            {
              arguments: {
                body: "Scheduled body",
                gmailResource: "primary",
                recipients: ["scheduled@example.test"],
                scheduledAt: "2026-09-06T01:11:57.202Z",
                subject: "Scheduled",
              },
              name: "scheduleEmail",
            },
          ],
        });
      }),
    (emulator) => Effect.promise(emulator.close),
  ),
);

it.effect("does not replay immediate Gmail history after a newer JSON-content user request", () =>
  Effect.acquireUseRelease(
    Effect.promise(startProviderEmulator),
    (emulator) =>
      Effect.gen(function* () {
        const binding = ResearchVerificationProvider.makeAiBinding({
          _tag: "LocalVerification",
          baseURL: emulator.origin,
        });
        const result = yield* Effect.promise(() =>
          binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
            messages: [
              {
                content:
                  "Send this exact Gmail message now: recipient=first@example.test; subject=First; body=First body",
                role: "user",
              },
              { content: [{ type: "text", text: "Hello" }], role: "user" },
            ],
            tools: [
              {
                function: {
                  name: "gmailSendEmail",
                  parameters: { properties: {}, type: "object" },
                },
                type: "function",
              },
            ],
          }),
        );
        expect(result).not.toHaveProperty("tool_calls");
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

it.effect("renders only accepted WhatsApp text and templates in the selected inbox", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const emulator = yield* Effect.acquireRelease(
        Effect.promise(() => startRunProviderEmulator("verify-whatsapp-inbox")),
        (provider) => Effect.promise(() => provider.close()),
      );
      const post = (path: string, body: Schema.Json) =>
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(body);
          return yield* Effect.promise(() =>
            fetch(new URL(path, emulator.origin), {
              body: encoded,
              headers: { "content-type": "application/json" },
              method: "POST",
            }),
          );
        });
      const inbox = (query = "?channel=whatsapp") =>
        Effect.promise(() =>
          fetch(new URL(`/inbox${query}`, emulator.origin)).then((response) => response.text()),
        );
      expect(yield* inbox()).toContain("No accepted WhatsApp messages.");
      yield* post("/phone/messages", {
        messaging_product: "whatsapp",
        to: "15550000001",
        type: "template",
        template: { name: "osfo_update", language: { code: "en" } },
      });
      const templateInbox = yield* inbox();
      expect(templateInbox).toContain("Accepted template");
      expect(templateInbox).toContain("osfo_update (en)");
      expect(templateInbox).not.toContain("Accepted text message");
      yield* post("/phone/messages", {
        messaging_product: "whatsapp",
        to: "15550000001",
        type: "text",
        text: { body: "Reminder: <script>alert('private')</script> & tea" },
      });
      yield* post("/_test/whatsapp/next-response?status=503", {});
      expect(
        (yield* post("/phone/messages", {
          type: "text",
          text: { body: "Rejected reply" },
        })).status,
      ).toBe(503);
      expect(
        (yield* post("/phone/messages", {
          messaging_product: "whatsapp",
          status: "read",
          message_id: "wamid.inbound",
          typing_indicator: { type: "text" },
        })).status,
      ).toBe(200);
      const latest = yield* inbox();
      expect(latest).toContain("verify-whatsapp-inbox");
      expect(latest).toContain("Accepted text message");
      expect(latest).toContain("&lt;script&gt;alert(&#39;private&#39;)&lt;/script&gt; &amp; tea");
      expect(latest).not.toContain("<script>");
      expect(latest).not.toContain("Rejected reply");
      expect(latest).not.toContain("wamid.inbound");
      expect(latest).not.toContain("osfo_update");
      const history = yield* inbox("?channel=whatsapp&history=1");
      expect(history).toContain("Accepted template");
      expect(history).toContain("Accepted text message");
      expect(history).not.toContain("Rejected reply");
      expect(yield* inbox("")).toContain("No delivered Telegram messages.");
      const ledger = yield* Effect.promise(() =>
        fetch(new URL("/_test/whatsapp/ledger", emulator.origin)).then((response) =>
          response.json(),
        ),
      );
      expect(ledger).toHaveLength(4);
      expect(ledger).toEqual([
        expect.objectContaining({ accepted: true }),
        expect.objectContaining({ accepted: true }),
        expect.not.objectContaining({ accepted: true }),
        expect.not.objectContaining({ accepted: true }),
      ]);
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
      expect(
        Result.isFailure(yield* created.session.disconnect(accountId).pipe(Effect.result)),
      ).toBe(true);
      expect(
        yield* Effect.promise(() =>
          fetch(new URL("/_test/integrations/authority-operations", emulator.origin)).then(
            (response) => response.json(),
          ),
        ),
      ).toEqual([
        {
          connectedAccountId: accountId,
          operation: "revoke",
          userId,
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
        let revokeResponse: unknown;
        const deletion = LocalVerificationIntegrationProvider.makeAccountDeletion(
          emulator.origin,
          async (input, init) => {
            const response = await fetch(input, init);
            if (input.pathname.endsWith("/revoke") && response.ok) {
              revokeResponse = await response.clone().json();
            }
            return response;
          },
        );
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
        expect(revokeResponse).toEqual({
          connected_account: { id: deletingAccountId, status: "REVOKED" },
          revoked_tokens: ["access_token", "refresh_token"],
        });
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
        expect(
          yield* Effect.promise(() =>
            fetch(new URL("/_test/integrations/authority-operations", emulator.origin)).then(
              (response) => response.json(),
            ),
          ),
        ).toEqual([
          {
            connectedAccountId: deletingAccountId,
            operation: "revoke",
            userId: deletingUserId,
          },
          {
            connectedAccountId: deletingAccountId,
            operation: "delete",
            userId: deletingUserId,
          },
        ]);
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

it.effect(
  "selects one exact run-owned Reminder and directs its paused result to web approval",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(startProviderEmulator),
      (emulator) =>
        Effect.gen(function* () {
          const binding = ResearchVerificationProvider.makeAiBinding({
            _tag: "LocalVerification",
            baseURL: emulator.origin,
          });
          const request =
            "Create this exact run-owned one-time Reminder: run=verify-reminder-321; body=Private fixture body; firstDueAt=2026-09-06T12:00:00.000Z";
          const tools = [
            {
              function: {
                name: "osfoManageReminder",
                parameters: { properties: {}, type: "object" },
              },
              type: "function" as const,
            },
          ];
          const initial = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [{ content: request, role: "user" }],
              tools,
            }),
          );
          expect(initial).toMatchObject({
            tool_calls: [
              {
                id: "verification-reminder-verify-reminder-321",
                name: "osfoManageReminder",
                arguments: {
                  _tag: "CreateOneTime",
                  body: "Private fixture body",
                  firstDueAt: "2026-09-06T12:00:00.000Z",
                },
              },
            ],
          });
          const pausedMessage = {
            content: '{"status":"paused","action":"osfoManageReminder"}',
            name: "osfoManageReminder",
            role: "tool" as const,
            tool_call_id: "verification-reminder-verify-reminder-321",
          };
          const paused = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [{ content: request, role: "user" }, pausedMessage],
              tools,
            }),
          );
          expect(paused).toMatchObject({
            finish_reason: "stop",
            response: expect.stringContaining("/settings/reminders"),
          });
          const continued = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [
                { content: request, role: "user" },
                pausedMessage,
                {
                  content:
                    "Continue your previous response from exactly where it left off. Do not repeat any of it.",
                  role: "user",
                },
              ],
              tools,
            }),
          );
          expect(continued).not.toHaveProperty("tool_calls");
          const unowned = yield* Effect.promise(() =>
            binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
              messages: [{ content: "Remind me tomorrow", role: "user" }],
              tools,
            }),
          );
          expect(unowned).not.toHaveProperty("tool_calls");
        }),
      (emulator) => Effect.promise(emulator.close),
    ),
);

it.effect(
  "selects the current request when retrieved history contains Document Build identifiers",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(startProviderEmulator),
      (emulator) =>
        Effect.gen(function* () {
          const binding = ResearchVerificationProvider.makeAiBinding({
            _tag: "LocalVerification",
            baseURL: emulator.origin,
          });
          const history =
            "## Recent unindexed conversation source evidence\nBuild a PDF using web:00000000-0000-4000-8000-000000000001.\nInspect Document Build document-build:historical-document-0001 status.\n\n";
          const scenarios = [
            {
              request:
                "Research durable Workflow verification using public sources and create a cited PDF report.",
              selectedTool: "startResearchReport",
            },
            {
              request:
                "Schedule this exact Gmail message: recipient=person@example.test; subject=Exact subject; body=Exact body; sendAt=2026-09-06T12:00:00.000Z",
              selectedTool: "scheduleEmail",
            },
            {
              request:
                "Create this exact run-owned one-time Reminder: run=verify-reminder-history; body=Private fixture body; firstDueAt=2026-09-06T12:00:00.000Z",
              selectedTool: "osfoManageReminder",
            },
          ];
          for (const scenario of scenarios) {
            const result = yield* Effect.promise(() =>
              binding.run("@cf/deepseek-ai/deepseek-v4-flash-0731", {
                messages: [{ content: `${history}${scenario.request}`, role: "user" }],
                tools: ["loadSkill", scenario.selectedTool].map((name) => ({
                  function: { name, parameters: { properties: {}, type: "object" } },
                  type: "function" as const,
                })),
              }),
            );
            expect(result).toMatchObject({ tool_calls: [{ name: scenario.selectedTool }] });
          }
        }),
      (emulator) => Effect.promise(emulator.close),
    ),
);
