/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Vitest global setup owns this Node HTTP boundary. */
/* oxlint-disable osfo/no-runtime-typeof, osfo/no-unknown-parameters -- This test-only emulator decodes raw Node HTTP representations at its boundary. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Option, Schema } from "effect";

/** One observed Twilio Verify request. */
export interface TwilioLedgerEntry {
  readonly code: string | null;
  readonly path: string;
  readonly to: string | null;
}

/** One observed Stripe API request. */
export interface StripeLedgerEntry {
  readonly idempotencyKey: string | null;
  readonly parameters: Readonly<Record<string, string>>;
  readonly path: string;
}

/** One observed Supermemory request. */
export interface SupermemoryLedgerEntry {
  readonly method: string;
  readonly path: string;
}

/** One observed Telegram Bot API request. */
export interface TelegramLedgerEntry {
  readonly body: string;
  readonly method: string;
}

interface TelegramPayload {
  readonly chatId: number | string;
  readonly messageId?: number;
  readonly text: string;
}

const TelegramRequest = Schema.Struct({
  chat_id: Schema.optional(Schema.Union([Schema.Finite, Schema.String])),
  message_id: Schema.optional(Schema.Finite),
  rich_message: Schema.optional(
    Schema.Struct({
      markdown: Schema.optional(Schema.String),
    }),
  ),
  text: Schema.optional(Schema.String),
});

const TelegramRequestFromJson = Schema.fromJsonString(TelegramRequest);

/** Local HTTP providers and their request ledgers for composed Worker journeys. */
export interface ProviderEmulator {
  readonly close: () => Promise<void>;
  readonly origin: string;
}

export const startProviderEmulator = (): Promise<ProviderEmulator> =>
  new Promise((resolve, reject) => {
    const stripeLedger: Array<StripeLedgerEntry> = [];
    const supermemoryLedger: Array<SupermemoryLedgerEntry> = [];
    const telegramLedger: Array<TelegramLedgerEntry> = [];
    const twilioLedger: Array<TwilioLedgerEntry> = [];
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && pathname === "/_test/reset") {
        stripeLedger.length = 0;
        supermemoryLedger.length = 0;
        telegramLedger.length = 0;
        twilioLedger.length = 0;
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "GET" && pathname === "/_test/twilio/ledger") {
        respondJson(response, 200, twilioLedger);
        return;
      }
      if (request.method === "GET" && pathname === "/_test/stripe/ledger") {
        respondJson(response, 200, stripeLedger);
        return;
      }
      if (request.method === "GET" && pathname === "/_test/supermemory/ledger") {
        respondJson(response, 200, supermemoryLedger);
        return;
      }
      if (request.method === "DELETE" && pathname.startsWith("/v3/container-tags/")) {
        supermemoryLedger.push({ method: request.method, path: pathname });
        respondJson(response, 200, { success: true });
        return;
      }
      if (request.method === "GET" && pathname === "/_test/telegram/ledger") {
        respondJson(response, 200, telegramLedger);
        return;
      }
      if (request.method === "POST" && pathname === "/events/track") {
        readTextBody(request)
          .then(() => respondJson(response, 200, {}))
          .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
        return;
      }
      if (request.method === "POST" && pathname === "/v4/profile") {
        readTextBody(request)
          .then(() =>
            respondJson(response, 200, {
              profile: { dynamic: [], static: [] },
              searchResults: { results: [], timing: 0, total: 0 },
            }),
          )
          .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
        return;
      }
      if (
        request.method === "POST" &&
        (pathname === "/v1/customers" || pathname === "/v1/checkout/sessions")
      ) {
        handleStripe(request, response, pathname, stripeLedger);
        return;
      }
      if (request.method === "POST" && pathname.startsWith("/v2/Services/")) {
        handleTwilio(request, response, pathname, twilioLedger);
        return;
      }
      if (request.method === "POST" && /^\/bot[^/]+\/[A-Za-z]+$/u.test(pathname)) {
        handleTelegram(request, response, pathname, telegramLedger);
        return;
      }
      respondJson(response, 404, {
        error: "Not found",
        method: request.method ?? null,
        pathname,
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Provider emulator did not acquire a TCP port"));
        return;
      }
      resolve({
        close: () => closeServer(server),
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });

const handleStripe = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  ledger: Array<StripeLedgerEntry>,
): void => {
  readTextBody(request)
    .then((body) => {
      ledger.push({
        idempotencyKey: headerValue(request.headers["idempotency-key"]),
        parameters: Object.fromEntries(new URLSearchParams(body)),
        path: pathname,
      });
      if (pathname === "/v1/customers") {
        respondJson(response, 200, { id: "cus_emulated", object: "customer" });
        return;
      }
      respondJson(response, 200, {
        expires_at: Math.floor(Date.now() / 1_000) + 60 * 60,
        id: "cs_test_emulated",
        object: "checkout.session",
        status: "open",
        url: "https://checkout.stripe.test/cs_test_emulated",
      });
    })
    .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
};

const handleTelegram = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  ledger: Array<TelegramLedgerEntry>,
): void => {
  readTextBody(request)
    .then((body) => {
      const method = pathname.slice(pathname.lastIndexOf("/") + 1);
      const payload = telegramPayload(body);
      ledger.push({ body, method });
      if (method === "getMe") {
        respondJson(response, 200, {
          ok: true,
          result: { first_name: "Osfo", id: 777_000, is_bot: true, username: "osfo_verify_bot" },
        });
        return;
      }
      if (method === "sendChatAction") {
        respondJson(response, 200, { ok: true, result: true });
        return;
      }
      respondJson(response, 200, {
        ok: true,
        result: {
          chat: { first_name: "Verification", id: payload.chatId, type: "private" },
          date: Math.floor(Date.now() / 1_000),
          message_id: payload.messageId ?? 900_000 + ledger.length,
          text: payload.text,
        },
      });
    })
    .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
};

const telegramPayload = (body: string): TelegramPayload => {
  const payload = Option.getOrUndefined(Schema.decodeOption(TelegramRequestFromJson)(body));
  if (payload === undefined) return { chatId: 700_001, text: "Osfo verification reply" };
  const chatId = payload.chat_id ?? 700_001;
  const text = payload.text ?? payload.rich_message?.markdown ?? "Osfo verification reply";
  if (payload.message_id === undefined) return { chatId, text };
  return { chatId, messageId: payload.message_id, text };
};

const handleTwilio = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  ledger: Array<TwilioLedgerEntry>,
): void => {
  readTextBody(request)
    .then((body) => {
      const parameters = new URLSearchParams(body);
      ledger.push({
        code: parameters.get("Code"),
        path: pathname,
        to: parameters.get("To"),
      });
      const checking = pathname.endsWith("/VerificationCheck");
      respondJson(
        response,
        checking ? 200 : 201,
        checking ? { status: "approved", valid: true } : { sid: "VE-emulated", status: "pending" },
      );
    })
    .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
};

const readTextBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

const headerValue = (value: string | ReadonlyArray<string> | undefined): string | null =>
  typeof value === "string" ? value : (value?.[0] ?? null);

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.closeAllConnections();
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });

const respondJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};
