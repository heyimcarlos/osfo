import { Composio, logger, SessionPreset } from "@composio/core";
import ComposioClient from "@composio/client";
import { md5 } from "@noble/hashes/legacy.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Clock, Effect, Option, Redacted, Schema } from "effect";

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
const composioApiBaseUrl = "https://backend.composio.dev";
const composioTemporaryFilesHost = "temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com";
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

const DriveMetadataIdentity = Schema.Struct({ id: Schema.String });

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
    timeoutMillis?: number,
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

interface ComposioFilesPort {
  readonly createPresignedURL: (input: {
    readonly filename: string;
    readonly md5: string;
    readonly mimetype: string;
    readonly tool_slug: "GOOGLEDRIVE_UPLOAD_FILE";
    readonly toolkit_slug: "googledrive";
  }) => Promise<{
    readonly key: string;
    readonly new_presigned_url: string;
  }>;
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
  const filesClient = new ComposioClient({
    apiKey: value,
    baseURL: composioApiBaseUrl,
    maxRetries: 0,
    timeout: requestTimeoutMillis,
  });
  return makeFromClient({
    createSession: (userId, config) => composio.sessions.create(userId, config),
    executeOnce: (sessionId, providerTool, input, connectedAccountId, timeoutMillis) =>
      executeOnce(
        value,
        sessionId,
        providerTool,
        input,
        connectedAccountId,
        timeoutMillis ?? requestTimeoutMillis,
      ),
    disconnect: (connectedAccountId) =>
      composio.connectedAccounts.delete(connectedAccountId).then(() => undefined),
    listConnectedAccounts: (userId, toolkit) =>
      listConnectedAccounts(composio.connectedAccounts, userId, toolkit),
    uploadFile: (input) => uploadFile(filesClient.files, input),
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
  execute: (providerTool, input, connectedAccountId, constraints) => {
    if (providerTool === "GOOGLEDRIVE_DOWNLOAD_FILE" && "fileId" in input && "mime_type" in input) {
      return executeDriveDownload(
        client,
        session.sessionId,
        input,
        connectedAccountId,
        constraints?.maximumDownloadBytes,
      );
    }
    return providerCall("execute", () =>
      client.executeOnce(session.sessionId, providerTool, input, connectedAccountId),
    );
  },
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

const executeDriveDownload = (
  client: ComposioClientPort,
  sessionId: string,
  input: Extract<ProviderInput, { readonly mime_type: string }>,
  connectedAccountId: string,
  maximumBytes: number | undefined,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + requestTimeoutMillis;
    const remaining = Clock.currentTimeMillis.pipe(
      Effect.map((now) => Math.max(0, deadline - now)),
    );
    const metadataInput = {
      fields: "id,name,mimeType,size,modifiedTime,webViewLink",
      fileId: input.fileId,
      supportsAllDrives: true,
    } as const satisfies ProviderInput;
    const metadataTimeout = yield* remaining;
    if (metadataTimeout === 0) return yield* providerFailure("downloadFile");
    const metadata = yield* providerCall("downloadFile", () =>
      client.executeOnce(
        sessionId,
        "GOOGLEDRIVE_GET_FILE_METADATA",
        metadataInput,
        connectedAccountId,
        metadataTimeout,
      ),
    );
    if (metadata.error !== null) return yield* providerFailure("downloadFile");
    const metadataLogId = metadata.logId.trim();
    if (metadataLogId.length === 0 || metadataLogId.length > 500) {
      return yield* providerFailure("downloadFile");
    }
    const identity = yield* Schema.decodeUnknownEffect(DriveMetadataIdentity)(metadata.data).pipe(
      Effect.mapError(() => providerFailure("downloadFile")),
    );
    if (identity.id !== input.fileId) return yield* providerFailure("downloadFile");
    const downloadTimeout = yield* remaining;
    if (downloadTimeout === 0) return yield* providerFailure("downloadFile");
    const execution = yield* providerCall("execute", () =>
      client.executeOnce(
        sessionId,
        "GOOGLEDRIVE_DOWNLOAD_FILE",
        input,
        connectedAccountId,
        downloadTimeout,
      ),
    );
    if (execution.error !== null) return execution;
    return yield* normalizeDriveDownload(
      { ...execution, supportingLogIds: [metadataLogId] },
      identity.id,
      input.mime_type,
      maximumBytes,
      deadline,
    );
  });

const normalizeDriveDownload = (
  execution: ProviderExecutionResult,
  fileId: string,
  expectedMediaType: string,
  maximumBytes: number | undefined,
  deadline: number,
) =>
  Effect.gen(function* () {
    if (maximumBytes === undefined || maximumBytes < 1 || maximumBytes > 65_536) {
      return yield* providerFailure("downloadFile");
    }
    const downloaded = yield* Schema.decodeUnknownEffect(DownloadedFile)(
      execution.data.downloaded_file_content,
    ).pipe(Effect.mapError(() => providerFailure("downloadFile")));
    if (downloaded.mimetype !== expectedMediaType) return yield* providerFailure("downloadFile");
    if (!isSafeDownloadUrl(downloaded.s3url)) return yield* providerFailure("downloadFile");
    const downloadTimeout = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
    if (downloadTimeout === 0) return yield* providerFailure("downloadFile");
    const response = yield* providerCall("downloadFile", () =>
      // oxlint-disable-next-line osfo/no-raw-fetch, effecttsgo/global-fetch -- The provider adapter consumes one decoded, public HTTPS download reference.
      fetch(downloaded.s3url, {
        headers: { range: `bytes=0-${maximumBytes - 1}` },
        redirect: "error",
        signal: AbortSignal.timeout(downloadTimeout),
      }),
    );
    if (!response.ok && response.status !== 206) return yield* providerFailure("downloadFile");
    const read = yield* readBoundedBody(response, maximumBytes);
    const content = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(read.bytes),
      catch: () => providerFailure("downloadFile"),
    });
    return {
      ...execution,
      data: {
        content,
        fileId,
        mimeType: downloaded.mimetype,
        name: downloaded.name,
        size: read.bytes.byteLength,
        truncated: read.truncated,
      },
    };
  });

