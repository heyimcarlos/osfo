/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Promise fakes model the Composio SDK boundary; assertions execute inside Effect Vitest generators. */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { UserId } from "../../domain";
import { directIntegrationProviderConfig, type ProviderInput } from "../../services/integrations";
import {
  composioSessionConfig,
  decodeExecutionResponse,
  makeFromClient,
  silenceComposioLogs,
} from "./provider";

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
        gmail: ["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_SEND_EMAIL"],
        googlecalendar: [
          "GOOGLECALENDAR_EVENTS_LIST",
          "GOOGLECALENDAR_FIND_FREE_SLOTS",
          "GOOGLECALENDAR_CREATE_EVENT",
          "GOOGLECALENDAR_PATCH_EVENT",
          "GOOGLECALENDAR_DELETE_EVENT",
        ],
        googledrive: [
          "GOOGLEDRIVE_FIND_FILE",
          "GOOGLEDRIVE_GET_FILE_METADATA",
          "GOOGLEDRIVE_DOWNLOAD_FILE",
          "GOOGLEDRIVE_UPLOAD_FILE",
        ],
      },
    });
  });

  it.effect("uses only the narrow session methods and removes private account identity", () =>
    Effect.gen(function* () {
      const executed: Array<{
        connectedAccountId: string;
        input: ProviderInput;
        providerSessionId: string;
        providerTool: string;
      }> = [];
      const session = {
        authorize: async () => ({ redirectUrl: "https://connect.composio.dev/link" }),
        sessionId: "provider-session-1",
      };
      const provider = makeFromClient({
        createSession: async () => session,
        disconnect: async () => undefined,
        executeOnce: async (providerSessionId, providerTool, input, connectedAccountId) => {
          executed.push({ connectedAccountId, input, providerSessionId, providerTool });
          return { data: {}, error: null, logId: "composio-log-1" };
        },
        listConnectedAccounts: async () => ({
          items: [
            {
              id: "private-account",
              status: "ACTIVE",
              toolkit: { slug: "gmail" },
            },
          ],
        }),
        uploadFile: async ({ fileName, mediaType }) => ({
          mimetype: mediaType,
          name: fileName,
          s3key: "staged-file-key",
        }),
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
      expect(
        yield* created.session.execute("GMAIL_SEND_EMAIL", providerInput, "private-account"),
      ).toEqual({
        data: {},
        error: null,
        logId: "composio-log-1",
      });
      expect(executed).toEqual([
        {
          connectedAccountId: "private-account",
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

  it("forces every SDK log level silent before a secret enters the SDK", () => {
    const calls: Array<string> = [];
    const logger = {
      debug: (..._args: ReadonlyArray<unknown>) => calls.push("debug"),
      error: (..._args: ReadonlyArray<unknown>) => calls.push("error"),
      info: (..._args: ReadonlyArray<unknown>) => calls.push("info"),
      warn: (..._args: ReadonlyArray<unknown>) => calls.push("warn"),
    };

    silenceComposioLogs(logger);
    logger.debug("secret");
    logger.error("secret");
    logger.info("secret");
    logger.warn("secret");

    expect(calls).toEqual([]);
  });

  it.effect("downloads one bounded text Drive result and removes its signed URL", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("x".repeat(65_540), { status: 206 }));
      const session = {
        authorize: async () => ({ redirectUrl: "https://connect.composio.dev/link" }),
        sessionId: "provider-session-1",
      };
      const provider = makeFromClient({
        createSession: async () => session,
        disconnect: async () => undefined,
        executeOnce: async () => ({
          data: {
            downloaded_file_content: {
              mimetype: "text/plain",
              name: "notes.txt",
              s3url: "https://files.composio.dev/signed-download",
            },
          },
          error: null,
          logId: "download-log",
        }),
        listConnectedAccounts: async () => ({ items: [] }),
        uploadFile: async () => ({ mimetype: "text/plain", name: "notes.txt", s3key: "key" }),
        useSession: async () => session,
      });
      const created = yield* provider.createSession(
        UserId.make("user-1"),
        directIntegrationProviderConfig,
      );
      const result = yield* created.session.execute(
        "GOOGLEDRIVE_DOWNLOAD_FILE",
        { file_id: "file-1", mime_type: "text/plain" },
        "private-account",
      );

      expect(fetchMock).toHaveBeenCalledWith(
        "https://files.composio.dev/signed-download",
        expect.objectContaining({ headers: { range: "bytes=0-65536" } }),
      );
      expect(result).toEqual({
        data: {
          content: "x".repeat(65_536),
          mimeType: "text/plain",
          name: "notes.txt",
          size: 65_536,
          truncated: true,
        },
        error: null,
        logId: "download-log",
      });
      expect(result.data).not.toHaveProperty("s3url");
      fetchMock.mockRestore();
    }),
  );

  it.effect("rejects an unsafe or media-mismatched Drive download before fetching it", () =>
    Effect.gen(function* () {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      const session = {
        authorize: async () => ({ redirectUrl: "https://connect.composio.dev/link" }),
        sessionId: "provider-session-1",
      };
      const provider = makeFromClient({
        createSession: async () => session,
        disconnect: async () => undefined,
        executeOnce: async () => ({
          data: {
            downloaded_file_content: {
              mimetype: "text/html",
              name: "private.txt",
              s3url: "https://127.0.0.1/private",
            },
          },
          error: null,
          logId: "download-log",
        }),
        listConnectedAccounts: async () => ({ items: [] }),
        uploadFile: async () => ({ mimetype: "text/plain", name: "notes.txt", s3key: "key" }),
        useSession: async () => session,
      });
      const created = yield* provider.createSession(
        UserId.make("user-1"),
        directIntegrationProviderConfig,
      );
      const failure = yield* Effect.flip(
        created.session.execute(
          "GOOGLEDRIVE_DOWNLOAD_FILE",
          { file_id: "file-1", mime_type: "text/plain" },
          "private-account",
        ),
      );

      expect(failure).toMatchObject({
        _tag: "IntegrationProviderUnavailable",
        operation: "downloadFile",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockRestore();
    }),
  );
});
