import { Composio, SessionPreset } from "@composio/core";
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
const composioApiBaseUrl = "https://backend.composio.dev";
const toolkitVersions = {
  gmail: "20260817_00",
  googlecalendar: "20260812_00",
  googledrive: "20260815_00",
} as const;

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

interface ComposioSessionPort {
  readonly authorize: (
    toolkit: string,
    options: { readonly callbackUrl: string },
  ) => Promise<{ readonly redirectUrl?: string | null }>;
  readonly sessionId: string;
  readonly toolkits: (options: { readonly toolkits: Array<string> }) => Promise<{
    readonly items: ReadonlyArray<{
      readonly connection?:
        | {
            readonly connectedAccount?:
              | { readonly id: string; readonly status: string }
              | undefined;
            readonly isActive: boolean;
          }
        | undefined;
      readonly slug: string;
    }>;
  }>;
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
  ) => Promise<ProviderExecutionResult>;
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
  const composio = new Composio({
    allowTracking: false,
    apiKey: value,
    dangerouslyAllowAutoUploadDownloadFiles: false,
    fileUploadDirs: false,
    toolkitVersions,
  });
  return makeFromClient({
    createSession: (userId, config) => composio.sessions.create(userId, config),
    executeOnce: (sessionId, providerTool, input) =>
      executeOnce(value, sessionId, providerTool, input),
    useSession: (providerSessionId) => composio.sessions.use(providerSessionId),
  });
};

/** Adapt the current SDK surface behind the provider-independent Integrations port. */
export const makeFromClient = (client: ComposioClientPort): IntegrationProvider => ({
  createSession: (userId: UserId, config) =>
    providerCall("createSession", () =>
      client.createSession(userId, composioSessionConfig(config)),
    ).pipe(
      Effect.map((session) => ({
        providerSessionId: session.sessionId,
        session: adaptSession(client, session),
      })),
    ),
  useSession: (providerSessionId) =>
    providerCall("useSession", () => client.useSession(providerSessionId)).pipe(
      Effect.map((session) => adaptSession(client, session)),
    ),
});

const adaptSession = (
  client: ComposioClientPort,
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
  execute: (providerTool, input) =>
    providerCall("execute", () => client.executeOnce(session.sessionId, providerTool, input)),
  inspectToolkits: (toolkits) =>
    providerCall("inspectToolkits", () => session.toolkits({ toolkits: [...toolkits] })).pipe(
      Effect.map(({ items }) =>
        items.map(({ connection, slug }): ProviderToolkitEvidence => ({
          connectedAccount: connection?.connectedAccount ?? null,
          isActive: connection?.isActive ?? false,
          slug,
        })),
      ),
    ),
});

/** One exact HTTP dispatch avoids hidden SDK retries for an Osfo Action attempt. */
// oxlint-disable-next-line effecttsgo/async-function -- Fetch response decoding is this Promise-based provider boundary's resource lifetime.
const executeOnce = async (
  apiKey: string,
  sessionId: string,
  providerTool: string,
  input: ProviderInput,
): Promise<ProviderExecutionResult> => {
  // Osfo owns Action retry policy; this host adapter performs one request because the current session SDK may retry writes.
  // oxlint-disable-next-line osfo/no-raw-fetch, effecttsgo/global-fetch -- This is the Composio host adapter and must preserve one execution attempt.
  const response = await fetch(
    `${composioApiBaseUrl}/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/execute`,
    {
      body: JSON.stringify({ arguments: input, tool_slug: providerTool }),
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMillis),
    },
  );
  if (!response.ok) throw new Error(`Composio execute failed with HTTP ${response.status}`);
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

export * as ComposioProvider from "./provider";
