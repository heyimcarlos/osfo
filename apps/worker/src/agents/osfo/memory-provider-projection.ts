import { Option, Schema } from "effect";

import { AllowancePeriodId, AssistantMessageId, SessionId, UserId } from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { MemoryProvider } from "../../services/memory-provider";

const MessageMetadata = Schema.Struct({
  turnMetadata: Schema.optional(ManagedTurnMetadata),
});
const TextPart = Schema.Struct({
  state: Schema.optional(Schema.Literals(["streaming", "done"])),
  text: Schema.String,
  type: Schema.Literal("text"),
});
const SourceUrlPart = Schema.Struct({
  title: Schema.optional(Schema.String),
  type: Schema.Literal("source-url"),
  url: Schema.String,
});
const SourceDocumentPart = Schema.Struct({
  filename: Schema.optional(Schema.String),
  title: Schema.String,
  type: Schema.Literal("source-document"),
});
const ToolOutcomePart = Schema.Struct({
  output: Schema.Json,
  state: Schema.Literal("output-available"),
  title: Schema.optional(Schema.String),
  type: Schema.String,
});

const sensitiveKey = /(?:authorization|credential|password|secret|token|api[-_]?key)/iu;
const infrastructureKeys = new Set([
  "colo",
  "cookie",
  "debug",
  "endpoint",
  "header",
  "headers",
  "host",
  "hostname",
  "infrastructure",
  "ipaddress",
  "log",
  "logs",
  "meta",
  "origin",
  "port",
  "raw",
  "rawtrace",
  "rayid",
  "region",
  "requestid",
  "response",
  "server",
  "service",
  "spanid",
  "stack",
  "statuscode",
  "stderr",
  "stdout",
  "traceid",
  "workerid",
]);
const secretValue =
  /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[a-z]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:authorization|credential|password|secret|token|api[-_ ]?key)\s*[:=]\s*\S+)/giu;

/** Exact immutable append payload derived from one committed Think turn. */
export const ConversationDeltaProjection = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  firstMessageId: Schema.String.check(Schema.isMinLength(1)),
  lastMessageId: AssistantMessageId,
  messages: Schema.NonEmptyArray(MemoryProvider.ConversationMessage),
  sessionId: SessionId,
  userId: UserId,
});

/** Exact immutable append payload derived from one committed Think turn. */
export type ConversationDeltaProjection = typeof ConversationDeltaProjection.Type;

interface ProjectableMessage {
  readonly id: string;
  readonly metadata?: unknown;
  readonly parts: ReadonlyArray<{ readonly type: string }>;
  readonly role: string;
}

/**
 * Capture only the human-visible delta ending at one committed assistant message.
 * Unknown and in-progress UI parts stay out of provider memory by default.
 */
export const projectCommittedConversationDelta = (
  history: ReadonlyArray<ProjectableMessage>,
  assistantMessageId: AssistantMessageId,
  sessionId: SessionId,
): Option.Option<ConversationDeltaProjection> => {
  const assistantIndex = history.findIndex(({ id }) => id === assistantMessageId);
  if (assistantIndex < 0 || history[assistantIndex]?.role !== "assistant") return Option.none();

  let previousAssistantIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "assistant") {
      previousAssistantIndex = index;
      break;
    }
  }
  const deltaStart = previousAssistantIndex + 1;
  const delta = history.slice(deltaStart, assistantIndex + 1);
  const metadata = findManagedTurnMetadata(history, deltaStart, assistantIndex, sessionId);
  if (Option.isNone(metadata)) return Option.none();

  const messages = delta.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const role = message.role === "user" ? ("user" as const) : ("assistant" as const);
    const content = message.parts
      .flatMap((part) => visiblePartText(part))
      .filter((text) => text.length > 0)
      .join("\n");
    return content.length === 0 ? [] : [{ content, role }];
  });
  const first = delta[0];
  const [firstProjectedMessage, ...remainingProjectedMessages] = messages;
  if (first === undefined || firstProjectedMessage === undefined) return Option.none();

  return Option.some(
    ConversationDeltaProjection.make({
      allowancePeriodId: metadata.value.allowancePeriodId,
      firstMessageId: first.id,
      lastMessageId: assistantMessageId,
      messages: [firstProjectedMessage, ...remainingProjectedMessages],
      sessionId,
      userId: metadata.value.authorityIdentity.userId,
    }),
  );
};

const findManagedTurnMetadata = (
  history: ReadonlyArray<ProjectableMessage>,
  deltaStart: number,
  assistantIndex: number,
  sessionId: SessionId,
): Option.Option<ManagedTurnMetadata> => {
  for (let index = assistantIndex; index >= deltaStart; index -= 1) {
    const message = history[index];
    if (message?.role !== "user") continue;
    const envelope = Schema.decodeUnknownOption(MessageMetadata)(message.metadata);
    if (Option.isSome(envelope) && envelope.value.turnMetadata?.sessionId === sessionId) {
      return Option.some(envelope.value.turnMetadata);
    }
  }
  return Option.none();
};

