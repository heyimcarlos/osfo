import { Composio, logger, SessionPreset } from "@composio/core";
import { Effect, Option, Redacted, Schema } from "effect";

import type { UserId } from "../../domain";
import {
  IntegrationProviderUnavailable,
  type IntegrationProvider,
  type ProviderExecutionResult,
  type ProviderInput,
  type ProviderSession,
  type ProviderToolkitEvidence,
  type directIntegrationProviderConfig,
} from "../../services/integrations";

const requestTimeoutMillis = 30_000;
const maximumDriveReadBytes = 65_536;
const composioApiBaseUrl = "https://backend.composio.dev";
const toolkitVersions = {
  gmail: "20260817_00",
  googlecalendar: "20260812_00",
  googledrive: "20260815_00",
} as const;
const silent = () => undefined;

const SessionExecutionResponse = Schema.Struct({
  data: Schema.JsonObject,
  error: Schema.NullOr(Schema.String),
  log_id: Schema.String,
});

const ToolExecutionEnvelope = Schema.Struct({
  data: Schema.JsonObject,
  error: Schema.NullOr(Schema.String),
  successful: Schema.Boolean,
});

const DownloadedFile = Schema.Struct({
  mimetype: Schema.String,
  name: Schema.String,
  s3url: Schema.String,
});

interface ComposioSessionPort {
  readonly authorize: (
    toolkit: string,
    options: { readonly callbackUrl: string },
  ) => Promise<{ readonly redirectUrl?: string | null }>;
  readonly sessionId: string;
}

interface ComposioConnectedAccountList {
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly toolkit: { readonly slug: string };
  }>;
}

interface ComposioLoggerPort {
  debug: (...args: ReadonlyArray<unknown>) => void;
  error: (...args: ReadonlyArray<unknown>) => void;
  info: (...args: ReadonlyArray<unknown>) => void;
  warn: (...args: ReadonlyArray<unknown>) => void;
}

interface ComposioClientPort {
  readonly createSession: (
    userId: string,
    config: ComposioSessionConfig,
  ) => Promise<ComposioSessionPort>;
  readonly executeOnce: (
    sessionId: string,
    providerTool: string,
    input: ProviderInput,
    connectedAccountId: string,
  ) => Promise<ProviderExecutionResult>;
  readonly disconnect: (connectedAccountId: string) => Promise<void>;
  readonly listConnectedAccounts: (
    userId: string,
    toolkit: string,
  ) => Promise<ComposioConnectedAccountList>;
  readonly uploadFile: (input: {
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly mediaType: string;
  }) => Promise<{ readonly mimetype: string; readonly name: string; readonly s3key: string }>;
  readonly useSession: (providerSessionId: string) => Promise<ComposioSessionPort>;
}

export interface ComposioSessionConfig {
  readonly manageConnections: false;
  readonly multiAccount: { readonly enable: false };
  readonly preload: { readonly tools: Array<string> };
  readonly sandbox: { readonly enable: false };
  readonly sessionPreset: typeof SessionPreset.DIRECT_TOOLS;
  readonly toolkits: Array<string>;
  readonly tools: Record<string, Array<string>>;
}

interface ComposioConnectedAccountsPort {
  readonly list: (options: {
    readonly limit: number;
    readonly toolkitSlugs: Array<string>;
    readonly userIds: Array<string>;
  }) => Promise<{
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly isDisabled: boolean;
      readonly status: string;
      readonly toolkit: { readonly slug: string };
    }>;
  }>;
}

/** Translate Osfo's provider-independent confinement into Composio's current SDK config. */
export const composioSessionConfig = (
  config: typeof directIntegrationProviderConfig,
): ComposioSessionConfig => ({
  manageConnections: false,
  multiAccount: { enable: false },
  preload: { tools: [...config.tools] },
  sandbox: { enable: false },
  sessionPreset: SessionPreset.DIRECT_TOOLS,
  toolkits: [...config.toolkits],
  tools: {
    gmail: config.tools.filter((tool) => tool.startsWith("GMAIL_")),
    googlecalendar: config.tools.filter((tool) => tool.startsWith("GOOGLECALENDAR_")),
    googledrive: config.tools.filter((tool) => tool.startsWith("GOOGLEDRIVE_")),
  },
});

