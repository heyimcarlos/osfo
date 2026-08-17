import { Effect, type Redacted, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  GmailMessageId,
  type GmailSendInput,
  type GmailReadEvidence,
  type GmailSendEvidence,
  GmailProviderUnavailable,
  type GmailSearchEvidence,
} from "../../domain/gmail";
import type { Provider } from "../../services/gmail";

const GmailMessageReference = Schema.Struct({ id: GmailMessageId });
const GmailMessageList = Schema.Struct({
  messages: Schema.optional(Schema.Array(GmailMessageReference)),
});
const GmailHeader = Schema.Struct({ name: Schema.String, value: Schema.String });
const GmailPayloadPart = Schema.Struct({
  body: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String) })),
  headers: Schema.optional(Schema.Array(GmailHeader)),
  mimeType: Schema.optional(Schema.String),
});
const GmailMessage = Schema.Struct({
  id: GmailMessageId,
  payload: Schema.optional(
    Schema.Struct({
      ...GmailPayloadPart.fields,
      parts: Schema.optional(Schema.Array(GmailPayloadPart)),
    }),
  ),
  threadId: Schema.optional(Schema.String),
});

type ConnectedConnection = Parameters<Provider["read"]>[0];

/** Resolve the current OAuth access token behind one stored Gmail credential reference. */
export interface CredentialResolver {
  readonly resolveAccessToken: (
    connection: ConnectedConnection,
    operation: GmailProviderUnavailable["operation"],
  ) => Effect.Effect<Redacted.Redacted, GmailProviderUnavailable>;
}

/** Focused Gmail API adapter options. */
export interface Options {
  readonly apiBaseURL?: string;
  readonly credentials: CredentialResolver;
}

/** Construct the Gmail API provider with the current Effect HTTP client. */
export const make = (options: Options): Effect.Effect<Provider, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const baseURL = options.apiBaseURL ?? "https://gmail.googleapis.com/gmail/v1/users/me";

    const read: Provider["read"] = (connection, input) =>
      getMessage(client, options.credentials, baseURL, connection, input.messageId).pipe(
        Effect.map((message): GmailReadEvidence => ({
          body: messageBody(message),
          from: header(message, "From") ?? "",
          messageId: message.id,
          subject: header(message, "Subject") ?? "",
          vendorUsdMicros: 0n,
        })),
      );

    const search: Provider["search"] = (connection, input) =>
      Effect.gen(function* () {
        const listed = yield* executeJson(
          client,
          options.credentials,
          connection,
          HttpClientRequest.get(`${baseURL}/messages`).pipe(
            HttpClientRequest.setUrlParams({
              maxResults: String(input.maximumMessages),
              q: input.query,
            }),
          ),
          GmailMessageList,
          "search",
        );
        const messages = yield* Effect.forEach(
          listed.messages ?? [],
          ({ id }) =>
            getMessage(client, options.credentials, baseURL, connection, id).pipe(
              Effect.flatMap((message) =>
                Schema.decodeEffect(
                  Schema.Struct({
                    from: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)),
                    messageId: GmailMessageId,
                    subject: Schema.String.check(Schema.isMaxLength(998)),
                  }),
                )({
                  from: mailboxAddress(header(message, "From") ?? ""),
                  messageId: message.id,
                  subject: header(message, "Subject") ?? "",
                }).pipe(Effect.mapError(() => unavailable("search", "invalid message metadata"))),
              ),
            ),
          { concurrency: 1 },
        );
        return { messages, vendorUsdMicros: 0n } satisfies GmailSearchEvidence;
      });

    const reconcileSend: Provider["reconcileSend"] = (connection, input) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          executeJson(
            client,
            options.credentials,
            connection,
            HttpClientRequest.get(`${baseURL}/messages`).pipe(
              HttpClientRequest.setUrlParams({ q: `rfc822msgid:${messageId(input.actionId)}` }),
            ),
            GmailMessageList,
            "send",
          ),
        );
        if (Result.isFailure(result)) {
          return ambiguous("Gmail reconciliation was unavailable");
        }
        const found = result.success.messages?.[0];
        return found === undefined
          ? ambiguous("Gmail has not confirmed whether it accepted the message")
          : applied(found.id, "Gmail reconciliation found the sent message");
      });

    const prepareSend: Provider["prepareSend"] = (connection, input) =>
      Effect.gen(function* () {
        const threadId =
          input.selectedResourceId === null
            ? undefined
            : (yield* getMessage(
                client,
                options.credentials,
                baseURL,
                connection,
                input.selectedResourceId,
              )).threadId;
        const token = yield* options.credentials.resolveAccessToken(connection, "send");
        const request = HttpClientRequest.post(`${baseURL}/messages/send`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({
            raw: encodeBase64Url(mimeMessage(input)),
            threadId,
          }),
        );
        return {
          contact: Effect.gen(function* () {
            const response = yield* Effect.result(client.execute(request));
            if (Result.isFailure(response)) {
              return ambiguous("The Gmail response was unavailable after provider contact");
            }
            if (response.success.status >= 400 && response.success.status < 500) {
              return notApplied("Gmail rejected the message before applying it");
            }
            if (response.success.status < 200 || response.success.status >= 300) {
              return ambiguous("Gmail returned an uncertain send response");
            }
            const decoded = yield* HttpClientResponse.schemaBodyJson(GmailMessageReference)(
              response.success,
            ).pipe(Effect.result);
            return Result.isFailure(decoded)
              ? ambiguous("Gmail returned invalid send evidence")
              : applied(decoded.success.id, "Gmail accepted the message");
          }),
        };
      });

    return { prepareSend, read, reconcileSend, search };
  });

