/* oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Vitest global setup owns this Node HTTP boundary. */
/* oxlint-disable osfo/no-runtime-typeof, osfo/no-unknown-parameters -- This test-only emulator decodes raw Node HTTP representations at its boundary. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
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

interface StripeCheckoutState {
  readonly clientReferenceId: string;
  readonly customerId: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly successUrl: string;
  readonly subscriptionId: string;
  state: "complete" | "open";
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

/** One observed Meta messages API request. */
export interface WhatsAppLedgerEntry {
  readonly body: string;
  readonly method: string;
  readonly path: string;
  readonly recordedAt: string;
}

/** One observed deterministic Research Report provider operation. */
export interface ResearchLedgerEntry {
  readonly kind: "agent" | "discover" | "page" | "synthesize" | "tool-selection";
  readonly operationId: string | null;
  readonly selectedTool?: string;
  readonly subject: string;
}

/** One exact local Integration provider execution observed at the provider boundary. */
export interface IntegrationLedgerEntry {
  readonly connectedAccountId: string;
  readonly input: JsonObject;
  readonly logId: string;
  readonly providerSessionId: string;
  readonly providerTool: string;
  readonly recordedAt: string;
  readonly resourceId: string;
  readonly userId: string;
}

interface TelegramPayload {
  readonly chatId: number | string;
  readonly messageId?: number;
  readonly text: string;
}

type JsonValue = boolean | number | string | null | JsonObject | ReadonlyArray<JsonValue>;

interface JsonObject {
  readonly [key: string]: JsonValue;
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
const SupermemorySeedRequestFromJson = Schema.fromJsonString(
  Schema.Struct({ userId: Schema.String.check(Schema.isMinLength(1)) }),
);
const SupermemoryDeleteFailuresFromJson = Schema.fromJsonString(
  Schema.Struct({ count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const ResearchRequest = Schema.Struct({
  limit: Schema.optional(Schema.Int),
  messages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(Schema.Json),
        name: Schema.optional(Schema.String),
        role: Schema.optional(Schema.String),
        tool_call_id: Schema.optional(Schema.String),
      }),
    ),
  ),
  operationId: Schema.optional(Schema.String),
  query: Schema.optional(Schema.String),
  sources: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.String,
        sourceId: Schema.String,
        title: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  topic: Schema.optional(Schema.String),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({
        function: Schema.optional(Schema.Struct({ name: Schema.String })),
      }),
    ),
  ),
  url: Schema.optional(Schema.String),
});
type ResearchRequest = typeof ResearchRequest.Type;
const ResearchRequestFromJson = Schema.fromJsonString(ResearchRequest);
const LocalIntegrationRequestFromJson = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      callbackUrl: Schema.optional(Schema.String),
      connectedAccountId: Schema.optional(Schema.String),
      input: Schema.optional(Schema.JsonObject),
      providerTool: Schema.optional(Schema.String),
      toolkit: Schema.optional(Schema.String),
      toolkits: Schema.optional(Schema.Array(Schema.String)),
      userId: Schema.optional(Schema.String),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
);

const researchSourceUrl = "https://research.verify.osfo.test/durable-workflows";
const researchSourceContent =
  "Deterministic Research Report verification preserves canonical public source evidence across durable Workflow recovery.";

/** Local HTTP providers and their request ledgers for composed Worker journeys. */
export interface ProviderEmulator {
  readonly close: () => Promise<void>;
  readonly origin: string;
}

