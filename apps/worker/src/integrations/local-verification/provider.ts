/* oxlint-disable effecttsgo/any-unknown-in-error-context, effecttsgo/global-fetch-in-effect, osfo/no-raw-fetch -- This module is the explicit loopback-only HTTP host adapter and owns schema decoding services. */
import { Effect, Schema } from "effect";

import type { UserId } from "../../domain";
import {
  IntegrationProviderUnavailable,
  type IntegrationArtifact,
  type IntegrationProvider,
  type ProviderAttemptCorrelation,
  type ProviderExecutionEvidence,
  type ProviderInput,
  type ProviderSession,
} from "../../services/integrations";

const SessionCreated = Schema.Struct({ providerSessionId: Schema.String });
const ConnectRedirect = Schema.Struct({ redirectUrl: Schema.URLFromString });
const ToolkitEvidence = Schema.Array(
  Schema.Struct({
    connectedAccount: Schema.NullOr(Schema.Struct({ id: Schema.String, status: Schema.String })),
    isActive: Schema.Boolean,
    slug: Schema.String,
  }),
);
const ExecutionResult = Schema.Struct({
  data: Schema.JsonObject,
  error: Schema.NullOr(Schema.String),
  logId: Schema.String,
});
const ExecutionEvidence = Schema.Union([
  Schema.TaggedStruct("Applied", { execution: ExecutionResult }),
  Schema.TaggedStruct("NotApplied", { providerLogId: Schema.String }),
  Schema.TaggedStruct("Unknown", {}),
]);

type LocalVerificationRequest =
  | { readonly callbackUrl: string; readonly toolkit: string; readonly userId: UserId }
  | { readonly connectedAccountId: string; readonly userId: UserId }
  | {
      readonly connectedAccountId: string;
      readonly input: ProviderInput;
      readonly providerTool: string;
      readonly userId: UserId;
    }
  | {
      readonly correlation: ProviderAttemptCorrelation;
      readonly input: ProviderInput;
    }
  | { readonly toolkits: ReadonlyArray<string>; readonly userId: UserId }
  | { readonly userId: UserId };

/** Deterministic loopback Integration adapter used only by explicit local verification config. */
export const make = (baseURL: string): IntegrationProvider => ({
  createSession: (userId) =>
    request(baseURL, "sessions", "POST", { userId }, SessionCreated).pipe(
      Effect.map(({ providerSessionId }) => ({
        providerSessionId,
        session: session(baseURL, userId, providerSessionId),
      })),
    ),
  useSession: (userId, providerSessionId) =>
    request(
      baseURL,
      `sessions/${encodeURIComponent(providerSessionId)}`,
      "GET",
      undefined,
      SessionCreated,
    ).pipe(Effect.as(session(baseURL, userId, providerSessionId))),
});

const session = (baseURL: string, userId: UserId, providerSessionId: string): ProviderSession => ({
  authorize: (toolkit, callbackUrl) =>
    request(
      baseURL,
      `sessions/${encodeURIComponent(providerSessionId)}/authorize`,
      "POST",
      { callbackUrl: callbackUrl.href, toolkit, userId },
      ConnectRedirect,
    ).pipe(Effect.map(({ redirectUrl }) => redirectUrl)),
  disconnect: (connectedAccountId) =>
    request(
      baseURL,
      `sessions/${encodeURIComponent(providerSessionId)}/disconnect`,
      "POST",
      { connectedAccountId, userId },
      Schema.Struct({ disconnected: Schema.Literal(true) }),
    ).pipe(Effect.asVoid),
  execute: (providerTool, input, connectedAccountId) =>
    request(
      baseURL,
      `sessions/${encodeURIComponent(providerSessionId)}/execute`,
      "POST",
      { connectedAccountId, input, providerTool, userId },
      ExecutionResult,
    ),
  inspectExecution: (correlation, input) =>
    inspectExecution(baseURL, providerSessionId, correlation, input),
  inspectToolkits: (toolkits) =>
    request(
      baseURL,
      `sessions/${encodeURIComponent(providerSessionId)}/toolkits`,
      "POST",
      { toolkits, userId },
      ToolkitEvidence,
    ),
  stageFile: (_artifact: IntegrationArtifact) => Effect.fail(unavailable("stageFile")),
});

const inspectExecution = (
  baseURL: string,
  providerSessionId: string,
  correlation: ProviderAttemptCorrelation,
  input: ProviderInput,
): Effect.Effect<ProviderExecutionEvidence, IntegrationProviderUnavailable> =>
  request(
    baseURL,
    `sessions/${encodeURIComponent(providerSessionId)}/inspect`,
    "POST",
    { correlation, input },
    ExecutionEvidence,
  );

const request = <S extends Schema.Top>(
  baseURL: string,
  path: string,
  method: "GET" | "POST",
  body: LocalVerificationRequest | undefined,
  schema: S,
): Effect.Effect<S["Type"], IntegrationProviderUnavailable, S["DecodingServices"]> =>
  Effect.gen(function* () {
    const encoded =
      body === undefined
        ? undefined
        : yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))(body).pipe(
            Effect.mapError(() => unavailable(path)),
          );
    const response = yield* Effect.tryPromise({
      try: () => {
      const url = new URL(`_local/integrations/${path}`, baseURL);
      if (method === "GET") {
        return fetch(url, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      }
      return fetch(url, {
        body: encoded ?? null,
        headers: { "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      },
      catch: () => unavailable(path),
    });
    if (!response.ok) return yield* unavailable(path);
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => unavailable(path),
    });
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() => unavailable(path)),
    );
  });

const unavailable = (operation: string) =>
  new IntegrationProviderUnavailable({
    cause: operation,
    message: "The local Integration verification provider is unavailable",
    operation,
    reason: "unavailable",
  });

export * as LocalVerificationIntegrationProvider from "./provider";