/** Stage one exact owned artifact through Composio's current presigned-file API in workerd. */
// oxlint-disable-next-line effecttsgo/async-function -- This adapter owns the ordered presign and upload Promise boundary.
export const uploadFile = async (
  files: ComposioFilesPort,
  input: { readonly bytes: Uint8Array; readonly fileName: string; readonly mediaType: string },
): Promise<{ readonly mimetype: string; readonly name: string; readonly s3key: string }> => {
  const requested = await files.createPresignedURL({
    filename: input.fileName,
    md5: bytesToHex(md5(input.bytes)),
    mimetype: input.mediaType,
    tool_slug: "GOOGLEDRIVE_UPLOAD_FILE",
    toolkit_slug: "googledrive",
  });
  if (!isSafeUploadUrl(requested.new_presigned_url)) throw new Error("Unsafe upload location");
  // oxlint-disable-next-line osfo/no-raw-fetch, effecttsgo/global-fetch -- The provider adapter owns the exact decoded presigned upload boundary.
  const response = await fetch(requested.new_presigned_url, {
    body: Uint8Array.from(input.bytes).buffer,
    headers: { "content-type": input.mediaType },
    method: "PUT",
    redirect: "error",
    signal: AbortSignal.timeout(requestTimeoutMillis),
  });
  if (!response.ok) throw new Error(`Composio staging failed with HTTP ${response.status}`);
  return { mimetype: input.mediaType, name: input.fileName, s3key: requested.key };
};

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
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hostname.toLowerCase() !== composioTemporaryFilesHost
  )
    return false;
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  return (
    url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
    (url.searchParams.get("X-Amz-Credential")?.length ?? 0) > 0 &&
    (url.searchParams.get("X-Amz-Date")?.length ?? 0) > 0 &&
    Number.isFinite(expires) &&
    expires > 0 &&
    expires <= 86_400 &&
    (url.searchParams.get("X-Amz-Signature")?.length ?? 0) > 0 &&
    url.searchParams.get("X-Amz-SignedHeaders") === "host"
  );
};

const isSafeUploadUrl = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    ![composioTemporaryFilesHost, "storage.composio.dev"].includes(url.hostname.toLowerCase())
  ) {
    return false;
  }
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  return (
    url.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
    (url.searchParams.get("X-Amz-Credential")?.length ?? 0) > 0 &&
    (url.searchParams.get("X-Amz-Date")?.length ?? 0) > 0 &&
    Number.isFinite(expires) &&
    expires > 0 &&
    expires <= 86_400 &&
    (url.searchParams.get("X-Amz-Signature")?.length ?? 0) > 0 &&
    url.searchParams.get("X-Amz-SignedHeaders") === "host"
  );
};

// oxlint-disable-next-line effecttsgo/async-function -- The SDK list operation is this Promise-based provider boundary's resource lifetime.
const listConnectedAccounts = async (
  connectedAccounts: ComposioConnectedAccountsPort,
  userId: string,
  toolkit: string,
): Promise<ComposioConnectedAccountList> => {
  const listed = await connectedAccounts.list({
    limit: 100,
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
  timeoutMillis: number,
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
      signal: AbortSignal.timeout(timeoutMillis),
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
