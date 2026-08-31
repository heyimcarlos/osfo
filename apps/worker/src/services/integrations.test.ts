/* oxlint-disable effecttsgo/global-date-in-effect, eslint/no-underscore-dangle, vitest/no-standalone-expect -- Tests use fixed Date evidence and inspect tagged Effect outcomes. */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import { ActionId } from "../domain/action-execution";
import { AllowancePeriodId, ManifestVersion, UserId } from "../domain";
import {
  ExistingUsage,
  Recorded,
  UsageConflict,
  type AllowanceItem,
  type AllowanceSource,
} from "../domain/allowance";
import { retainedCatalog } from "../domain/plan-policy";
import { Allowances } from "./allowances";
import {
  directIntegrationProviderConfig,
  IntegrationProviderUnavailable,
  IntegrationEffectFinalizationUnavailable,
  make,
  type IntegrationEffectFinalOutcome,
  type IntegrationPersistence,
  type IntegrationProvider,
  type PersistedIntegrationAction,
  type ProviderExecutionResult,
  type ProviderExecutionEvidence,
  type ProviderInput,
  type ProviderSession,
} from "./integrations";

const userId = UserId.make("user-1");

describe("Integrations", () => {
  it.effect("creates one confined provider session and resumes its stable User mapping", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const integrations = make(harness);

      expect(yield* integrations.resolveSession(userId)).toEqual({
        _tag: "IntegrationSessionResolved",
        resumed: false,
        userId,
      });
      expect(yield* integrations.resolveSession(userId)).toEqual({
        _tag: "IntegrationSessionResolved",
        resumed: true,
        userId,
      });

      expect(harness.created).toEqual([{ config: directIntegrationProviderConfig, userId }]);
      expect(harness.used).toEqual(["provider-session-1"]);
      expect(directIntegrationProviderConfig).toMatchObject({
        manageConnections: false,
        multiAccount: false,
        preset: "direct-tools",
        sandbox: false,
      });
      expect(directIntegrationProviderConfig.tools).not.toContain("COMPOSIO_SEARCH_TOOLS");
      expect(
        directIntegrationProviderConfig.tools.some((tool) =>
          /MULTI_EXECUTE|MANAGE_CONNECTIONS|WORKBENCH|BASH|SANDBOX/u.test(tool),
        ),
      ).toBe(false);
    }),
  );

  it.effect("replaces a retained provider session that can no longer be resumed", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.sessions.set(userId, "stale-session");
      harness.missingSessions.add("stale-session");

      expect(yield* make(harness).resolveSession(userId)).toEqual({
        _tag: "IntegrationSessionResolved",
        resumed: false,
        userId,
      });
      expect(harness.sessions.get(userId)).toBe("provider-session-1");
      expect(harness.used).toEqual(["stale-session"]);
      expect(harness.created).toHaveLength(1);
    }),
  );

  it.effect(
    "returns closed current connection evidence and fails closed on account ambiguity",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        const integrations = make(harness);

        harness.toolkits = [{ connectedAccount: null, isActive: false, slug: "gmail" }];
        expect(yield* integrations.connectionEvidence({ toolkit: "gmail", userId })).toEqual({
          _tag: "IntegrationConnectionMissing",
          toolkit: "gmail",
          userId,
        });

        harness.toolkits = [
          {
            connectedAccount: { id: "private-account-id", status: "ACTIVE" },
            isActive: true,
            slug: "gmail",
          },
        ];
        expect(yield* integrations.connectionEvidence({ toolkit: "gmail", userId })).toEqual({
          _tag: "IntegrationConnectionConnected",
          toolkit: "gmail",
          userId,
        });

        harness.toolkits = [
          {
            connectedAccount: { id: "account-1", status: "ACTIVE" },
            isActive: true,
            slug: "gmail",
          },
          {
            connectedAccount: { id: "account-2", status: "ACTIVE" },
            isActive: true,
            slug: "gmail",
          },
        ];
        expect(yield* integrations.connectionEvidence({ toolkit: "gmail", userId })).toEqual({
          _tag: "IntegrationConnectionAmbiguous",
          toolkit: "gmail",
          userId,
        });
      }),
  );

  it.effect("acquires only a hosted Connect Link for an allowlisted toolkit", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const integrations = make(harness);
      const result = yield* integrations.connectLink({
        callbackUrl: new URL("https://app.osfo.dev/integrations/callback"),
        toolkit: "gmail",
        userId,
      });

      expect(result).toEqual({
        _tag: "IntegrationConnectLinkReady",
        redirectUrl: new URL("https://connect.composio.dev/link"),
        toolkit: "gmail",
        userId,
      });
      expect(harness.authorized).toEqual([
        { callbackUrl: "https://app.osfo.dev/integrations/callback", toolkit: "gmail" },
      ]);
    }),
  );

  it.effect("uses the sole active account and revokes stale toolkit accounts on disconnect", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push(
        {
          connectedAccount: { id: "stale-account", status: "EXPIRED" },
          isActive: false,
          slug: "gmail",
        },
        {
          connectedAccount: { id: "active-account", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      );
      const integrations = make(harness);

      expect(yield* integrations.connectionEvidence({ toolkit: "gmail", userId })).toMatchObject({
        _tag: "IntegrationConnectionConnected",
      });
      expect(yield* integrations.disconnect({ toolkit: "gmail", userId })).toEqual({
        _tag: "IntegrationConnectionRevoked",
        toolkit: "gmail",
      });
      expect(harness.disconnected).toEqual(["stale-account", "active-account"]);
    }),
  );

  it.effect("denies unknown toolkits before resolving or inspecting a provider session", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const failure = yield* Effect.flip(
        make(harness).connectionEvidence({ toolkit: "provider-meta", userId }),
      );

      expect(failure).toMatchObject({
        _tag: "IntegrationManifestUnavailable",
        operation: "CONNECTION_EVIDENCE",
        toolkit: "provider-meta",
      });
      expect(harness.created).toEqual([]);
      expect(harness.toolkitsInspected).toBe(0);
    }),
  );

  it.effect("denies an unknown operation before authority, connection, or provider execution", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const integrations = make(harness);
      let authorityChecks = 0;
      const exit = yield* Effect.exit(
        integrations.execute({
          authorize: Effect.sync(() => {
            authorityChecks += 1;
          }),
          identity: {
            manifestVersion: ManifestVersion.make("gmail-v1"),
            operation: "GMAIL_PROVIDER_DISCOVERY",
            toolkit: "gmail",
          },
          input: {},
          userId,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "IntegrationManifestUnavailable",
        });
      }
      expect(authorityChecks).toBe(0);
      expect(harness.executed).toEqual([]);
      expect(harness.toolkitsInspected).toBe(0);
    }),
  );

  it.effect("rechecks authority immediately before one effect and replays an applied Action", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeResult = {
        data: { id: "provider-message-1", threadId: "provider-thread-1" },
        error: null,
        logId: "composio-log-1",
      };
      const integrations = make(harness);
      let authorityChecks = 0;
      const request = {
        actionId: ActionId.make("action-1"),
        authorize: Effect.sync(() => {
          authorityChecks += 1;
        }),
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;

      const first = yield* integrations.execute(request);
      const replay = yield* integrations.execute(request);

      expect(first).toEqual(replay);
      expect(authorityChecks).toBe(1);
      expect(first).toMatchObject({
        _tag: "IntegrationEffectCompleted",
        evidence: {
          providerLogId: "composio-log-1",
          providerResourceId: "provider-message-1",
        },
        operation: "GMAIL_SEND_EMAIL",
      });
      expect(harness.executed).toEqual([
        {
          connectedAccountId: "account-1",
          input: {
            body: "Hello",
            is_html: false,
            recipient_email: "person@example.test",
            subject: "Subject",
            user_id: "me",
          },
          providerTool: "GMAIL_SEND_EMAIL",
        },
      ]);
    }),
  );

  it.effect("retains one Gmail-send fact after final Applied evidence across replay", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeResult = {
        data: { id: "provider-message-accounted" },
        error: null,
        logId: "composio-log-accounted",
      };
      const integrations = make(harness);
      const accounting = makeActionAccounting();
      const finalizeEffect = accounting.finalize(ActionId.make("action-accounted"));
      const request = {
        actionId: ActionId.make("action-accounted"),
        authorize: Effect.void,
        finalizeEffect,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;

      yield* integrations.execute(request);
      yield* integrations.execute(request);

      expect(accounting.retained).toEqual([
        {
          items: [{ allowanceKind: "gmailSends", basis: "observed", quantity: 1n }],
          source: { sourceId: "action-accounted", sourceType: "integrationAction" },
        },
      ]);
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("leaves initial and reconcilable Gmail ambiguity unaccounted", () =>
    Effect.gen(function* () {
      const harness = makeAmbiguousGmailHarness();
      const actionId = ActionId.make("action-ambiguous-unaccounted");
      const accounting = makeActionAccounting();
      const request = gmailEffectRequest(actionId, accounting.finalize(actionId));
      yield* TestClock.setTime(1);

      expect(yield* make(harness).execute(request).pipe(Effect.result)).toMatchObject({
        failure: { _tag: "IntegrationActionAmbiguous" },
      });
      expect(accounting.retained).toEqual([]);

      yield* TestClock.setTime(120_001);
      expect(yield* make(harness).inspectAction(request)).toEqual({
        _tag: "Ambiguous",
        retryAfterMilliseconds: 180_000,
      });
      expect(accounting.retained).toEqual([]);
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("keeps a reconciled NotApplied Gmail Action at zero across restart", () =>
    Effect.gen(function* () {
      const harness = makeAmbiguousGmailHarness();
      const actionId = ActionId.make("action-reconciled-not-applied");
      const accounting = makeActionAccounting();
      const request = gmailEffectRequest(actionId, accounting.finalize(actionId));
      yield* TestClock.setTime(1);
      yield* make(harness).execute(request).pipe(Effect.result);
      harness.inspectionEvidence = {
        _tag: "NotApplied",
        providerLogId: "provider-log-not-applied",
      };
      yield* TestClock.setTime(120_001);

      expect(yield* make(harness).inspectAction(request)).toEqual({
        _tag: "NotApplied",
        providerLogId: "provider-log-not-applied",
      });
      expect(yield* make(harness).inspectAction(request)).toEqual({
        _tag: "NotApplied",
        providerLogId: "provider-log-not-applied",
      });
      expect(accounting.retained).toEqual([]);
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("records one observed Gmail fact after Applied reconciliation across restart", () =>
    Effect.gen(function* () {
      const harness = makeAmbiguousGmailHarness();
      const actionId = ActionId.make("action-reconciled-applied");
      const accounting = makeActionAccounting();
      const request = gmailEffectRequest(actionId, accounting.finalize(actionId));
      yield* TestClock.setTime(1);
      yield* make(harness).execute(request).pipe(Effect.result);
      harness.inspectionEvidence = {
        _tag: "Applied",
        execution: {
          data: { id: "provider-message-reconciled" },
          error: null,
          logId: "provider-log-reconciled",
        },
      };
      yield* TestClock.setTime(120_001);

      expect(yield* make(harness).inspectAction(request)).toMatchObject({ _tag: "Applied" });
      expect(yield* make(harness).inspectAction(request)).toMatchObject({ _tag: "Applied" });
      expect(accounting.retained).toEqual([
        {
          items: [{ allowanceKind: "gmailSends", basis: "observed", quantity: 1n }],
          source: { sourceId: actionId, sourceType: "integrationAction" },
        },
      ]);
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("records one conservative Gmail fact only after the evidence horizon closes", () =>
    Effect.gen(function* () {
      const harness = makeAmbiguousGmailHarness();
      const actionId = ActionId.make("action-terminal-ambiguous");
      const accounting = makeActionAccounting();
      const request = gmailEffectRequest(actionId, accounting.finalize(actionId));
      yield* TestClock.setTime(1);
      yield* make(harness).execute(request).pipe(Effect.result);
      yield* TestClock.setTime(300_000);

      expect(yield* make(harness).inspectAction(request)).toEqual({
        _tag: "Ambiguous",
        retryAfterMilliseconds: 1,
      });
      expect(accounting.retained).toEqual([]);

      yield* TestClock.setTime(300_001);
      expect(yield* make(harness).inspectAction(request)).toEqual({ _tag: "TerminalAmbiguous" });
      harness.inspectionEvidence = {
        _tag: "Applied",
        execution: {
          data: { id: "late-provider-message" },
          error: null,
          logId: "late-provider-log",
        },
      };
      expect(yield* make(harness).inspectAction(request)).toEqual({ _tag: "TerminalAmbiguous" });
      expect(harness.actions.get(actionId)).toMatchObject({ _tag: "TerminalAmbiguous" });
      expect(accounting.retained).toEqual([
        {
          items: [{ allowanceKind: "gmailSends", basis: "conservative", quantity: 1n }],
          source: { sourceId: actionId, sourceType: "integrationAction" },
        },
      ]);
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("terminalizes a discarded provider session only after the evidence horizon", () =>
    Effect.gen(function* () {
      const harness = makeAmbiguousGmailHarness();
      const actionId = ActionId.make("action-missing-reconciliation-session");
      const accounting = makeActionAccounting();
      const request = gmailEffectRequest(actionId, accounting.finalize(actionId));
      yield* TestClock.setTime(1);
      yield* make(harness).execute(request).pipe(Effect.result);
      expect(harness.created).toHaveLength(1);
      harness.missingSessions.add("provider-session-1");

      yield* TestClock.setTime(120_001);
      expect(yield* make(harness).inspectAction(request)).toEqual({
        _tag: "Ambiguous",
        retryAfterMilliseconds: 180_000,
      });
      expect(accounting.retained).toEqual([]);

      yield* TestClock.setTime(300_001);
      expect(yield* make(harness).inspectAction(request)).toEqual({
        _tag: "TerminalAmbiguous",
      });
      expect(harness.actions.get(actionId)).toMatchObject({ _tag: "TerminalAmbiguous" });
      expect(accounting.retained).toEqual([
        {
          items: [{ allowanceKind: "gmailSends", basis: "conservative", quantity: 1n }],
          source: { sourceId: actionId, sourceType: "integrationAction" },
        },
      ]);
    }),
  );

  it.effect("inspects one exact effect Action without provider I/O", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeResult = {
        data: { id: "provider-message-1" },
        error: null,
        logId: "composio-log-1",
      };
      const integrations = make(harness);
      const exact = {
        actionId: ActionId.make("inspect-action"),
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;

      expect(yield* integrations.inspectAction(exact)).toEqual({ _tag: "NotStarted" });
      const result = yield* integrations.execute({
        ...exact,
        authorize: Effect.void,
        userId,
      });
      expect(yield* integrations.inspectAction(exact)).toEqual({
        _tag: "Applied",
        result,
      });
      expect(
        yield* integrations
          .inspectAction({ ...exact, input: { ...exact.input, body: "changed" } })
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "IntegrationActionConflict" } });
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("retains malformed post-provider success as ambiguous", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeResult = { data: {}, error: null, logId: "malformed-success-log" };
      const actionId = ActionId.make("malformed-success-action");
      const integrations = make(harness);
      const exact = {
        actionId,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;

      expect(
        yield* integrations.execute({ ...exact, authorize: Effect.void }).pipe(Effect.result),
      ).toMatchObject({
        failure: { _tag: "IntegrationExecutionRejected", code: "resultInvalid" },
      });
      expect(harness.actions.get(actionId)).toMatchObject({ _tag: "Ambiguous" });
      expect(yield* integrations.inspectAction(exact)).toMatchObject({ _tag: "Ambiguous" });
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("prevents provider execution when current Osfo authority is lost", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      const integrations = make(harness);
      const exit = yield* Effect.exit(
        integrations.execute({
          actionId: ActionId.make("action-authority-lost"),
          authorize: Effect.fail(new TestAuthorityLost({ message: "Current authority is gone" })),
          identity: {
            manifestVersion: ManifestVersion.make("gmail-v1"),
            operation: "GMAIL_SEND_EMAIL",
            toolkit: "gmail",
          },
          input: {
            body: "Hello",
            gmailResource: "primary",
            recipients: ["person@example.test"],
            subject: "Subject",
          },
          userId,
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(harness.executed).toEqual([]);
      expect(harness.actions.size).toBe(0);
    }),
  );

  it.effect("discovers the connection before final authority and does not claim after denial", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-before-approval", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      const integrations = make(harness);
      const failure = yield* Effect.flip(
        integrations.execute({
          actionId: ActionId.make("action-connection-revoked"),
          authorize: Effect.gen(function* () {
            expect(harness.toolkitsInspected).toBe(1);
            harness.toolkits = [{ connectedAccount: null, isActive: false, slug: "gmail" }];
            return yield* new TestAuthorityLost({ message: "Current authority is gone" });
          }),
          identity: {
            manifestVersion: ManifestVersion.make("gmail-v1"),
            operation: "GMAIL_SEND_EMAIL",
            toolkit: "gmail",
          },
          input: {
            body: "Hello",
            gmailResource: "primary",
            recipients: ["person@example.test"],
            subject: "Subject",
          },
          userId,
        }),
      );

      expect(failure).toMatchObject({ _tag: "TestAuthorityLost" });
      expect(harness.executed).toEqual([]);
      expect(harness.actions.size).toBe(0);
    }),
  );

  it.effect(
    "bounds large reads and drops provider fields outside the manifest output contract",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        harness.toolkits = [
          {
            connectedAccount: { id: "account-1", status: "ACTIVE" },
            isActive: true,
            slug: "gmail",
          },
        ];
        harness.executeResult = {
          data: {
            messages: Array.from({ length: 30 }, (_, index) => ({
              body: "x".repeat(10_000),
              id: `message-${index}`,
              providerSecret: "must-not-cross",
              subject: `Subject ${index}`,
            })),
          },
          error: null,
          logId: "composio-log-large",
        };
        const result = yield* make(harness).execute({
          authorize: Effect.void,
          identity: {
            manifestVersion: ManifestVersion.make("gmail-v1"),
            operation: "GMAIL_FETCH_THREAD",
            toolkit: "gmail",
          },
          input: { includeAttachments: false, maximumMessages: 20, threadId: "thread-1" },
          userId,
        });

        expect(result).toMatchObject({
          _tag: "IntegrationReadCompleted",
          evidence: { providerLogIds: ["composio-log-large"] },
          truncated: true,
        });
        if (result._tag === "IntegrationReadCompleted") {
          expect(result.records).toHaveLength(20);
          expect(result.responseBytes).toBeLessThanOrEqual(65_536n);
          expect(result.records[0]).not.toHaveProperty("providerSecret");
          expect(result.records[0]?.body).toHaveLength(2_500);
        }
      }),
  );

  it.effect(
    "rejects a malformed provider read instead of admitting an empty normalized result",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        harness.toolkits = [
          {
            connectedAccount: { id: "account-1", status: "ACTIVE" },
            isActive: true,
            slug: "gmail",
          },
        ];
        harness.executeResult = {
          data: { providerPayload: "secret-token-value" },
          error: null,
          logId: "composio-log-malformed",
        };

        const failure = yield* Effect.flip(
          make(harness).execute({
            authorize: Effect.void,
            identity: {
              manifestVersion: ManifestVersion.make("gmail-v1"),
              operation: "GMAIL_FETCH_THREAD",
              toolkit: "gmail",
            },
            input: { includeAttachments: false, maximumMessages: 20, threadId: "thread-1" },
            userId,
          }),
        );

        expect(failure).toMatchObject({
          _tag: "IntegrationExecutionRejected",
          code: "resultInvalid",
        });
        expect(failure).not.toHaveProperty("providerPayload");
      }),
  );

  it.effect("translates provider-neutral bounded reads into exact provider inputs", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const integrations = make(harness);

      harness.toolkits.splice(0, Infinity, {
        connectedAccount: { id: "gmail-account", status: "ACTIVE" },
        isActive: true,
        slug: "gmail",
      });
      harness.executeResult = {
        data: { messages: [{ id: "message-1", subject: "Subject" }] },
        error: null,
        logId: "gmail-search-log",
      };
      yield* integrations.execute({
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEARCH_EMAILS",
          toolkit: "gmail",
        },
        input: {
          includeSpamTrash: false,
          maximumMessages: 5,
          query: "after:2026/08/01",
        },
        userId,
      });

      harness.toolkits.splice(0, Infinity, {
        connectedAccount: { id: "calendar-account", status: "ACTIVE" },
        isActive: true,
        slug: "googlecalendar",
      });
      harness.executeResult = {
        data: {
          freeSlots: [{ end: "2026-08-28T11:00:00-04:00", start: "2026-08-28T10:00:00-04:00" }],
        },
        error: null,
        logId: "calendar-availability-log",
      };
      yield* integrations.execute({
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("calendar-v1"),
          operation: "CALENDAR_FIND_AVAILABILITY",
          toolkit: "googlecalendar",
        },
        input: {
          calendarId: "primary",
          endsAt: "2026-08-28T18:00:00-04:00",
          minimumSlotMinutes: 30,
          startsAt: "2026-08-28T09:00:00-04:00",
          timeZone: "America/Toronto",
        },
        userId,
      });

      harness.toolkits.splice(0, Infinity, {
        connectedAccount: { id: "drive-account", status: "ACTIVE" },
        isActive: true,
        slug: "googledrive",
      });
      harness.executeResult = {
        data: { files: [{ id: "file-1", name: "Notes" }] },
        error: null,
        logId: "drive-search-log",
      };
      yield* integrations.execute({
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("drive-v1"),
          operation: "DRIVE_SEARCH",
          toolkit: "googledrive",
        },
        input: {
          maximumFiles: 7,
          query: "Notes' or trashed = true",
          searchOwnedOnly: true,
        },
        userId,
      });

      expect(harness.executed).toEqual([
        {
          connectedAccountId: "gmail-account",
          input: {
            ids_only: false,
            include_payload: false,
            include_spam_trash: false,
            max_results: 5,
            query: "after:2026/08/01",
            user_id: "me",
            verbose: false,
          },
          providerTool: "GMAIL_FETCH_EMAILS",
        },
        {
          connectedAccountId: "calendar-account",
          input: {
            calendar_expansion_max: 1,
            group_expansion_max: 1,
            items: ["primary"],
            time_max: "2026-08-28T18:00:00-04:00",
            time_min: "2026-08-28T09:00:00-04:00",
            timezone: "America/Toronto",
          },
          providerTool: "GOOGLECALENDAR_FIND_FREE_SLOTS",
        },
        {
          connectedAccountId: "drive-account",
          input: {
            corpora: "user",
            fields:
              "files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed)",
            includeItemsFromAllDrives: false,
            pageSize: 7,
            q: "name contains 'Notes\\' or trashed = true' and 'me' in owners and trashed = false",
            spaces: "drive",
            supportsAllDrives: false,
          },
          providerTool: "GOOGLEDRIVE_FIND_FILE",
        },
      ]);
    }),
  );

  it.effect("translates exact-approved Calendar effects without broadening their scope", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push({
        connectedAccount: { id: "calendar-account", status: "ACTIVE" },
        isActive: true,
        slug: "googlecalendar",
      });
      harness.executeResult = {
        data: { id: "event-1" },
        error: null,
        logId: "calendar-log",
      };
      const integrations = make(harness);

      yield* integrations.execute({
        actionId: ActionId.make("calendar-create"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("calendar-v1"),
          operation: "CALENDAR_CREATE_EVENT",
          toolkit: "googlecalendar",
        },
        input: {
          attendeeCount: 0,
          calendarId: "primary",
          endsAt: "2026-09-01T11:00:00-04:00",
          recurrence: { count: 5, frequency: "WEEKLY", interval: 2 },
          sendNotifications: false,
          startsAt: "2026-09-01T10:00:00-04:00",
          timeZone: "America/Toronto",
          title: "Planning",
        },
        userId,
      });
      yield* integrations.execute({
        actionId: ActionId.make("calendar-update"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("calendar-v1"),
          operation: "CALENDAR_UPDATE_EVENT",
          toolkit: "googlecalendar",
        },
        input: {
          calendarId: "primary",
          changes: { recurrence: null, title: "Updated planning" },
          eventId: "event-1",
          sendNotifications: false,
        },
        userId,
      });
      yield* integrations.execute({
        actionId: ActionId.make("calendar-delete"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("calendar-v1"),
          operation: "CALENDAR_DELETE_EVENT",
          toolkit: "googlecalendar",
        },
        input: {
          calendarId: "primary",
          eventId: "recurring-event",
          sendNotifications: false,
        },
        userId,
      });

      expect(harness.executed).toEqual([
        {
          connectedAccountId: "calendar-account",
          input: {
            attendees: [],
            calendar_id: "primary",
            create_meeting_room: false,
            end_datetime: "2026-09-01T11:00:00-04:00",
            exclude_organizer: true,
            recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=5"],
            send_updates: "none",
            start_datetime: "2026-09-01T10:00:00-04:00",
            summary: "Planning",
            timezone: "America/Toronto",
            visibility: "private",
          },
          providerTool: "GOOGLECALENDAR_CREATE_EVENT",
        },
        {
          connectedAccountId: "calendar-account",
          input: {
            calendar_id: "primary",
            event_id: "event-1",
            recurrence: [],
            send_updates: "none",
            summary: "Updated planning",
          },
          providerTool: "GOOGLECALENDAR_PATCH_EVENT",
        },
        {
          connectedAccountId: "calendar-account",
          input: {
            calendar_id: "primary",
            event_id: "recurring-event",
            send_updates: "none",
          },
          providerTool: "GOOGLECALENDAR_DELETE_EVENT",
        },
      ]);
    }),
  );

  it.effect("passes the approved Drive read byte ceiling to the provider boundary", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push({
        connectedAccount: { id: "drive-account", status: "ACTIVE" },
        isActive: true,
        slug: "googledrive",
      });
      harness.executeResult = {
        data: {
          content: "bounded",
          fileId: "file-1",
          mimeType: "text/plain",
          name: "notes.txt",
          size: 7,
          truncated: false,
        },
        error: null,
        logId: "drive-read-log",
        supportingLogIds: ["drive-metadata-log"],
      };

      yield* make(harness).execute({
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("drive-v1"),
          operation: "DRIVE_READ_FILE",
          toolkit: "googledrive",
        },
        input: {
          expectedMediaType: "text/plain",
          fileId: "file-1",
          maximumBytes: 8,
        },
        userId,
      });

      expect(harness.executed).toEqual([
        {
          connectedAccountId: "drive-account",
          constraints: { maximumDownloadBytes: 8 },
          input: { fileId: "file-1", mime_type: "text/plain" },
          providerTool: "GOOGLEDRIVE_DOWNLOAD_FILE",
        },
      ]);
    }),
  );

  it.effect("rejects Drive metadata and content for a different requested file", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push({
        connectedAccount: { id: "drive-account", status: "ACTIVE" },
        isActive: true,
        slug: "googledrive",
      });
      const integrations = make(harness);
      harness.executeResult = {
        data: { id: "different-file", mimeType: "text/plain", name: "notes.txt" },
        error: null,
        logId: "drive-metadata-log",
      };

      const metadataFailure = yield* Effect.flip(
        integrations.execute({
          authorize: Effect.void,
          identity: {
            manifestVersion: ManifestVersion.make("drive-v1"),
            operation: "DRIVE_GET_METADATA",
            toolkit: "googledrive",
          },
          input: { fileId: "file-1" },
          userId,
        }),
      );
      expect(metadataFailure).toMatchObject({
        _tag: "IntegrationExecutionRejected",
        code: "resultInvalid",
      });

      harness.executeResult = {
        data: {
          content: "bounded",
          fileId: "different-file",
          mimeType: "text/plain",
          name: "notes.txt",
          size: 7,
          truncated: false,
        },
        error: null,
        logId: "drive-read-log",
        supportingLogIds: ["drive-metadata-log"],
      };
      const contentFailure = yield* Effect.flip(
        integrations.execute({
          authorize: Effect.void,
          identity: {
            manifestVersion: ManifestVersion.make("drive-v1"),
            operation: "DRIVE_READ_FILE",
            toolkit: "googledrive",
          },
          input: {
            expectedMediaType: "text/plain",
            fileId: "file-1",
            maximumBytes: 8,
          },
          userId,
        }),
      );
      expect(contentFailure).toMatchObject({
        _tag: "IntegrationExecutionRejected",
        code: "resultInvalid",
      });
    }),
  );

  it.effect("stages only the exact owned Drive artifact and replays its applied Action", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push({
        connectedAccount: { id: "drive-account", status: "ACTIVE" },
        isActive: true,
        slug: "googledrive",
      });
      harness.executeResult = {
        data: { id: "uploaded-file" },
        error: null,
        logId: "drive-upload-log",
      };
      const integrations = make({
        ...harness,
        readOwned: () =>
          Effect.succeed({
            bytes: new Uint8Array([1, 2, 3]),
            fileName: "report.pdf",
            mediaType: "application/pdf",
          }),
      });
      const request = {
        actionId: ActionId.make("drive-delivery"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("drive-v1"),
          operation: "DRIVE_DELIVER_ARTIFACT",
          toolkit: "googledrive",
        },
        input: {
          artifactId: "artifact-1",
          expectedBytes: 3,
          fileName: "report.pdf",
          mediaType: "application/pdf",
          targetFolderId: null,
        },
        userId,
      } as const;

      const completed = yield* integrations.execute(request);
      expect(yield* integrations.execute(request)).toEqual(completed);
      expect(harness.executed).toEqual([
        {
          connectedAccountId: "drive-account",
          input: {
            file_to_upload: {
              mimetype: "application/pdf",
              name: "report.pdf",
              s3key: "staged-file-key",
            },
            folder_to_upload_to: null,
          },
          providerTool: "GOOGLEDRIVE_UPLOAD_FILE",
        },
      ]);
    }),
  );

  it.effect("leaves a Drive Action retryable when owned artifact access is not configured", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push({
        connectedAccount: { id: "drive-account", status: "ACTIVE" },
        isActive: true,
        slug: "googledrive",
      });
      const actionId = ActionId.make("drive-no-artifact-access");

      expect(
        yield* Effect.flip(
          make(harness).execute({
            actionId,
            authorize: Effect.void,
            identity: {
              manifestVersion: ManifestVersion.make("drive-v1"),
              operation: "DRIVE_DELIVER_ARTIFACT",
              toolkit: "googledrive",
            },
            input: {
              artifactId: "artifact-1",
              expectedBytes: 3,
              fileName: "report.pdf",
              mediaType: "application/pdf",
              targetFolderId: null,
            },
            userId,
          }),
        ),
      ).toMatchObject({ _tag: "IntegrationExecutionRejected", code: "providerUnavailable" });
      expect(harness.actions.get(actionId)).toMatchObject({ _tag: "NotApplied" });
      expect(harness.staged).toEqual([]);
      expect(harness.executed).toEqual([]);
    }),
  );

  it.effect("fences an uncertain Drive staging attempt before any retry can duplicate it", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push({
        connectedAccount: { id: "drive-account", status: "ACTIVE" },
        isActive: true,
        slug: "googledrive",
      });
      harness.stageFailure = new IntegrationProviderUnavailable({
        cause: "stageFile",
        message: "The staging response was lost",
        operation: "stageFile",
        reason: "unavailable",
      });
      const integrations = make({
        ...harness,
        readOwned: () =>
          Effect.succeed({
            bytes: new Uint8Array([1, 2, 3]),
            fileName: "report.pdf",
            mediaType: "application/pdf",
          }),
      });
      const request = {
        actionId: ActionId.make("drive-staging-ambiguous"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("drive-v1"),
          operation: "DRIVE_DELIVER_ARTIFACT",
          toolkit: "googledrive",
        },
        input: {
          artifactId: "artifact-1",
          expectedBytes: 3,
          fileName: "report.pdf",
          mediaType: "application/pdf",
          targetFolderId: null,
        },
        userId,
      } as const;

      expect(yield* Effect.flip(integrations.execute(request))).toMatchObject({
        _tag: "IntegrationActionAmbiguous",
      });
      expect(harness.actions.get(request.actionId)).toMatchObject({ _tag: "Ambiguous" });
      expect(harness.staged).toHaveLength(1);

      expect(yield* Effect.flip(integrations.execute(request))).toMatchObject({
        _tag: "IntegrationActionAmbiguous",
      });
      expect(harness.staged).toHaveLength(1);
      expect(harness.executed).toEqual([]);
    }),
  );

  it.effect(
    "retains an ambiguous Action after provider transport loss and never retries it blindly",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        harness.toolkits = [
          {
            connectedAccount: { id: "account-1", status: "ACTIVE" },
            isActive: true,
            slug: "gmail",
          },
        ];
        harness.executeFailure = new IntegrationProviderUnavailable({
          cause: "execute",
          message: "The provider response was lost",
          operation: "execute",
          reason: "unavailable",
        });
        const request = {
          actionId: ActionId.make("action-ambiguous"),
          authorize: Effect.void,
          identity: {
            manifestVersion: ManifestVersion.make("gmail-v1"),
            operation: "GMAIL_SEND_EMAIL",
            toolkit: "gmail",
          },
          input: {
            body: "Hello",
            gmailResource: "primary",
            recipients: ["person@example.test"],
            subject: "Subject",
          },
          userId,
        } as const;

        expect((yield* Effect.flip(make(harness).execute(request)))._tag).toBe(
          "IntegrationActionAmbiguous",
        );
        harness.executeFailure = null;
        expect((yield* Effect.flip(make(harness).execute(request)))._tag).toBe(
          "IntegrationActionAmbiguous",
        );
        expect(harness.executed).toHaveLength(1);
      }),
  );

  it.effect("correlates identical concurrent effects to distinct provider sessions", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeFailure = new IntegrationProviderUnavailable({
        cause: "execute",
        message: "The provider response was lost",
        operation: "execute",
        reason: "unavailable",
      });
      const integrations = make(harness);
      const exact = {
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Identical body",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Identical subject",
        },
        userId,
      } as const;

      yield* integrations
        .execute({ ...exact, actionId: ActionId.make("identical-action-1") })
        .pipe(Effect.result);
      yield* integrations
        .execute({ ...exact, actionId: ActionId.make("identical-action-2") })
        .pipe(Effect.result);

      expect(harness.actions.get(ActionId.make("identical-action-1"))).toMatchObject({
        correlation: { providerSessionId: "provider-session-1" },
      });
      expect(harness.actions.get(ActionId.make("identical-action-2"))).toMatchObject({
        correlation: { providerSessionId: "provider-session-2" },
      });
      expect(harness.executed).toHaveLength(2);
    }),
  );

  it.effect("settles ambiguous Actions only from exact provider evidence", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeFailure = new IntegrationProviderUnavailable({
        cause: "execute",
        message: "The provider response was lost",
        operation: "execute",
        reason: "unavailable",
      });
      const integrations = make(harness);
      const request = {
        actionId: ActionId.make("action-evidence-repair"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;

      expect(yield* integrations.execute(request).pipe(Effect.result)).toMatchObject({
        failure: { _tag: "IntegrationActionAmbiguous" },
      });
      expect(yield* integrations.inspectAction(request)).toMatchObject({ _tag: "Ambiguous" });
      harness.inspectionEvidence = {
        _tag: "Applied",
        execution: {
          data: { id: "provider-message-reconciled" },
          error: null,
          logId: "provider-log-reconciled",
        },
      };
      expect(yield* integrations.inspectAction(request)).toMatchObject({
        _tag: "Applied",
        result: {
          evidence: {
            providerLogId: "provider-log-reconciled",
            providerResourceId: "provider-message-reconciled",
          },
        },
      });
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("ages stale Pending truth into ambiguity without another provider call", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeFailure = new IntegrationProviderUnavailable({
        cause: "execute",
        message: "The provider response was lost",
        operation: "execute",
        reason: "unavailable",
      });
      const integrations = make(harness);
      const request = {
        actionId: ActionId.make("stale-pending-action"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;
      yield* TestClock.setTime(1);
      yield* integrations.execute(request).pipe(Effect.result);
      const retained = harness.actions.get(request.actionId);
      if (retained?._tag !== "Ambiguous") throw new Error("ambiguous Action was not retained");
      harness.actions.set(request.actionId, { ...retained, _tag: "Pending" });
      yield* TestClock.setTime(120_002);

      expect(yield* integrations.inspectAction(request)).toEqual({
        _tag: "Ambiguous",
        retryAfterMilliseconds: 179_999,
      });
      expect(harness.actions.get(request.actionId)).toMatchObject({ _tag: "Ambiguous" });
      expect(harness.executed).toHaveLength(1);
    }),
  );

  it.effect("preserves exact provider log evidence for proven NotApplied repair", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const actionId = ActionId.make("action-not-applied-evidence");
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeFailure = new IntegrationProviderUnavailable({
        cause: "execute",
        message: "The provider response was lost",
        operation: "execute",
        reason: "unavailable",
      });
      const integrations = make(harness);
      const input = {
        body: "Hello",
        gmailResource: "primary",
        recipients: ["person@example.test"],
        subject: "Subject",
      };
      const identity = {
        manifestVersion: ManifestVersion.make("gmail-v1"),
        operation: "GMAIL_SEND_EMAIL",
        toolkit: "gmail",
      } as const;
      yield* integrations
        .execute({ actionId, authorize: Effect.void, identity, input, userId })
        .pipe(Effect.result);
      harness.inspectionEvidence = {
        _tag: "NotApplied",
        providerLogId: "provider-log-not-applied",
      };

      expect(yield* integrations.inspectAction({ actionId, identity, input, userId })).toEqual({
        _tag: "NotApplied",
        providerLogId: "provider-log-not-applied",
      });
      expect(harness.actions.get(actionId)).toMatchObject({
        _tag: "NotApplied",
        providerLogId: "provider-log-not-applied",
      });
    }),
  );

  it.effect("classifies explicit rejection as final and requires a new Action for retry", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits = [
        {
          connectedAccount: { id: "account-1", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ];
      harness.executeResult = {
        data: {},
        error: "provider rejected secret-token-value",
        logId: "composio-log-rejected",
      };
      const integrations = make(harness);
      const request = {
        actionId: ActionId.make("action-retry"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          gmailResource: "primary",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;

      const rejected = yield* Effect.flip(integrations.execute(request));
      expect(rejected).toMatchObject({
        _tag: "IntegrationExecutionRejected",
        message: "The integration provider rejected the operation",
        providerLogId: "composio-log-rejected",
      });
      expect(rejected).not.toHaveProperty("providerError");
      harness.executeResult = {
        data: { id: "message-1" },
        error: null,
        logId: "composio-log-applied",
      };
      expect(yield* integrations.execute(request).pipe(Effect.result)).toMatchObject({
        failure: {
          _tag: "IntegrationActionNotApplied",
          providerLogId: "composio-log-rejected",
        },
      });
      expect(
        yield* integrations.execute({ ...request, actionId: ActionId.make("action-retry-2") }),
      ).toMatchObject({
        _tag: "IntegrationEffectCompleted",
        evidence: {
          providerLogId: "composio-log-applied",
          providerResourceId: "message-1",
        },
      });
      expect(harness.executed).toHaveLength(2);
    }),
  );

  it.effect("maps a Calendar provider conflict safely and requires a new Action for retry", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      harness.toolkits.push({
        connectedAccount: { id: "calendar-account", status: "ACTIVE" },
        isActive: true,
        slug: "googlecalendar",
      });
      harness.executeResult = {
        data: {},
        error: "409 conflict: provider-private-details",
        logId: "calendar-conflict-log",
      };
      const integrations = make(harness);
      const request = {
        actionId: ActionId.make("calendar-conflict"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("calendar-v1"),
          operation: "CALENDAR_UPDATE_EVENT",
          toolkit: "googlecalendar",
        },
        input: {
          calendarId: "primary",
          changes: { title: "Current intent" },
          eventId: "event-1",
          sendNotifications: false,
        },
        userId,
      } as const;

      const conflict = yield* Effect.flip(integrations.execute(request));
      expect(conflict).toMatchObject({
        _tag: "IntegrationExecutionRejected",
        code: "conflict",
        message: "The Calendar operation conflicts with current provider state",
        providerLogId: "calendar-conflict-log",
      });
      expect(conflict).not.toHaveProperty("providerError");
      harness.executeResult = {
        data: { id: "event-1" },
        error: null,
        logId: "calendar-retry-log",
      };
      expect(yield* integrations.execute(request).pipe(Effect.result)).toMatchObject({
        failure: {
          _tag: "IntegrationActionNotApplied",
          providerLogId: "calendar-conflict-log",
        },
      });
      expect(
        yield* integrations.execute({
          ...request,
          actionId: ActionId.make("calendar-conflict-retry"),
        }),
      ).toMatchObject({
        _tag: "IntegrationEffectCompleted",
        evidence: {
          providerLogId: "calendar-retry-log",
          providerResourceId: "event-1",
        },
      });
      expect(harness.executed).toHaveLength(2);
    }),
  );
});

