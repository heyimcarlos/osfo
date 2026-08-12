import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { UIMessage } from "ai";

const origin = "http://localhost:1337";
const prototypeToken = "local-prototype-only";

const authorize = HttpClientRequest.setHeader("authorization", `Bearer ${prototypeToken}`);

const requestJson = <A>(request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    return (yield* response.json) as A;
  }).pipe(Effect.provide(FetchHttpClient.layer));

export const getHealth = () =>
  requestJson<{ readonly status: string }>(HttpClientRequest.get(`${origin}/health`));

export const bindChannel = (input: {
  readonly agentId: string;
  readonly channelIdentity: string;
}) =>
  requestJson<{ readonly bound: boolean }>(
    HttpClientRequest.post(`${origin}/bindings`).pipe(
      authorize,
      HttpClientRequest.bodyJsonUnsafe(input),
    ),
  );

export const sendMessage = (input: {
  readonly channelIdentity: string;
  readonly messageId: string;
  readonly text: string;
}) =>
  requestJson<{
    readonly agentId: string;
    readonly receipt: {
      readonly accepted: boolean;
      readonly status: string;
      readonly submissionId: string;
    };
  }>(
    HttpClientRequest.post(`${origin}/messages`).pipe(
      authorize,
      HttpClientRequest.bodyJsonUnsafe(input),
    ),
  );

export const readAgentState = (agentId: string) =>
  requestJson<FoundationState>(
    HttpClientRequest.get(`${origin}/agents/${encodeURIComponent(agentId)}/state`).pipe(authorize),
  );

export const cancelSubmission = (agentId: string, submissionId: string) =>
  requestJson<{ readonly cancelled: boolean }>(
    HttpClientRequest.post(`${origin}/agents/${encodeURIComponent(agentId)}/cancel`).pipe(
      authorize,
      HttpClientRequest.bodyJsonUnsafe({ submissionId }),
    ),
  );

export const scheduleReminder = (
  agentId: string,
  input: { readonly delaySeconds: number; readonly reminderId: string; readonly text: string },
) =>
  requestJson<{ readonly schedule: { readonly id: string } }>(
    HttpClientRequest.post(`${origin}/agents/${encodeURIComponent(agentId)}/schedule`).pipe(
      authorize,
      HttpClientRequest.bodyJsonUnsafe(input),
    ),
  );

export type FoundationState = {
  readonly activationId: string;
  readonly foundation: {
    readonly activation: {
      readonly count: number;
      readonly lastActivationId: string;
    } | null;
    readonly receipts: ReadonlyArray<{
      readonly accepted: boolean;
      readonly messageId: string;
      readonly status: string;
      readonly submissionId: string;
    }>;
    readonly reminders: ReadonlyArray<{ readonly reminderId: string; readonly text: string }>;
  };
  readonly messages: ReadonlyArray<UIMessage>;
  readonly submissions: ReadonlyArray<{
    readonly status: string;
    readonly submissionId: string;
  }>;
};
