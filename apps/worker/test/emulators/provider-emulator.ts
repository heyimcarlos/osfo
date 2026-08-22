/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Vitest global setup owns this Node HTTP boundary. */
/* oxlint-disable osfo/no-runtime-typeof, osfo/no-unknown-parameters -- This test-only emulator decodes raw Node HTTP representations at its boundary. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

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

/** Local HTTP providers and their request ledgers for composed Worker journeys. */
export interface ProviderEmulator {
  readonly close: () => Promise<void>;
  readonly origin: string;
}

export const startProviderEmulator = (): Promise<ProviderEmulator> =>
  new Promise((resolve, reject) => {
    const stripeLedger: Array<StripeLedgerEntry> = [];
    const twilioLedger: Array<TwilioLedgerEntry> = [];
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && pathname === "/_test/reset") {
        stripeLedger.length = 0;
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
      if (request.method === "POST" && pathname === "/events/track") {
        readTextBody(request)
          .then(() => respondJson(response, 200, {}))
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