/** Build the production Composio Platform adapter without exposing provider discovery APIs. */
export const make = (apiKey: Redacted.Redacted): IntegrationProvider => {
  const value = Redacted.value(apiKey);
  silenceComposioLogs(logger);
  const composio = new Composio({
    allowTracking: false,
    apiKey: value,
    dangerouslyAllowAutoUploadDownloadFiles: false,
    fileUploadDirs: false,
    toolkitVersions,
  });
  return makeFromClient({
    createSession: (userId, config) => composio.sessions.create(userId, config),
    executeOnce: (sessionId, providerTool, input, connectedAccountId) =>
      executeOnce(value, sessionId, providerTool, input, connectedAccountId),
    disconnect: (connectedAccountId) =>
      composio.connectedAccounts.delete(connectedAccountId).then(() => undefined),
    listConnectedAccounts: (userId, toolkit) =>
      listConnectedAccounts(composio.connectedAccounts, userId, toolkit),
    uploadFile: ({ bytes, fileName, mediaType }) =>
      composio.files.upload({
        file: new File([Uint8Array.from(bytes).buffer], fileName, { type: mediaType }),
        toolkitSlug: "googledrive",
        toolSlug: "GOOGLEDRIVE_UPLOAD_FILE",
      }),
    useSession: (providerSessionId) => composio.sessions.use(providerSessionId),
  });
};

/** Disable SDK logging before the secret-bearing SDK constructor reads its environment. */
export const silenceComposioLogs = (target: ComposioLoggerPort): void => {
  target.debug = silent;
  target.error = silent;
  target.info = silent;
  target.warn = silent;
};

/** Adapt the current SDK surface behind the provider-independent Integrations port. */
export const makeFromClient = (client: ComposioClientPort): IntegrationProvider => ({
  createSession: (userId: UserId, config) =>
    providerCall("createSession", () =>
      client.createSession(userId, composioSessionConfig(config)),
    ).pipe(
      Effect.map((session) => ({
        providerSessionId: session.sessionId,
        session: adaptSession(client, userId, session),
      })),
    ),
  useSession: (userId, providerSessionId) =>
    providerCall("useSession", () => client.useSession(providerSessionId)).pipe(
      Effect.map((session) => adaptSession(client, userId, session)),
    ),
});

const adaptSession = (
  client: ComposioClientPort,
  userId: UserId,
  session: ComposioSessionPort,
): ProviderSession => ({
  authorize: (toolkit, callbackUrl) =>
    providerCall("authorize", () =>
      session.authorize(toolkit, { callbackUrl: callbackUrl.href }),
    ).pipe(
      Effect.flatMap(({ redirectUrl }) => {
        if (redirectUrl === undefined || redirectUrl === null || !URL.canParse(redirectUrl)) {
          return Effect.fail(providerFailure("authorize"));
        }
        const parsed = new URL(redirectUrl);
        return parsed.protocol === "https:"
          ? Effect.succeed(parsed)
          : Effect.fail(providerFailure("authorize"));
      }),
    ),
  execute: (providerTool, input, connectedAccountId) =>
    providerCall("execute", () =>
      client.executeOnce(session.sessionId, providerTool, input, connectedAccountId),
    ).pipe(
      Effect.flatMap((execution) =>
        providerTool === "GOOGLEDRIVE_DOWNLOAD_FILE" &&
        execution.error === null &&
        "file_id" in input &&
        "mime_type" in input
          ? normalizeDriveDownload(execution, input.mime_type)
          : Effect.succeed(execution),
      ),
    ),
  disconnect: (connectedAccountId) =>
    providerCall("disconnect", () => client.disconnect(connectedAccountId)),
  inspectToolkits: (toolkits) =>
    Effect.forEach(
      toolkits,
      (toolkit) =>
        providerCall("inspectToolkits", () => client.listConnectedAccounts(userId, toolkit)).pipe(
          Effect.map(({ items }) =>
            items.map(({ id, status, toolkit: accountToolkit }): ProviderToolkitEvidence => ({
              connectedAccount: { id, status },
              isActive: status === "ACTIVE",
              slug: accountToolkit.slug,
            })),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.map((groups) => groups.flat())),
  stageFile: (artifact) => providerCall("stageFile", () => client.uploadFile(artifact)),
});

const normalizeDriveDownload = (execution: ProviderExecutionResult, expectedMediaType: string) =>
  Effect.gen(function* () {
    const downloaded = yield* Schema.decodeUnknownEffect(DownloadedFile)(
      execution.data.downloaded_file_content,
    ).pipe(Effect.mapError(() => providerFailure("downloadFile")));
    if (downloaded.mimetype !== expectedMediaType) return yield* providerFailure("downloadFile");
    if (!isSafeDownloadUrl(downloaded.s3url)) return yield* providerFailure("downloadFile");
    const response = yield* providerCall("downloadFile", () =>
      // oxlint-disable-next-line osfo/no-raw-fetch, effecttsgo/global-fetch -- The provider adapter consumes one decoded, public HTTPS download reference.
      fetch(downloaded.s3url, {
        headers: { range: `bytes=0-${maximumDriveReadBytes}` },
        signal: AbortSignal.timeout(requestTimeoutMillis),
      }),
    );
    if (!response.ok && response.status !== 206) return yield* providerFailure("downloadFile");
    const read = yield* readBoundedBody(response, maximumDriveReadBytes);
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(read.bytes),
      catch: () => providerFailure("downloadFile"),
    });
    return {
      ...execution,
      data: {
        content,
        mimeType: downloaded.mimetype,
        name: downloaded.name,
        size: read.bytes.byteLength,
        truncated: read.truncated,
      },
    };
  });

