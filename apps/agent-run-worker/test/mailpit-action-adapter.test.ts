import { NodeHttpClient } from "@effect/platform-node";
import { ActionExternalAdapter, type ActionAttempt } from "@osfo/agent-run";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  mailpitMessageIdForToolCall,
  makeMailpitActionAdapterLayer,
  type MailpitActionAdapterConfig,
} from "../src/mailpit-action-adapter.js";

const enabled = process.env.OSFO_TEST_MAILPIT === "1";
const apiOrigin = process.env.OSFO_TEST_MAILPIT_API_ORIGIN ?? "http://127.0.0.1:18025";
const smtpPort = Number(process.env.OSFO_TEST_MAILPIT_SMTP_PORT ?? "11025");

const MessagesResponseSchema = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  messages: Schema.Array(
    Schema.Struct({
      MessageID: Schema.String,
    }),
  ),
});

const actionAttempt = {
  actionAttemptId: "c8472530-866d-4a31-9fb6-eb6498e5126d",
  action: {
    toolCallId: "tool_4ad4707e-a960-448b-ab7b-6edcc7ae213f",
    agentRunId: "d9999212-a36d-4d59-9980-16fe356e9da1",
    actionDefinitionRef: "sendDemoEmail.v1",
    actionDigest: "9".repeat(64),
    subject: "Osfo controlled demo action",
    presentation: {
      version: 1,
      title: "Send demo email",
      description: "Send the fixed local demonstration email.",
      fields: [{ label: "Subject", value: "Osfo controlled demo action" }],
    },
    successBoundary: {
      ref: "mailpitMessageStored.v1",
      description: "The exact Message-ID is stored once by the local Mailpit service.",
    },
  },
  attemptNumber: 1,
  authorizationRevision: "authorization-revision-1",
  claimEpoch: "1",
} as const satisfies ActionAttempt;

const config = (fault: MailpitActionAdapterConfig["fault"]): MailpitActionAdapterConfig => ({
  apiOrigin,
  fault,
  requestTimeoutMs: 2_000,
  smtpHost: "127.0.0.1",
  smtpPort,
});

const provideHttp = <A, E, R>(effect: Effect.Effect<A, E, R | HttpClient.HttpClient>) =>
  effect.pipe(Effect.provide(NodeHttpClient.layerUndici));

const clearMessages = Effect.gen(function* () {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* http.execute(
    HttpClientRequest.make("DELETE")(`${apiOrigin}/api/v1/messages`),
  );
  yield* response.text;
});

const loadMessages = Effect.gen(function* () {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* http.execute(HttpClientRequest.get(`${apiOrigin}/api/v1/messages`));
  return yield* HttpClientResponse.schemaBodyJson(MessagesResponseSchema)(response);
});

const realDelay = (milliseconds: number) =>
  Effect.promise<void>(() => new Promise((resolve) => setTimeout(resolve, milliseconds)));

const awaitApplied = (adapter: ActionExternalAdapter["Service"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const result = yield* adapter.reconcile(actionAttempt);
      if (result.type === "applied") return result;
      yield* realDelay(25);
    }
    return yield* Effect.die("Mailpit did not make the accepted message observable");
  });

describe("conservative Mailpit Action reconciliation", () => {
  it.live("keeps a bounded zero-result search uncertain", () => {
    let requestCount = 0;
    const zeroSearchHttp = HttpClient.make((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ total: 0 }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        );
      }),
    );

    return ActionExternalAdapter.use((adapter) => adapter.reconcile(actionAttempt)).pipe(
      Effect.provide(
        makeMailpitActionAdapterLayer(config("none")).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, zeroSearchHttp)),
        ),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toEqual({ type: "uncertain" });
          expect(requestCount).toBe(5);
        }),
      ),
    );
  });
});

describe.runIf(enabled)("controlled local Mailpit Action adapter", () => {
  it.live("reconciles a lost DATA acknowledgement without redispatch", () =>
    ActionExternalAdapter.use((adapter) =>
      Effect.gen(function* () {
        yield* provideHttp(clearMessages);

        const dispatchResult = yield* adapter.dispatch(actionAttempt);
        expect(dispatchResult).toEqual({ type: "uncertain" });

        const immediateReconciliation = yield* adapter.reconcile(actionAttempt);
        const duplicateDispatch = yield* adapter.dispatch(actionAttempt);
        const eventualReconciliation = yield* awaitApplied(adapter);
        const messages = yield* provideHttp(loadMessages);

        expect(["applied", "uncertain"]).toContain(immediateReconciliation.type);
        expect(["applied", "uncertain"]).toContain(duplicateDispatch.type);
        expect(eventualReconciliation).toEqual({ type: "applied" });
        expect(messages.total).toBe(1);
        expect(messages.messages.map((message) => message.MessageID)).toEqual([
          mailpitMessageIdForToolCall(actionAttempt.action.toolCallId).slice(1, -1),
        ]);
      }),
    ).pipe(
      Effect.provide(
        makeMailpitActionAdapterLayer(config("loseDataAcknowledgement")).pipe(
          Layer.provide(NodeHttpClient.layerUndici),
        ),
      ),
    ),
  );

  it.live("suppresses a sequential duplicate dispatch by exact Message-ID", () =>
    ActionExternalAdapter.use((adapter) =>
      Effect.gen(function* () {
        yield* provideHttp(clearMessages);

        const firstDispatch = yield* adapter.dispatch(actionAttempt);
        const duplicateDispatch = yield* adapter.dispatch(actionAttempt);
        const reconciliation = yield* adapter.reconcile(actionAttempt);
        const messages = yield* provideHttp(loadMessages);

        expect(firstDispatch).toEqual({ type: "applied" });
        expect(duplicateDispatch).toEqual({ type: "applied" });
        expect(reconciliation).toEqual({ type: "applied" });
        expect(messages.total).toBe(1);
      }),
    ).pipe(
      Effect.provide(
        makeMailpitActionAdapterLayer(config("none")).pipe(
          Layer.provide(NodeHttpClient.layerUndici),
        ),
      ),
    ),
  );
});
