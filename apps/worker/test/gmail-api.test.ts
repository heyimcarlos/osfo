import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Redacted, Schema } from "effect";
import {
  HttpBody,
  HttpClient,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { ToolCallId, UserId } from "../src/domain";
import { ActionId } from "../src/domain/action-execution";
import {
  GmailConnectionId,
  GmailMessageId,
  GmailReadInput,
  GmailSendInput,
  GmailSearchInput,
  type GmailConnection,
} from "../src/domain/gmail";
import * as GmailApi from "../src/integrations/gmail/api";

describe("Gmail API adapter", () => {
  it.effect("performs bounded search and reads only returned message metadata", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const provider = yield* GmailApi.make(options).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          recordingClient(requests, (request) =>
            request.url.includes("/messages/message-search")
              ? jsonResponse(message("message-search", "thread-search"))
              : jsonResponse({ messages: [{ id: "message-search" }] }),
          ),
        ),
      );

      const result = yield* provider.search(
        connection,
        GmailSearchInput.make({
          maximumMessages: 2,
          query: "from:sender@example.com",
          toolCallId: ToolCallId.make("gmail-search-tool"),
        }),
      );

      expect(result).toEqual({
        messages: [
          {
            from: "sender@example.com",
            messageId: "message-search",
            subject: "A message",
          },
        ],
        vendorUsdMicros: 0n,
      });
      expect(requests).toHaveLength(2);
      expect(Object.fromEntries(requests[0]?.urlParams ?? []).maxResults).toBe("2");
      expect(
        requests.every((request) => request.headers.authorization === "Bearer access-token"),
      ).toBe(true);
    }),
  );

  it.effect("decodes the selected Gmail message body for local model summary and drafting", () =>
    Effect.gen(function* () {
      const provider = yield* GmailApi.make(options).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          recordingClient([], () => jsonResponse(message("message-read", "thread-read"))),
        ),
      );

      const result = yield* provider.read(
        connection,
        GmailReadInput.make({
          messageId: GmailMessageId.make("message-read"),
          toolCallId: ToolCallId.make("gmail-read-tool"),
        }),
      );

      expect(result).toMatchObject({
        body: "Body for local summary",
        from: "Sender <sender@example.com>",
        messageId: "message-read",
        subject: "A message",
      });
    }),
  );

  it.effect("sends exact approved MIME and reconciles with its deterministic Message-ID", () =>
    Effect.gen(function* () {
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      const provider = yield* GmailApi.make(options).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          recordingClient(requests, (request) => {
            if (request.method === "POST") return new Response(null, { status: 503 });
            return jsonResponse({ messages: [{ id: "message-reconciled" }] });
          }),
        ),
      );
      const input = GmailSendInput.make({
        actionId: ActionId.make("gmail-action-api-send"),
        body: "Exact approved body",
        recipient: "recipient@example.com",
        scheduledFor: null,
        selectedResourceId: null,
        subject: "Exact approved subject",
      });

      const prepared = yield* provider.prepareSend(connection, input);
      const uncertain = yield* prepared.contact;
      const reconciled = yield* provider.reconcileSend(connection, input);
      const sent = yield* decodeJsonBody(requests.find((request) => request.method === "POST"));
      const raw = decodeBase64Url(sent.raw);
      const reconciliation = requests.find(
        (request) =>
          request.method === "GET" && Object.fromEntries(request.urlParams).q !== undefined,
      );

      expect(uncertain).toMatchObject({ _tag: "Ambiguous" });
      expect(reconciled).toEqual({
        _tag: "Applied",
        evidence: "Gmail reconciliation found the sent message",
        providerMessageId: "message-reconciled",
        vendorUsdMicros: 0n,
      });
      expect(raw).toContain("To: recipient@example.com\r\n");
      expect(raw).toContain("Subject: Exact approved subject\r\n");
      expect(raw).toContain("\r\n\r\nExact approved body");
      const messageId = /^Message-ID: (.+)$/m.exec(raw)?.[1]?.trim();
      expect(messageId).toBeDefined();
      expect(Object.fromEntries(reconciliation?.urlParams ?? []).q).toBe(
        `rfc822msgid:${messageId}`,
      );
    }),
  );
});

const options: GmailApi.Options = {
  apiBaseURL: "https://gmail.test/gmail/v1/users/me",
  credentials: {
    resolveAccessToken: () => Effect.succeed(Redacted.make("access-token")),
  },
};

const connection = {
  _tag: "Connected",
  connectionId: GmailConnectionId.make("gmail-api-connection"),
  credentialReference: "better-auth-account-google",
  grantedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-17T12:00:00.000Z")),
  providerAccountId: "gmail-provider-account",
  userId: UserId.make("gmail-api-user"),
} satisfies Extract<GmailConnection, { readonly _tag: "Connected" }>;

const message = (id: string, threadId: string) => ({
  id,
  payload: {
    headers: [
      { name: "From", value: "Sender <sender@example.com>" },
      { name: "Subject", value: "A message" },
    ],
    mimeType: "text/plain",
    parts: [
      {
        body: { data: encodeBase64Url("Body for local summary") },
        mimeType: "text/plain",
      },
    ],
  },
  threadId,
});

const recordingClient = (
  requests: Array<HttpClientRequest.HttpClientRequest>,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, respond(request));
    }),
  );

type JsonFixture =
  | ReadonlyArray<JsonFixture>
  | { readonly [key: string]: JsonFixture }
  | boolean
  | null
  | number
  | string;

const encodeJsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const jsonResponse = (body: JsonFixture) =>
  new Response(encodeJsonText(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

const SendBody = Schema.Struct({ raw: Schema.String });
const decodeJsonBody = (request: HttpClientRequest.HttpClientRequest | undefined) =>
  request?.body instanceof HttpBody.Uint8Array
    ? Schema.decodeEffect(Schema.fromJsonString(SendBody))(
        new TextDecoder().decode(request.body.body),
      )
    : Effect.die("The Gmail send request must contain a JSON body");

const encodeBase64Url = (value: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const decodeBase64Url = (value: string) => {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
};
