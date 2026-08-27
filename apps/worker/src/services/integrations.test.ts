/* oxlint-disable eslint/no-underscore-dangle, vitest/no-standalone-expect -- Assertions execute inside Effect Vitest generators and inspect tagged outcomes. */
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { ActionId } from "../domain/action-execution";
import { ManifestVersion, UserId } from "../domain";
import {
  directIntegrationProviderConfig,
  IntegrationProviderUnavailable,
  make,
  type IntegrationPersistence,
  type IntegrationProvider,
  type PersistedIntegrationAction,
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
      const request = {
        actionId: ActionId.make("action-1"),
        authorize: Effect.void,
        identity: {
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        },
        input: {
          body: "Hello",
          recipients: ["person@example.test"],
          subject: "Subject",
        },
        userId,
      } as const;

      const first = yield* integrations.execute(request);
      const replay = yield* integrations.execute(request);

      expect(first).toEqual(replay);
      expect(first).toMatchObject({
        _tag: "IntegrationEffectCompleted",
        evidence: { providerLogId: "composio-log-1" },
        operation: "GMAIL_SEND_EMAIL",
      });
      expect(harness.executed).toEqual([
        {
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
          evidence: { providerLogId: "composio-log-large" },
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

  it.effect("classifies explicit rejection as not applied and permits one safe Action retry", () =>
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
      expect(yield* integrations.execute(request)).toMatchObject({
        _tag: "IntegrationEffectCompleted",
        evidence: { providerLogId: "composio-log-applied" },
      });
      expect(harness.executed).toHaveLength(2);
    }),
  );
});

class TestAuthorityLost extends Schema.TaggedError<TestAuthorityLost>()("TestAuthorityLost", {
  message: Schema.String,
}) {}

const makeHarness = (): IntegrationProvider &
  IntegrationPersistence & {
    actions: Map<ActionId, PersistedIntegrationAction>;
    authorized: Array<{ callbackUrl: string; toolkit: string }>;
    created: Array<{ config: typeof directIntegrationProviderConfig; userId: UserId }>;
    executeResult: { data: Schema.JsonObject; error: string | null; logId: string };
    executeFailure: IntegrationProviderUnavailable | null;
    executed: Array<{ input: ProviderInput; providerTool: string }>;
    missingSessions: Set<string>;
    sessions: Map<UserId, string>;
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
  const executed: Array<{ input: ProviderInput; providerTool: string }> = [];
  const toolkits: Array<{
    connectedAccount: { id: string; status: string } | null;
    isActive: boolean;
    slug: string;
  }> = [];
  const used: Array<string> = [];
  const harness = {
    actions,
    authorized,
    created,
    executeResult: { data: {}, error: null, logId: "composio-log" },
    executeFailure: null,
    executed,
    missingSessions: new Set<string>(),
    sessions,
    toolkits,
    toolkitsInspected: 0,
    used,
  };
  const session = (): ProviderSession => ({
    authorize: (toolkit, callbackUrl) => {
      harness.authorized.push({ callbackUrl: callbackUrl.toString(), toolkit });
      return Effect.succeed(new URL("https://connect.composio.dev/link"));
    },
    execute: (providerTool, input) => {
      harness.executed.push({ input, providerTool });
      return harness.executeFailure === null
        ? Effect.succeed(harness.executeResult)
        : Effect.fail(harness.executeFailure);
    },
    inspectToolkits: () => {
      harness.toolkitsInspected += 1;
      return Effect.succeed(harness.toolkits);
    },
  });
  return Object.assign(harness, {
    createSession: (createdUserId: UserId, config: typeof directIntegrationProviderConfig) => {
      harness.created.push({ config, userId: createdUserId });
      return Effect.succeed({ providerSessionId: "provider-session-1", session: session() });
    },
    readAction: (actionId: ActionId) => Effect.succeed(actions.get(actionId) ?? null),
    readSession: (mappedUserId: UserId) => Effect.succeed(sessions.get(mappedUserId) ?? null),
    retainAction: (actionId: ActionId, value: PersistedIntegrationAction) =>
      Effect.sync(() => {
        actions.set(actionId, value);
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
    useSession: (providerSessionId: string) => {
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
