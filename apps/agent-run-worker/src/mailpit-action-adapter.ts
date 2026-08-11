import {
  type ActionAttempt,
  ActionExternalAdapter,
  type ActionExternalResult,
} from "@osfo/agent-run";
import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { Data, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

export const MailpitActionAdapterConfigSchema = Schema.Struct({
  apiOrigin: Schema.String.check(Schema.isNonEmpty()),
  fault: Schema.Literals(["none", "loseDataAcknowledgement"]),
  requestTimeoutMs: PositiveInteger,
  smtpHost: Schema.Literals(["127.0.0.1", "localhost"]),
  smtpPort: PositiveInteger.check(Schema.isLessThanOrEqualTo(65_535)),
});

export type MailpitActionAdapterConfig = typeof MailpitActionAdapterConfigSchema.Type;

export class InvalidMailpitActionAdapterConfig extends Data.TaggedError(
  "InvalidMailpitActionAdapterConfig",
)<{ readonly cause: unknown }> {}

const SearchResponseSchema = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

type SmtpPhase = "greeting" | "ehlo" | "mailFrom" | "recipient" | "data" | "acceptance";

const fixedSender = "osfo-demo-sender@example.invalid";
const fixedRecipient = "osfo-demo-recipient@example.invalid";
const fixedBody = "This is the Osfo approval-gated demo email.";

const applied = { type: "applied" } as const satisfies ActionExternalResult;
const notApplied = { type: "notApplied" } as const satisfies ActionExternalResult;
const uncertain = { type: "uncertain" } as const satisfies ActionExternalResult;

export const mailpitMessageIdForToolCall = (toolCallId: string) =>
  `<osfo-${createHash("sha256").update(toolCallId, "utf8").digest("hex")}@osfo.invalid>`;

const encodedSubject = (subject: string) =>
  `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;

const renderMessage = (toolCallId: string, subject: string) =>
  [
    `From: ${fixedSender}`,
    `To: ${fixedRecipient}`,
    `Subject: ${encodedSubject(subject)}`,
    `Message-ID: ${mailpitMessageIdForToolCall(toolCallId)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    fixedBody,
    ".",
    "",
  ].join("\r\n");

const sendSmtpMessage = (
  config: MailpitActionAdapterConfig,
  toolCallId: string,
  subject: string,
): Effect.Effect<ActionExternalResult> =>
  Effect.callback<ActionExternalResult>((resume) => {
    let phase: SmtpPhase = "greeting";
    let replyBuffer = "";
    let dataTerminatorSent = false;
    let settled = false;
    let socket: Socket;

    const settle = (result: ActionExternalResult, preserveSocket = false) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeAllListeners("data");
      socket.removeAllListeners("timeout");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      if (preserveSocket) {
        socket.on("error", () => undefined);
      } else {
        socket.destroy();
      }
      resume(Effect.succeed(result));
    };

    const write = (text: string) => {
      socket.write(text);
    };

    const rejectReply = () => settle(dataTerminatorSent ? uncertain : notApplied);

    const handleReply = (code: number) => {
      switch (phase) {
        case "greeting":
          if (code !== 220) return rejectReply();
          phase = "ehlo";
          return write("EHLO localhost\r\n");
        case "ehlo":
          if (code !== 250) return rejectReply();
          phase = "mailFrom";
          return write(`MAIL FROM:<${fixedSender}>\r\n`);
        case "mailFrom":
          if (code !== 250) return rejectReply();
          phase = "recipient";
          return write(`RCPT TO:<${fixedRecipient}>\r\n`);
        case "recipient":
          if (code !== 250 && code !== 251) return rejectReply();
          phase = "data";
          return write("DATA\r\n");
        case "data": {
          if (code !== 354) return rejectReply();
          phase = "acceptance";
          dataTerminatorSent = true;
          if (config.fault === "loseDataAcknowledgement") {
            socket.pause();
            socket.write(renderMessage(toolCallId, subject), () => {
              socket.end();
              settle(uncertain, true);
            });
            return;
          }
          return write(renderMessage(toolCallId, subject));
        }
        case "acceptance":
          return settle(code === 250 ? applied : notApplied);
      }
    };

    socket = createConnection({ host: config.smtpHost, port: config.smtpPort });
    socket.setEncoding("utf8");
    socket.setTimeout(config.requestTimeoutMs);
    socket.on("timeout", () => settle(dataTerminatorSent ? uncertain : notApplied));
    socket.on("error", () => settle(dataTerminatorSent ? uncertain : notApplied));
    socket.on("close", () => settle(dataTerminatorSent ? uncertain : notApplied));
    socket.on("data", (chunk: string) => {
      replyBuffer += chunk;
      while (!settled) {
        const lineEnd = replyBuffer.indexOf("\r\n");
        if (lineEnd < 0) return;
        const line = replyBuffer.slice(0, lineEnd);
        replyBuffer = replyBuffer.slice(lineEnd + 2);
        const match = /^(\d{3})([ -])/.exec(line);
        if (match === null) return rejectReply();
        if (match[2] === "-") continue;
        handleReply(Number(match[1]));
      }
    });

    return Effect.sync(() => socket.destroy());
  });

