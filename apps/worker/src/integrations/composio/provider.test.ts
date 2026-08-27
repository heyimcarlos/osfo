/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Promise fakes model the Composio SDK boundary; assertions execute inside Effect Vitest generators. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { UserId } from "../../domain";
import { directIntegrationProviderConfig, type ProviderInput } from "../../services/integrations";
import { composioSessionConfig, decodeExecutionResponse, makeFromClient } from "./provider";

describe("Composio Provider", () => {
  it("translates direct manifests into a fully confined current session config", () => {
    expect(composioSessionConfig(directIntegrationProviderConfig)).toEqual({
      manageConnections: false,
      multiAccount: { enable: false },
      preload: { tools: directIntegrationProviderConfig.tools },
      sandbox: { enable: false },
      sessionPreset: "direct_tools",
      toolkits: ["gmail", "googlecalendar", "googledrive"],
      tools: {
        gmail: ["GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_CREATE_EMAIL_DRAFT", "GMAIL_SEND_EMAIL"],
        googlecalendar: [
          "GOOGLECALENDAR_EVENTS_LIST",
          "GOOGLECALENDAR_CREATE_EVENT",
          "GOOGLECALENDAR_PATCH_EVENT",
        ],
        googledrive: ["GOOGLEDRIVE_GET_FILE_METADATA"],
      },
    });
  });

  it.effect("uses only the narrow session methods and removes private account identity", () =>
    Effect.gen(function* () {
      const executed: Array<{
        input: ProviderInput;
        providerSessionId: string;
        providerTool: string;
      }> = [];
      const session = {
        authorize: async () => ({ redirectUrl: "https://connect.composio.dev/link" }),
        sessionId: "provider-session-1",
        toolkits: async () => ({
          items: [
            {
              connection: {
                connectedAccount: { id: "private-account", status: "ACTIVE" },
                isActive: true,
              },
              slug: "gmail",
            },
          ],
        }),
      };
      const provider = makeFromClient({
        createSession: async () => session,
        executeOnce: async (providerSessionId, providerTool, input) => {
          executed.push({ input, providerSessionId, providerTool });
          return { data: {}, error: null, logId: "composio-log-1" };
        },
        useSession: async () => session,
      });
      const created = yield* provider.createSession(
        UserId.make("user-1"),
        directIntegrationProviderConfig,
      );

      expect(yield* created.session.inspectToolkits(["gmail"])).toEqual([
        {
          connectedAccount: { id: "private-account", status: "ACTIVE" },
          isActive: true,
          slug: "gmail",
        },
      ]);
      const providerInput = {
        body: "bounded",
        is_html: false,
        recipient_email: "person@example.test",
        subject: "Subject",
        user_id: "me",
      } as const;
      expect(yield* created.session.execute("GMAIL_SEND_EMAIL", providerInput)).toEqual({
        data: {},
        error: null,
        logId: "composio-log-1",
      });
      expect(executed).toEqual([
        {
          input: providerInput,
          providerSessionId: "provider-session-1",
          providerTool: "GMAIL_SEND_EMAIL",
        },
      ]);
    }),
  );

  it("unwraps the documented per-tool result without losing Tool Router evidence", () => {
    expect(
      decodeExecutionResponse({
        data: {
          data: { messages: [{ id: "message-1" }] },
          error: null,
          successful: true,
        },
        error: null,
        log_id: "composio-log-1",
      }),
    ).toEqual({
      data: { messages: [{ id: "message-1" }] },
      error: null,
      logId: "composio-log-1",
    });
  });
});