class TestAuthorityLost extends Schema.TaggedError<TestAuthorityLost>()("TestAuthorityLost", {
  message: Schema.String,
}) {}

const gmailEffectRequest = (
  actionId: ActionId,
  finalizeEffect: (
    outcome: IntegrationEffectFinalOutcome,
  ) => Effect.Effect<void, IntegrationEffectFinalizationUnavailable>,
) =>
  ({
    actionId,
    authorize: Effect.void,
    finalizeEffect,
    identity: {
      manifestVersion: ManifestVersion.make("gmail-v1"),
      operation: "GMAIL_SEND_EMAIL",
      toolkit: "gmail",
    },
    input: {
      body: "Hello",
      gmailResource: "primary",
      recipients: ["person@example.test"],
      subject: "Subject",
    },
    userId,
  }) as const;

const makeAmbiguousGmailHarness = () => {
  const harness = makeHarness();
  harness.toolkits = [
    {
      connectedAccount: { id: "account-1", status: "ACTIVE" },
      isActive: true,
      slug: "gmail",
    },
  ];
  harness.executeFailure = new IntegrationProviderUnavailable({
    cause: "execute",
    message: "The provider response was lost",
    operation: "execute",
    reason: "unavailable",
  });
  return harness;
};

const makeActionAccounting = () => {
  const periodId = AllowancePeriodId.make("gmail-send-period");
  const retained: Array<{
    readonly items: ReadonlyArray<AllowanceItem>;
    readonly source: AllowanceSource;
  }> = [];
  const recordUsage: Allowances.Persistence["recordUsage"] = (_periodId, source, items) =>
    Effect.gen(function* () {
      const existing = retained.find(
        (candidate) =>
          candidate.source.sourceId === source.sourceId &&
          candidate.source.sourceType === source.sourceType,
      );
      if (existing !== undefined) {
        const retainedItem = existing.items[0];
        const replayItem = items[0];
        if (
          retainedItem === undefined ||
          replayItem === undefined ||
          retainedItem.allowanceKind !== replayItem.allowanceKind ||
          retainedItem.basis !== replayItem.basis ||
          retainedItem.quantity !== replayItem.quantity
        ) {
          return yield* new UsageConflict({
            allowanceKind: replayItem?.allowanceKind ?? "gmailSends",
            allowancePeriodId: periodId,
            message: "The retained Usage Event has different facts",
            sourceId: source.sourceId,
            sourceType: source.sourceType,
          });
        }
        return { outcome: ExistingUsage.make({}), period: null, usage: [] };
      }
      retained.push({ items, source });
      return { outcome: Recorded.make({}), period: null, usage: [] };
    });
  const allowances = Allowances.make({
    billing: {
      inspect: () => Effect.die(new Error("not used by this accounting fixture")),
      recordUsage,
      recordUsageForUser: (_userId, allowancePeriodId, source, items) =>
        recordUsage(allowancePeriodId, source, items),
    },
    catalog: retainedCatalog,
    now: Effect.sync(() => new Date(0)),
  });
  return {
    finalize: (actionId: ActionId) => (outcome: IntegrationEffectFinalOutcome) => {
      if (outcome._tag === "NotApplied") return Effect.void;
      const basis = outcome._tag === "Applied" ? "observed" : "conservative";
      return allowances
        .record(periodId, { sourceId: actionId, sourceType: "integrationAction" }, [
          { allowanceKind: "gmailSends", basis, quantity: 1n },
        ])
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new IntegrationEffectFinalizationUnavailable({
                cause,
                message: "Gmail-send accounting is unavailable",
                operation: "accounting.gmailSend",
              }),
          ),
        );
    },
    retained,
  };
};