const validateConfig = (config: MailpitActionAdapterConfig) =>
  Schema.decodeUnknownEffect(MailpitActionAdapterConfigSchema)(config).pipe(
    Effect.mapError((cause) => new InvalidMailpitActionAdapterConfig({ cause })),
    Effect.flatMap((decoded) =>
      Effect.try({
        try: () => new URL(decoded.apiOrigin),
        catch: (cause) => new InvalidMailpitActionAdapterConfig({ cause }),
      }).pipe(
        Effect.filterOrFail(
          (apiUrl) =>
            apiUrl.protocol === "http:" &&
            (apiUrl.hostname === "127.0.0.1" || apiUrl.hostname === "localhost") &&
            apiUrl.username.length === 0 &&
            apiUrl.password.length === 0,
          () =>
            new InvalidMailpitActionAdapterConfig({
              cause: "Mailpit API origin must be an unauthenticated loopback HTTP origin",
            }),
        ),
        Effect.map((apiUrl) => ({ ...decoded, apiOrigin: apiUrl.origin })),
      ),
    ),
  );

const adapterLayer = (config: MailpitActionAdapterConfig) =>
  Layer.effect(
    ActionExternalAdapter,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      // This guard narrows same-process duplicate contact after an ambiguous SMTP result. The
      // durable ActionAttempt state remains authoritative across worker replacement.
      const ambiguousToolCallIds = new Set<string>();

      const searchByToolCallId = (toolCallId: string) => {
        const url = new URL("/api/v1/search", config.apiOrigin);
        url.searchParams.set("query", `message-id:"${mailpitMessageIdForToolCall(toolCallId)}"`);
        return http.execute(HttpClientRequest.get(url.toString())).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponseSchema)),
          Effect.timeoutOrElse({
            duration: config.requestTimeoutMs,
            orElse: () => Effect.succeed(undefined),
          }),
          Effect.match({
            onFailure: () => undefined,
            onSuccess: (response) => response?.total,
          }),
        );
      };

      const reconcileByToolCallId = (toolCallId: string) =>
        Effect.gen(function* () {
          for (let poll = 0; poll < 5; poll += 1) {
            const count = yield* searchByToolCallId(toolCallId);
            if (count === 1) return applied;
            if (count === undefined || count > 1) return uncertain;
            if (poll < 4) yield* Effect.sleep(25);
          }
          return uncertain;
        });

      const reconcile = Effect.fn("MailpitActionAdapter.reconcile")((attempt: ActionAttempt) =>
        reconcileByToolCallId(attempt.action.toolCallId),
      );

      const dispatch = Effect.fn("MailpitActionAdapter.dispatch")((attempt: ActionAttempt) =>
        Effect.gen(function* () {
          if (ambiguousToolCallIds.has(attempt.action.toolCallId)) {
            return yield* reconcileByToolCallId(attempt.action.toolCallId);
          }
          const existingCount = yield* searchByToolCallId(attempt.action.toolCallId);
          if (existingCount === 1) return applied;
          if (existingCount === undefined || existingCount > 1) return uncertain;
          const result = yield* sendSmtpMessage(
            config,
            attempt.action.toolCallId,
            attempt.action.subject,
          );
          if (result.type === "uncertain") {
            ambiguousToolCallIds.add(attempt.action.toolCallId);
          }
          return result;
        }),
      );

      return ActionExternalAdapter.of({ dispatch, reconcile });
    }),
  );

export const makeMailpitActionAdapterLayer = (config: MailpitActionAdapterConfig) =>
  Layer.unwrap(validateConfig(config).pipe(Effect.map(adapterLayer)));