const getMessage = (
  client: HttpClient.HttpClient,
  credentials: CredentialResolver,
  baseURL: string,
  connection: ConnectedConnection,
  message: GmailMessageId,
) =>
  executeJson(
    client,
    credentials,
    connection,
    HttpClientRequest.get(`${baseURL}/messages/${encodeURIComponent(message)}`).pipe(
      HttpClientRequest.setUrlParam("format", "full"),
    ),
    GmailMessage,
    "read",
  );

const executeJson = <A, Encoded>(
  client: HttpClient.HttpClient,
  credentials: CredentialResolver,
  connection: ConnectedConnection,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, Encoded>,
  operation: GmailProviderUnavailable["operation"],
) =>
  Effect.gen(function* () {
    const token = yield* credentials.resolveAccessToken(connection, operation);
    const response = yield* client
      .execute(HttpClientRequest.bearerToken(request, token))
      .pipe(Effect.mapError((cause) => unavailable(operation, cause)));
    if (response.status < 200 || response.status >= 300) {
      return yield* unavailable(operation, `Gmail returned HTTP ${response.status}`);
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError((cause) => unavailable(operation, cause)),
    );
  });

const header = (message: typeof GmailMessage.Type, name: string) =>
  message.payload?.headers?.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
    ?.value;

const messageBody = (message: typeof GmailMessage.Type) => {
  const encoded =
    message.payload?.parts?.find((part) => part.mimeType === "text/plain")?.body?.data ??
    message.payload?.body?.data;
  return encoded === undefined ? "" : decodeBase64Url(encoded);
};

const mailboxAddress = (value: string) => {
  const bracketed = /<([^<>]+)>/.exec(value)?.[1];
  return (bracketed ?? value).trim();
};

const mimeMessage = (input: GmailSendInput) =>
  [
    `To: ${input.recipient}`,
    `Subject: ${input.subject}`,
    `Message-ID: ${messageId(input.actionId)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.body.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
  ].join("\r\n");

const messageId = (actionId: string) => `<osfo.${encodeBase64Url(actionId)}@osfo.ai>`;

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

const applied = (providerMessageId: GmailMessageId, evidence: string): GmailSendEvidence => ({
  _tag: "Applied",
  evidence,
  providerMessageId,
  vendorUsdMicros: 0n,
});

const notApplied = (evidence: string): GmailSendEvidence => ({
  _tag: "NotApplied",
  evidence,
  vendorUsdMicros: 0n,
});

const ambiguous = (evidence: string): GmailSendEvidence => ({
  _tag: "Ambiguous",
  evidence,
  vendorUsdMicros: 0n,
});

const unavailable = (operation: GmailProviderUnavailable["operation"], cause: unknown) =>
  new GmailProviderUnavailable({
    cause,
    message: "The Gmail provider is unavailable",
    operation,
  });