export const startProviderEmulator = (): Promise<ProviderEmulator> =>
  new Promise((resolve, reject) => {
    const stripeLedger: Array<StripeLedgerEntry> = [];
    const stripeCheckouts = new Map<string, StripeCheckoutState>();
    const supermemoryContainers = new Set<string>();
    let supermemoryDeleteFailuresRemaining = 0;
    const supermemoryLedger: Array<SupermemoryLedgerEntry> = [];
    const telegramLedger: Array<TelegramLedgerEntry> = [];
    const twilioLedger: Array<TwilioLedgerEntry> = [];
    const whatsAppLedger: Array<WhatsAppLedgerEntry> = [];
    const researchLedger: Array<ResearchLedgerEntry> = [];
    const integrationLedger: Array<IntegrationLedgerEntry> = [];
    const integrationSessions = new Map<string, string>();
    const integrationConnections = new Set<string>();
    let whatsAppNextResponseStatus: number | null = null;
    let whatsAppTemplateOnly = false;
    const server = createServer((request, response) => {
      const rawUrl = request.url ?? "/";
      const url = new URL(rawUrl.startsWith("//") ? rawUrl.slice(1) : rawUrl, "http://localhost");
      const pathname = url.pathname;
      if (request.method === "POST" && pathname === "/_test/reset") {
        stripeLedger.length = 0;
        stripeCheckouts.clear();
        supermemoryContainers.clear();
        supermemoryDeleteFailuresRemaining = 0;
        supermemoryLedger.length = 0;
        telegramLedger.length = 0;
        twilioLedger.length = 0;
        whatsAppLedger.length = 0;
        researchLedger.length = 0;
        integrationLedger.length = 0;
        integrationSessions.clear();
        integrationConnections.clear();
        whatsAppNextResponseStatus = null;
        whatsAppTemplateOnly = false;
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
      if (request.method === "GET" && pathname === "/_test/supermemory/containers") {
        const sortedContainers = [...supermemoryContainers];
        // oxlint-disable-next-line unicorn/no-array-sort -- The Worker target lacks ES2023 toSorted; this local array is fresh.
        sortedContainers.sort();
        respondJson(response, 200, sortedContainers);
        return;
      }
      if (request.method === "POST" && pathname === "/_test/supermemory/seed") {
        handleSupermemorySeed(request, response, supermemoryContainers);
        return;
      }
      if (request.method === "POST" && pathname === "/_test/supermemory/delete-failures") {
        readTextBody(request)
          .then(Schema.decodeUnknownPromise(SupermemoryDeleteFailuresFromJson))
          .then(({ count }) => {
            supermemoryDeleteFailuresRemaining = count;
            response.statusCode = 204;
            response.end();
          })
          .catch((cause: unknown) => respondJson(response, 400, { error: String(cause) }));
        return;
      }
      if (request.method === "GET" && pathname.startsWith("/v3/container-tags/")) {
        supermemoryLedger.push({ method: request.method, path: pathname });
        const containerTag = decodeURIComponent(pathname.slice("/v3/container-tags/".length));
        if (!supermemoryContainers.has(containerTag)) {
          respondJson(response, 404, { error: "absent" });
          return;
        }
        respondJson(response, 200, { containerTag });
        return;
      }
      if (request.method === "DELETE" && pathname.startsWith("/v3/container-tags/")) {
        supermemoryLedger.push({ method: request.method, path: pathname });
        if (supermemoryDeleteFailuresRemaining > 0) {
          supermemoryDeleteFailuresRemaining -= 1;
          respondJson(response, 503, { error: "temporarily unavailable" });
          return;
        }
        const containerTag = decodeURIComponent(pathname.slice("/v3/container-tags/".length));
        const removed = supermemoryContainers.delete(containerTag);
        respondJson(
          response,
          removed ? 200 : 404,
          removed
            ? {
                containerTag,
                deletedDocumentsCount: 0,
                deletedMemoriesCount: 0,
                success: true,
              }
            : { error: "absent" },
        );
        return;
      }
      if (request.method === "GET" && pathname === "/_test/telegram/ledger") {
        respondJson(response, 200, telegramLedger);
        return;
      }
      if (request.method === "GET" && pathname === "/_test/research/ledger") {
        respondJson(response, 200, researchLedger);
        return;
      }
      if (request.method === "GET" && pathname === "/_test/integrations/ledger") {
        respondJson(response, 200, integrationLedger);
        return;
      }
      if (request.method === "POST" && pathname === "/_test/integrations/reset-ledger") {
        integrationLedger.length = 0;
        response.statusCode = 204;
        response.end();
        return;
      }
      if (pathname.startsWith("/_local/integrations/")) {
        handleLocalIntegrations(
          request,
          response,
          url,
          integrationSessions,
          integrationConnections,
          integrationLedger,
        );
        return;
      }
      if (request.method === "POST" && pathname.startsWith("/_local/research/")) {
        handleResearch(request, response, pathname, researchLedger);
        return;
      }
      if (request.method === "GET" && pathname === "/_test/whatsapp/ledger") {
        respondJson(response, 200, whatsAppLedger);
        return;
      }
      if (request.method === "POST" && pathname === "/_test/whatsapp/reset") {
        whatsAppLedger.length = 0;
        whatsAppNextResponseStatus = null;
        whatsAppTemplateOnly = false;
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "POST" && pathname === "/_test/whatsapp/template-only") {
        whatsAppTemplateOnly = true;
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "POST" && pathname === "/_test/whatsapp/allow-messages") {
        whatsAppTemplateOnly = false;
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method === "POST" && pathname === "/_test/whatsapp/next-response") {
        const status = Number.parseInt(url.searchParams.get("status") ?? "", 10);
        if (![400, 429, 503].includes(status)) {
          respondJson(response, 400, { error: "Unsupported WhatsApp test response" });
          return;
        }
        whatsAppNextResponseStatus = status;
        response.statusCode = 204;
        response.end();
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
        handleStripe(request, response, pathname, stripeLedger, stripeCheckouts);
        return;
      }
      if (request.method === "GET" && pathname.startsWith("/v1/checkout/sessions/")) {
        handleStripeCheckoutRead(response, pathname, stripeCheckouts);
        return;
      }
      if (request.method === "GET" && pathname.startsWith("/v1/subscriptions/")) {
        handleStripeSubscriptionRead(response, pathname, stripeCheckouts);
        return;
      }
      if (request.method === "GET" && pathname === "/v1/invoice_payments") {
        respondJson(response, 200, {
          data: [],
          has_more: false,
          object: "list",
          url: "/v1/invoice_payments",
        });
        return;
      }
      if (request.method === "GET" && pathname.startsWith("/_local/stripe/checkout/")) {
        handleStripeCheckoutPage(response, pathname, stripeCheckouts);
        return;
      }
      if (request.method === "POST" && pathname.startsWith("/_local/stripe/checkout/")) {
        handleStripeCheckoutCompletion(response, pathname, stripeCheckouts);
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
      if (request.method === "POST" && pathname.endsWith("/messages")) {
        readTextBody(request)
          .then((body) => {
            whatsAppLedger.push({
              body,
              method: request.method ?? "POST",
              path: pathname,
              recordedAt: new Date().toISOString(),
            });
            const decoded = Schema.decodeOption(UnknownFromJsonString)(body);
            if (
              whatsAppTemplateOnly &&
              (Option.isNone(decoded) || !isExactWhatsAppTemplateRequest(decoded.value))
            ) {
              respondJson(response, 422, {
                error: "Only the fixed variable-free template is accepted",
              });
              return;
            }
            if (whatsAppNextResponseStatus !== null) {
              const status = whatsAppNextResponseStatus;
              whatsAppNextResponseStatus = null;
              respondJson(response, status, {
                error: { code: status === 400 ? 132001 : status, message: "emulated" },
              });
              return;
            }
            respondJson(response, 200, {
              contacts: [{ input: "redacted", wa_id: "redacted" }],
              messages: [{ id: `wamid.emulated.${whatsAppLedger.length}` }],
              messaging_product: "whatsapp",
            });
          })
          .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
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

const isExactWhatsAppTemplateRequest = (value: unknown): boolean => {
  if (!hasExactKeys(value, ["messaging_product", "recipient_type", "template", "to", "type"])) {
    return false;
  }
  const template = value.template;
  if (
    value.messaging_product !== "whatsapp" ||
    value.recipient_type !== "individual" ||
    value.type !== "template" ||
    typeof value.to !== "string" ||
    !/^\d{5,20}$/u.test(value.to) ||
    !hasExactKeys(template, ["language", "name"])
  ) {
    return false;
  }
  const language = template.language;
  return (
    template.name === "osfo_update" &&
    hasExactKeys(language, ["code"]) &&
    (language.code === "en" || language.code === "es")
  );
};

const hasExactKeys = (value: unknown, keys: ReadonlyArray<string>): value is JsonObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
};

const handleLocalIntegrations = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: Map<string, string>,
  connections: Set<string>,
  ledger: Array<IntegrationLedgerEntry>,
): void => {
  const segments = url.pathname.split("/").filter(Boolean);
  const sessionId = segments[3];
  const operation = segments[4];
  if (request.method === "GET" && operation === undefined && sessionId !== undefined) {
    const userId = sessions.get(sessionId);
    respondJson(
      response,
      userId === undefined ? 404 : 200,
      userId === undefined ? { error: "Session not found" } : { providerSessionId: sessionId },
    );
    return;
  }
  if (request.method === "GET" && operation === "connect" && sessionId !== undefined) {
    renderLocalIntegrationConnect(response, url, sessionId, sessions);
    return;
  }
  if (request.method === "POST" && operation === "connect" && sessionId !== undefined) {
    completeLocalIntegrationConnect(response, url, sessionId, sessions, connections);
    return;
  }
  readTextBody(request)
    .then(Schema.decodeUnknownPromise(LocalIntegrationRequestFromJson))
    .then((input) => {
      if (request.method === "POST" && sessionId === undefined && operation === undefined) {
        const userId = input.userId;
        if (userId === undefined) {
          respondJson(response, 400, { error: "User is required" });
          return;
        }
        const nextSessionId = `integration-session-${sessions.size + 1}`;
        sessions.set(nextSessionId, userId);
        respondJson(response, 201, { providerSessionId: nextSessionId });
        return;
      }
      if (sessionId === undefined || sessions.get(sessionId) !== input.userId) {
        respondJson(response, 404, { error: "Session not found" });
        return;
      }
      if (operation === "authorize") {
        if (input.toolkit !== "gmail" || input.callbackUrl === undefined) {
          respondJson(response, 400, { error: "Only Gmail verification is supported" });
          return;
        }
        const host = headerValue(request.headers.host);
        const redirect = new URL(
          `/_local/integrations/sessions/${sessionId}/connect`,
          host === null ? url.origin : `http://${host}`,
        );
        redirect.searchParams.set("callback", input.callbackUrl);
        redirect.searchParams.set("toolkit", input.toolkit);
        respondJson(response, 200, { redirectUrl: redirect.href });
        return;
      }
      if (operation === "toolkits") {
        const requested = input.toolkits ?? [];
        respondJson(
          response,
          200,
          requested.map((toolkit) => ({
            connectedAccount:
              toolkit === "gmail" && connections.has(input.userId ?? "")
                ? { id: integrationAccountId(input.userId ?? ""), status: "ACTIVE" }
                : null,
            isActive: toolkit === "gmail" && connections.has(input.userId ?? ""),
            slug: toolkit,
          })),
        );
        return;
      }
      if (operation === "disconnect") {
        connections.delete(input.userId ?? "");
        respondJson(response, 200, { disconnected: true });
        return;
      }
      if (operation === "execute") {
        executeLocalIntegration(response, sessionId, input, connections, ledger);
        return;
      }
      if (operation === "inspect") {
        const exact = ledger.filter(
          (entry) =>
            entry.providerSessionId === sessionId && sameJsonObject(entry.input, input.input),
        );
        respondJson(
          response,
          200,
          exact.length === 1
            ? {
                _tag: "Applied",
                execution: {
                  data: { id: exact[0]?.resourceId ?? "" },
                  error: null,
                  logId: exact[0]?.logId ?? "",
                },
              }
            : { _tag: "Unknown" },
        );
        return;
      }
      respondJson(response, 404, { error: "Unsupported local Integration operation" });
    })
    .catch((cause: unknown) => respondJson(response, 400, { error: String(cause) }));
};

const renderLocalIntegrationConnect = (
  response: ServerResponse,
  url: URL,
  sessionId: string,
  sessions: ReadonlyMap<string, string>,
): void => {
  if (!sessions.has(sessionId) || url.searchParams.get("toolkit") !== "gmail") {
    respondJson(response, 404, { error: "Connect request not found" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Local Gmail verification</title></head>
<body><main><h1>Local Gmail verification</h1>
<p>This deterministic provider-boundary account is local and is not live Gmail OAuth.</p>
<form method="post"><button type="submit">Connect local Gmail</button></form>
</main></body></html>`);
};

const completeLocalIntegrationConnect = (
  response: ServerResponse,
  url: URL,
  sessionId: string,
  sessions: ReadonlyMap<string, string>,
  connections: Set<string>,
): void => {
  const userId = sessions.get(sessionId);
  const callback = url.searchParams.get("callback");
  if (userId === undefined || callback === null || !URL.canParse(callback)) {
    respondJson(response, 400, { error: "Connect request is invalid" });
    return;
  }
  connections.add(userId);
  response.statusCode = 303;
  response.setHeader("location", callback);
  response.end();
};

const executeLocalIntegration = (
  response: ServerResponse,
  sessionId: string,
  input: typeof LocalIntegrationRequestFromJson.Type,
  connections: ReadonlySet<string>,
  ledger: Array<IntegrationLedgerEntry>,
): void => {
  const userId = input.userId ?? "";
  const message = input.input;
  if (
    !connections.has(userId) ||
    input.providerTool !== "GMAIL_SEND_EMAIL" ||
    input.connectedAccountId !== integrationAccountId(userId) ||
    message === undefined
  ) {
    respondJson(response, 409, { error: "Exact Gmail authority is unavailable" });
    return;
  }
  const ordinal = ledger.length + 1;
  const logId = `local-gmail-log-${ordinal}`;
  const resourceId = `local-gmail-message-${ordinal}`;
  ledger.push({
    connectedAccountId: input.connectedAccountId,
    input: message,
    logId,
    providerSessionId: sessionId,
    providerTool: input.providerTool,
    recordedAt: new Date().toISOString(),
    resourceId,
    userId,
  });
  respondJson(response, 200, { data: { id: resourceId }, error: null, logId });
};

const integrationAccountId = (userId: string) =>
  `local-gmail-${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`;

const sameJsonObject = (left: JsonObject, right: JsonObject | undefined): boolean =>
  right !== undefined && JSON.stringify(left) === JSON.stringify(right);

const handleSupermemorySeed = (
  request: IncomingMessage,
  response: ServerResponse,
  containers: Set<string>,
): void => {
  readTextBody(request)
    .then(Schema.decodeUnknownPromise(SupermemorySeedRequestFromJson))
    .then(({ userId }) => {
      const containerTag = `u_${createHash("sha256").update(userId).digest("base64url")}`;
      containers.add(containerTag);
      respondJson(response, 201, { containerTag });
    })
    .catch((cause: unknown) => respondJson(response, 400, { error: String(cause) }));
};

const handleResearch = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  ledger: Array<ResearchLedgerEntry>,
): void => {
  readTextBody(request)
    .then(Schema.decodeUnknownPromise(ResearchRequestFromJson))
    .then((input) => {
      if (pathname.endsWith("/agent")) {
        const toolNames = availableToolNames(input);
        const lastMessage = lastMessageContent(input);
        ledger.push({
          kind: "agent",
          operationId: null,
          subject: lastMessageText(input).slice(0, 500),
        });
        if (toolNames.includes("present_link") && lastMessageRole(input) === "user") {
          respondJson(response, 200, toolResponse("present_link", {}));
          return;
        }
        const workflowId = /research[:\w-]{8,300}/iu.exec(lastMessage)?.[0];
        const documentBuildWorkflowId = /document-build:[\w:-]{8,300}/iu.exec(lastMessage)?.[0];
        const documentBuildFileId = /web:[0-9a-f-]{36}/iu.exec(lastMessage)?.[0];
        const scheduledEmailWorkflowId = /scheduled-email:[\w:-]{8,300}/iu.exec(lastMessage)?.[0];
        const scheduledEmailFixture =
          /recipient=([^;]+); subject=([^;]+); body=([^;]+); sendAt=([^;\s]+)/iu.exec(lastMessage);
        if (
          scheduledEmailWorkflowId !== undefined &&
          toolNames.includes("inspectScheduledEmail") &&
          lastMessageRole(input) === "user" &&
          /(?:inspect|status|check)/iu.test(lastMessage)
        ) {
          ledger.push({
            kind: "tool-selection",
            operationId: null,
            selectedTool: "inspectScheduledEmail",
            subject: scheduledEmailWorkflowId,
          });
          respondJson(
            response,
            200,
            toolResponse("inspectScheduledEmail", { workflowId: scheduledEmailWorkflowId }),
          );
          return;
        }
        if (
          scheduledEmailFixture !== null &&
          toolNames.includes("scheduleEmail") &&
          lastMessageRole(input) === "user"
        ) {
          const [, recipient, subject, body, scheduledAt] = scheduledEmailFixture;
          if (
            recipient === undefined ||
            subject === undefined ||
            body === undefined ||
            scheduledAt === undefined
          ) {
            respondJson(response, 400, { error: "Scheduled Email fixture is incomplete" });
            return;
          }
          ledger.push({
            kind: "tool-selection",
            operationId: null,
            selectedTool: "scheduleEmail",
            subject: `${recipient}|${subject}|${body}|${scheduledAt}`,
          });
          respondJson(
            response,
            200,
            toolResponse("scheduleEmail", {
              body,
              gmailResource: "primary",
              recipients: [recipient],
              scheduledAt,
              subject,
            }),
          );
          return;
        }
        if (
          documentBuildWorkflowId !== undefined &&
          toolNames.includes("inspectDocumentBuild") &&
          lastMessageRole(input) === "user" &&
          /(?:inspect|status|check)/iu.test(lastMessage)
        ) {
          ledger.push({
            kind: "tool-selection",
            operationId: null,
            selectedTool: "inspectDocumentBuild",
            subject: documentBuildWorkflowId,
          });
          respondJson(
            response,
            200,
            toolResponse("inspectDocumentBuild", { workflowId: documentBuildWorkflowId }),
          );
          return;
        }
        if (
          documentBuildFileId !== undefined &&
          toolNames.includes("startDocumentBuild") &&
          lastMessageRole(input) === "user" &&
          /(?:build|document|pdf)/iu.test(lastMessage)
        ) {
          ledger.push({
            kind: "tool-selection",
            operationId: null,
            selectedTool: "startDocumentBuild",
            subject: documentBuildFileId,
          });
          respondJson(
            response,
            200,
            toolResponse("startDocumentBuild", {
              fileIds: [documentBuildFileId],
              format: "pdf",
            }),
          );
          return;
        }
        if (
          workflowId !== undefined &&
          toolNames.includes("inspectResearchReport") &&
          lastMessageRole(input) === "user" &&
          /(?:inspect|status|check)/iu.test(lastMessage)
        ) {
          respondJson(response, 200, toolResponse("inspectResearchReport", { workflowId }));
          return;
        }
        if (
          workflowId !== undefined &&
          toolNames.includes("cancelResearchReport") &&
          lastMessageRole(input) === "user" &&
          /cancel/iu.test(lastMessage)
        ) {
          respondJson(response, 200, toolResponse("cancelResearchReport", { workflowId }));
          return;
        }
        if (
          toolNames.includes("startResearchReport") &&
          lastMessageRole(input) === "user" &&
          /(?:investigate|research|sources)/iu.test(lastMessage)
        ) {
          respondJson(
            response,
            200,
            toolResponse("startResearchReport", {
              consequences: [],
              format: "pdf",
              queries: ["durable workflow verification"],
              topic: "Durable Workflow verification",
            }),
          );
          return;
        }
        respondJson(response, 200, {
          finish_reason: "stop",
          response: `Committed Osfo result: ${lastMessageContent(input).slice(0, 1_800)}`,
          usage: { completion_tokens: 1, prompt_tokens: 1 },
        });
        return;
      }
      if (pathname.endsWith("/discover") && input.query !== undefined) {
        ledger.push({ kind: "discover", operationId: null, subject: input.query });
        respondJson(response, 200, {
          requestId: `research-discover-${ledger.length}`,
          results: [{ title: "Durable Workflow verification", url: researchSourceUrl }],
        });
        return;
      }
      if (pathname.endsWith("/page") && input.url === researchSourceUrl) {
        ledger.push({ kind: "page", operationId: null, subject: input.url });
        respondJson(response, 200, {
          content: researchSourceContent,
          contentType: "text/plain; charset=utf-8",
          finalUrl: researchSourceUrl,
          status: 200,
          title: "Durable Workflow verification",
        });
        return;
      }
      const source = input.sources?.[0];
      if (
        pathname.endsWith("/synthesize") &&
        input.operationId !== undefined &&
        input.topic !== undefined &&
        source !== undefined &&
        source.content.includes(researchSourceContent)
      ) {
        ledger.push({
          kind: "synthesize",
          operationId: input.operationId,
          subject: input.topic,
        });
        const claim = {
          evidence: [{ quote: researchSourceContent, sourceId: source.sourceId }],
          statement: researchSourceContent,
        };
        respondJson(response, 200, {
          result: {
            conclusion: [claim],
            sections: [{ heading: "Verified evidence", materialClaims: [claim] }],
            summary: [claim],
            title: "Deterministic Research Report verification",
          },
        });
        return;
      }
      respondJson(response, 400, { error: "Invalid Research Report provider request" });
    })
    .catch((cause: unknown) => respondJson(response, 400, { error: String(cause) }));
};

const toolResponse = (name: string, arguments_: JsonObject) => ({
  finish_reason: "tool_calls",
  response: "",
  tool_calls: [{ arguments: arguments_, id: `verification-${name}`, name }],
  usage: { completion_tokens: 1, prompt_tokens: 1 },
});

const availableToolNames = (input: ResearchRequest): ReadonlyArray<string> =>
  input.tools?.flatMap((tool) => (tool.function === undefined ? [] : [tool.function.name])) ?? [];

const lastMessageRole = (input: ResearchRequest): string | null => {
  const message = lastMessage(input);
  return message?.role ?? null;
};

const lastMessageText = (input: ResearchRequest): string => {
  const message = lastMessage(input);
  return message === null ? "" : JSON.stringify(message);
};

const lastMessageContent = (input: ResearchRequest): string => {
  const message = lastMessage(input);
  if (message?.content !== undefined) {
    if (typeof message.content === "string") return message.content;
    return JSON.stringify(message.content);
  }
  return lastMessageText(input);
};

const lastMessage = (input: ResearchRequest) => input.messages?.at(-1) ?? null;

const handleStripe = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  ledger: Array<StripeLedgerEntry>,
  checkouts: Map<string, StripeCheckoutState>,
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
      const parameters = Object.fromEntries(new URLSearchParams(body));
      const checkoutId = "cs_test_emulated";
      const checkout = {
        clientReferenceId: parameters.client_reference_id ?? "",
        customerId: parameters.customer ?? "",
        metadata: stripeMetadata(parameters),
        state: "open" as const,
        subscriptionId: "sub_emulated",
        successUrl: parameters.success_url ?? "",
      };
      checkouts.set(checkoutId, checkout);
      const host = headerValue(request.headers.host);
      const origin = host === null ? "http://127.0.0.1" : `http://${host}`;
      respondJson(response, 200, {
        expires_at: Math.floor(Date.now() / 1_000) + 60 * 60,
        id: checkoutId,
        object: "checkout.session",
        status: "open",
        url: `${origin}/_local/stripe/checkout/${checkoutId}`,
      });
    })
    .catch((cause: unknown) => respondJson(response, 500, { error: String(cause) }));
};

const stripeMetadata = (
  parameters: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(parameters).flatMap(([key, value]) => {
      if (!key.startsWith("metadata[") || !key.endsWith("]")) return [];
      const name = key.slice("metadata[".length, -1);
      return name.length === 0 ? [] : [[name, value]];
    }),
  );

const handleStripeCheckoutRead = (
  response: ServerResponse,
  pathname: string,
  checkouts: ReadonlyMap<string, StripeCheckoutState>,
): void => {
  const checkoutId = pathname.slice("/v1/checkout/sessions/".length);
  const checkout = checkouts.get(checkoutId);
  if (checkout === undefined) {
    respondJson(response, 404, { error: { message: "Checkout Session not found" } });
    return;
  }
  respondJson(response, 200, {
    client_reference_id: checkout.clientReferenceId,
    customer: checkout.customerId,
    expires_at: Math.floor(Date.now() / 1_000) + 60 * 60,
    id: checkoutId,
    metadata: checkout.metadata,
    object: "checkout.session",
    status: checkout.state,
    subscription: checkout.state === "complete" ? checkout.subscriptionId : null,
    url: null,
  });
};

const handleStripeSubscriptionRead = (
  response: ServerResponse,
  pathname: string,
  checkouts: ReadonlyMap<string, StripeCheckoutState>,
): void => {
  const subscriptionId = pathname.slice("/v1/subscriptions/".length);
  const checkout = [...checkouts.values()].find(
    (candidate) => candidate.subscriptionId === subscriptionId && candidate.state === "complete",
  );
  if (checkout === undefined) {
    respondJson(response, 404, { error: { message: "Subscription not found" } });
    return;
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  respondJson(response, 200, {
    cancel_at_period_end: false,
    customer: checkout.customerId,
    id: checkout.subscriptionId,
    items: {
      data: [
        {
          current_period_end: nowSeconds + 30 * 24 * 60 * 60,
          current_period_start: nowSeconds,
          price: {
            id: checkout.metadata.priceId,
            product: checkout.metadata.productId,
          },
          quantity: 1,
        },
      ],
    },
    latest_invoice: { id: "in_emulated", status: "paid" },
    metadata: { userId: checkout.metadata.userId },
    object: "subscription",
    status: "active",
  });
};

const handleStripeCheckoutPage = (
  response: ServerResponse,
  pathname: string,
  checkouts: ReadonlyMap<string, StripeCheckoutState>,
): void => {
  const checkoutId = pathname.slice("/_local/stripe/checkout/".length);
  const checkout = checkouts.get(checkoutId);
  if (checkout === undefined) {
    respondJson(response, 404, { error: "Checkout Session not found" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Local Stripe verification</title></head>
  <body>
    <main>
      <h1>Local Stripe verification</h1>
      <p>This deterministic checkout exercises Osfo's production billing reconciliation path.</p>
      <p>Adventurer · CA$25 monthly</p>
      <form method="post" action="/_local/stripe/checkout/${checkoutId}">
        <button type="submit">Complete verification checkout</button>
      </form>
    </main>
  </body>
</html>`);
};

const handleStripeCheckoutCompletion = (
  response: ServerResponse,
  pathname: string,
  checkouts: Map<string, StripeCheckoutState>,
): void => {
  const checkoutId = pathname.slice("/_local/stripe/checkout/".length);
  const checkout = checkouts.get(checkoutId);
  if (checkout === undefined) {
    respondJson(response, 404, { error: "Checkout Session not found" });
    return;
  }
  checkout.state = "complete";
  const location = checkout.successUrl.replace("{CHECKOUT_SESSION_ID}", checkoutId);
  response.statusCode = 303;
  response.setHeader("location", location);
  response.end();
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