const makeHarness = (): IntegrationProvider &
  IntegrationPersistence & {
    actions: Map<ActionId, PersistedIntegrationAction>;
    authorized: Array<{ callbackUrl: string; toolkit: string }>;
    created: Array<{ config: typeof directIntegrationProviderConfig; userId: UserId }>;
    executeResult: ProviderExecutionResult;
    executeFailure: IntegrationProviderUnavailable | null;
    executed: Array<{
      connectedAccountId: string;
      constraints?: { readonly maximumDownloadBytes?: number };
      input: ProviderInput;
      providerTool: string;
    }>;
    disconnected: Array<string>;
    missingSessions: Set<string>;
    inspectionEvidence: ProviderExecutionEvidence;
    sessions: Map<UserId, string>;
    stageFailure: IntegrationProviderUnavailable | null;
    staged: Array<{ bytes: Uint8Array; fileName: string; mediaType: string }>;
    toolkits: Array<{
      connectedAccount: { id: string; status: string } | null;
      isActive: boolean;
      slug: string;
    }>;
    toolkitsInspected: number;
    used: Array<string>;
  } => {
  const sessions = new Map<UserId, string>();
  const actions = new Map<ActionId, PersistedIntegrationAction>();
  const authorized: Array<{ callbackUrl: string; toolkit: string }> = [];
  const created: Array<{ config: typeof directIntegrationProviderConfig; userId: UserId }> = [];
  const executed: Array<{
    connectedAccountId: string;
    constraints?: { readonly maximumDownloadBytes?: number };
    input: ProviderInput;
    providerTool: string;
  }> = [];
  const disconnected: Array<string> = [];
  const toolkits: Array<{
    connectedAccount: { id: string; status: string } | null;
    isActive: boolean;
    slug: string;
  }> = [];
  const used: Array<string> = [];
  const staged: Array<{ bytes: Uint8Array; fileName: string; mediaType: string }> = [];
  const harness = {
    actions,
    authorized,
    created,
    disconnected,
    executeResult: { data: {}, error: null, logId: "composio-log" },
    executeFailure: null,
    executed,
    missingSessions: new Set<string>(),
    inspectionEvidence: { _tag: "Unknown" as const },
    sessions,
    stageFailure: null,
    staged,
    toolkits,
    toolkitsInspected: 0,
    used,
  };
  const session = (): ProviderSession => ({
    authorize: (toolkit, callbackUrl) => {
      harness.authorized.push({ callbackUrl: callbackUrl.toString(), toolkit });
      return Effect.succeed(new URL("https://connect.composio.dev/link"));
    },
    disconnect: (connectedAccountId) =>
      Effect.sync(() => {
        harness.disconnected.push(connectedAccountId);
      }),
    execute: (providerTool, input, connectedAccountId, constraints, _correlation) => {
      if (constraints === undefined) {
        harness.executed.push({ connectedAccountId, input, providerTool });
      } else {
        harness.executed.push({ connectedAccountId, constraints, input, providerTool });
      }
      return harness.executeFailure === null
        ? Effect.succeed(harness.executeResult)
        : Effect.fail(harness.executeFailure);
    },
    inspectToolkits: () => {
      harness.toolkitsInspected += 1;
      return Effect.succeed(harness.toolkits);
    },
    inspectExecution: () => Effect.succeed(harness.inspectionEvidence),
    stageFile: (artifact) => {
      harness.staged.push(artifact);
      return harness.stageFailure === null
        ? Effect.succeed({
            mimetype: artifact.mediaType,
            name: artifact.fileName,
            s3key: "staged-file-key",
          })
        : Effect.fail(harness.stageFailure);
    },
  });
  return Object.assign(harness, {
    createSession: (createdUserId: UserId, config: typeof directIntegrationProviderConfig) => {
      harness.created.push({ config, userId: createdUserId });
      return Effect.succeed({
        providerSessionId: `provider-session-${harness.created.length}`,
        session: session(),
      });
    },
    readAction: (actionId: ActionId) => Effect.succeed(actions.get(actionId) ?? null),
    readSession: (mappedUserId: UserId) => Effect.succeed(sessions.get(mappedUserId) ?? null),
    retainAction: (actionId: ActionId, value: PersistedIntegrationAction) =>
      Effect.sync(() => {
        actions.set(actionId, value);
      }),
    settleAction: (
      actionId: ActionId,
      _providerRequestId: string,
      value: PersistedIntegrationAction,
    ) =>
      Effect.sync(() => {
        actions.set(actionId, value);
        return value;
      }),
    retainSession: (mappedUserId: UserId, providerSessionId: string) =>
      Effect.sync(() => {
        const retained = sessions.get(mappedUserId) ?? providerSessionId;
        sessions.set(mappedUserId, retained);
        return retained;
      }),
    replaceSession: (
      mappedUserId: UserId,
      expectedProviderSessionId: string,
      replacementProviderSessionId: string,
    ) =>
      Effect.sync(() => {
        const retained = sessions.get(mappedUserId);
        if (retained === expectedProviderSessionId) {
          sessions.set(mappedUserId, replacementProviderSessionId);
          return replacementProviderSessionId;
        }
        return retained ?? replacementProviderSessionId;
      }),
    useSession: (_userId: UserId, providerSessionId: string) => {
      harness.used.push(providerSessionId);
      return harness.missingSessions.has(providerSessionId)
        ? Effect.fail(
            new IntegrationProviderUnavailable({
              cause: providerSessionId,
              message: "Provider session is missing",
              operation: "useSession",
              reason: "missing",
            }),
          )
        : Effect.succeed(session());
    },
  });
};