const visiblePartText = (part: ProjectableMessage["parts"][number]): ReadonlyArray<string> => {
  const text = Schema.decodeUnknownOption(TextPart)(part);
  if (Option.isSome(text) && text.value.state !== "streaming") {
    const value = sanitizeVisibleText(text.value.text);
    return value.length === 0 ? [] : [value];
  }

  const sourceUrl = Schema.decodeUnknownOption(SourceUrlPart)(part);
  if (Option.isSome(sourceUrl)) {
    const safeUrl = sanitizeSourceUrl(sourceUrl.value.url);
    if (Option.isNone(safeUrl)) return [];
    const title = sourceUrl.value.title?.trim();
    return [
      title === undefined || title.length === 0 ? safeUrl.value : `${title}: ${safeUrl.value}`,
    ];
  }

  const sourceDocument = Schema.decodeUnknownOption(SourceDocumentPart)(part);
  if (Option.isSome(sourceDocument)) {
    const title = sourceDocument.value.title.trim();
    const filename = sourceDocument.value.filename?.trim();
    return [
      filename === undefined || filename.length === 0 ? title : `${title} (${filename})`,
    ].filter((value) => value.length > 0);
  }

  if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return [];
  const tool = Schema.decodeUnknownOption(ToolOutcomePart)(part);
  if (Option.isNone(tool)) return [];
  const outcome = humanReadableOutcome(tool.value.output);
  if (Option.isNone(outcome)) return [];
  const title = tool.value.title?.trim();
  return [title === undefined || title.length === 0 ? outcome.value : `${title}: ${outcome.value}`];
};

const sanitizeSourceUrl = (value: string): Option.Option<string> => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return Option.none();
    if (isInfrastructureHostname(url.hostname)) return Option.none();
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return Option.some(url.href);
  } catch {
    return Option.none();
  }
};

const isInfrastructureHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".test") ||
    !normalized.includes(".")
  ) {
    return true;
  }
  if (
    normalized === "::1" ||
    normalized.startsWith("::ffff:") ||
    (normalized.includes(":") &&
      (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80")))
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

/* oxlint-disable osfo/no-runtime-typeof -- ToolOutcomePart decoded the value into this closed JSON union. */
const humanReadableOutcome = (value: Schema.Json): Option.Option<string> => {
  const sanitized = sanitizeJsonValue(value, 0);
  if (sanitized === undefined) return Option.none();
  if (typeof sanitized === "string") {
    const trimmed = sanitized.trim();
    return trimmed.length === 0 ? Option.none() : Option.some(trimmed);
  }
  return Option.some(JSON.stringify(sanitized));
};

type SafeJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<SafeJson>
  | { readonly [key: string]: SafeJson };

const sanitizeJsonValue = (value: Schema.Json, depth: number): SafeJson | undefined => {
  if (depth > 5) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Json))(trimmed);
      if (Option.isSome(parsed)) return sanitizeJsonValue(parsed.value, depth + 1);
    }
    const embedded = sanitizeEmbeddedJson(trimmed, depth);
    if (Option.isSome(embedded)) return embedded.value;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return Option.getOrUndefined(sanitizeSourceUrl(trimmed));
    }
    const redacted = redactSecrets(trimmed);
    return redacted.length === 0 ? undefined : redacted;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const values = value
      .slice(0, 50)
      .map((item) => sanitizeJsonValue(item, depth + 1))
      .filter((item): item is SafeJson => item !== undefined);
    return values;
  }
  if (typeof value !== "object") return undefined;
  const entries = Object.entries(value)
    .filter(([key]) => !sensitiveKey.test(key) && !isInfrastructureKey(key))
    .slice(0, 50)
    .flatMap(([key, item]) => {
      const safe = sanitizeJsonValue(item, depth + 1);
      return safe === undefined ? [] : ([[key, safe]] as const);
    });
  return Object.fromEntries(entries);
};
/* oxlint-enable osfo/no-runtime-typeof */

const isInfrastructureKey = (key: string): boolean =>
  infrastructureKeys.has(key.replaceAll(/[^a-z0-9]/giu, "").toLowerCase());

const sanitizeEmbeddedJson = (value: string, depth: number): Option.Option<string> => {
  const starts = [value.indexOf("{"), value.indexOf("[")].filter((index) => index > 0);
  for (const start of starts) {
    const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Json))(value.slice(start));
    if (Option.isNone(parsed)) continue;
    const sanitized = sanitizeJsonValue(parsed.value, depth + 1);
    if (sanitized === undefined) return Option.none();
    const prefix = redactSecrets(value.slice(0, start));
    return Option.some(`${prefix}${JSON.stringify(sanitized)}`);
  }
  return Option.none();
};

const sanitizeVisibleText = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = Schema.decodeOption(Schema.fromJsonString(Schema.Json))(trimmed);
    if (Option.isSome(parsed)) {
      const sanitized = sanitizeJsonValue(parsed.value, 0);
      return sanitized === undefined ? "" : JSON.stringify(sanitized);
    }
  }
  const embedded = sanitizeEmbeddedJson(trimmed, 0);
  return redactSecrets(Option.getOrElse(embedded, () => trimmed));
};

const redactSecrets = (value: string): string =>
  value
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1")
    .replace(secretValue, "[redacted]")
    .trim();