const readBoundedBody = (response: Response, maximumBytes: number) =>
  Effect.tryPromise({
    // oxlint-disable-next-line effecttsgo/async-function -- A response body reader is an ordered Promise-based resource boundary.
    try: async () => {
      if (response.body === null) throw new Error("Missing download body");
      const reader = response.body.getReader();
      const chunks: Array<Uint8Array> = [];
      let length = 0;
      let truncated = false;
      while (length <= maximumBytes) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Stream chunks must be read and bounded in order.
        const next = await reader.read();
        if (next.done) break;
        const remaining = maximumBytes - length;
        if (next.value.byteLength > remaining) {
          if (remaining > 0) chunks.push(next.value.slice(0, remaining));
          length = maximumBytes;
          truncated = true;
          // oxlint-disable-next-line eslint/no-await-in-loop -- Cancel the current sequential stream before leaving its loop.
          await reader.cancel();
          break;
        }
        chunks.push(next.value);
        length += next.value.byteLength;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, truncated };
    },
    catch: () => providerFailure("downloadFile"),
  });

const isSafeDownloadUrl = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase();
  return (
    host !== "localhost" &&
    !host.endsWith(".local") &&
    !host.startsWith("127.") &&
    !host.startsWith("10.") &&
    !host.startsWith("192.168.") &&
    !/^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) &&
    !host.includes(":")
  );
};

// oxlint-disable-next-line effecttsgo/async-function -- The SDK list operation is this Promise-based provider boundary's resource lifetime.
const listConnectedAccounts = async (
  connectedAccounts: ComposioConnectedAccountsPort,
  userId: string,
  toolkit: string,
): Promise<ComposioConnectedAccountList> => {
  const listed = await connectedAccounts.list({
    limit: 2,
    toolkitSlugs: [toolkit],
    userIds: [userId],
  });
  return {
    items: listed.items.map(({ id, isDisabled, status, toolkit: accountToolkit }) => ({
      id,
      status: isDisabled && status === "ACTIVE" ? "INACTIVE" : status,
      toolkit: accountToolkit,
    })),
  };
};

/** One exact HTTP dispatch avoids hidden SDK retries for an Osfo Action attempt. */
// oxlint-disable-next-line effecttsgo/async-function -- Fetch response decoding is this Promise-based provider boundary's resource lifetime.
const executeOnce = async (
  apiKey: string,
  sessionId: string,
  providerTool: string,
  input: ProviderInput,
  connectedAccountId: string,
): Promise<ProviderExecutionResult> => {
  // Osfo owns Action retry policy; this host adapter performs one request because the current session SDK may retry writes.
  // oxlint-disable-next-line osfo/no-raw-fetch, effecttsgo/global-fetch -- This is the Composio host adapter and must preserve one execution attempt.
  const response = await fetch(
    `${composioApiBaseUrl}/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
    {
      body: JSON.stringify({
        account: connectedAccountId,
        arguments: input,
        tool_slug: providerTool,
      }),
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMillis),
    },
  );
  if (!response.ok) {
    throw new ComposioHttpFailure({
      message: `Composio execute failed with HTTP ${response.status}`,
      status: response.status,
    });
  }
  return decodeExecutionResponse(await response.json());
};

/** Decode both Tool Router evidence and the documented per-tool result envelope. */
// oxlint-disable-next-line osfo/no-unknown-parameters -- This decoder owns the provider response trust boundary.
export const decodeExecutionResponse = (input: unknown): ProviderExecutionResult => {
  const decoded = Schema.decodeUnknownSync(SessionExecutionResponse)(input, {
    onExcessProperty: "error",
  });
  const toolResult = Schema.decodeUnknownOption(ToolExecutionEnvelope)(decoded.data);
  if (Option.isNone(toolResult)) {
    return { data: decoded.data, error: decoded.error, logId: decoded.log_id };
  }
  return {
    data: toolResult.value.data,
    error:
      decoded.error ??
      toolResult.value.error ??
      (toolResult.value.successful ? null : "Provider tool execution was unsuccessful"),
    logId: decoded.log_id,
  };
};

const providerCall = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => providerFailure(operation, providerFailureReason(cause)),
  });

const providerFailure = (
  operation: string,
  reason: IntegrationProviderUnavailable["reason"] = "unavailable",
) =>
  new IntegrationProviderUnavailable({
    cause: operation,
    message: "The Composio Platform operation is unavailable",
    operation,
    reason,
  });

const providerFailureReason = (cause: unknown): IntegrationProviderUnavailable["reason"] =>
  Option.isSome(Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Literal(404) }))(cause))
    ? "missing"
    : "unavailable";

class ComposioHttpFailure extends Schema.TaggedError<ComposioHttpFailure>()("ComposioHttpFailure", {
  message: Schema.String,
  status: Schema.Finite,
}) {}

export * as ComposioProvider from "./provider";
