import { Option, Schema } from "effect";

import { AllowancePeriodId, AssistantMessageId, SessionId, UserId } from "../../domain";
import { ManagedTurnMetadata } from "../../domain/managed-conversation";
import { MemoryProvider } from "../../services/memory-provider";
import { CommittedTurnTerminal, readCommittedTurnTerminal } from "./committed-turn-terminal";

const MessageMetadata = Schema.Struct({
  osfoCommittedTurn: Schema.optional(CommittedTurnTerminal),
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
const decodeJsonString = Schema.decodeOption(Schema.fromJsonString(Schema.Json));

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

/** Exact immutable conversation snapshot ending at one committed Think turn. */
export const ConversationSnapshotProjection = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  conversation: MemoryProvider.ConversationSnapshot,
  lastMessageId: AssistantMessageId,
  sessionId: SessionId,
  userId: UserId,
});

/** Exact immutable conversation snapshot ending at one committed Think turn. */
export type ConversationSnapshotProjection = typeof ConversationSnapshotProjection.Type;

interface ProjectableMessage {
  readonly id: string;
  readonly metadata?: unknown;
  readonly parts: ReadonlyArray<{ readonly type: string }>;
  readonly role: string;
}

export interface TerminalMarkedCommittedTurn {
  readonly assistantMessageId: AssistantMessageId;
  readonly projection: ConversationSnapshotProjection | undefined;
  readonly terminal: CommittedTurnTerminal;
}

/** Recover only persisted assistant boundaries whose terminal status is unambiguous. */
export const projectTerminalMarkedCommittedTurns = (
  history: ReadonlyArray<ProjectableMessage>,
  sessionId: SessionId,
): ReadonlyArray<TerminalMarkedCommittedTurn> =>
  history.flatMap((message) => {
    if (message.role !== "assistant") return [];
    const terminal = readCommittedTurnTerminal(message.metadata);
    const assistantMessageId = Schema.decodeOption(AssistantMessageId)(message.id);
    if (Option.isNone(terminal) || Option.isNone(assistantMessageId)) return [];
    return [
      {
        assistantMessageId: assistantMessageId.value,
        projection:
          terminal.value.status === "completed"
            ? Option.getOrUndefined(
                projectCommittedConversationSnapshot(history, assistantMessageId.value, sessionId),
              )
            : undefined,
        terminal: terminal.value,
      },
    ];
  });

/**
 * Capture the human-visible conversation ending at one committed assistant message.
 * Unknown and in-progress UI parts stay out of provider memory by default.
 */
export const projectCommittedConversationSnapshot = (
  history: ReadonlyArray<ProjectableMessage>,
  assistantMessageId: AssistantMessageId,
  sessionId: SessionId,
): Option.Option<ConversationSnapshotProjection> => {
  const assistantIndex = history.findIndex(({ id }) => id === assistantMessageId);
  if (assistantIndex < 0 || history[assistantIndex]?.role !== "assistant") return Option.none();

  let previousAssistantIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "assistant") {
      previousAssistantIndex = index;
      break;
    }
  }
  const currentTurnStart = previousAssistantIndex + 1;
  const conversation = history.slice(0, assistantIndex + 1);
  const attribution = findCommittedTurnAttribution(
    history,
    currentTurnStart,
    assistantIndex,
    sessionId,
  );
  if (Option.isNone(attribution)) return Option.none();

  const messages = projectConversationMessages(conversation);
  const currentTurn = history.slice(currentTurnStart, assistantIndex + 1);
  const currentTurnHasUser = currentTurn.some(({ role }) => role === "user");
  const previousAssistant = history[previousAssistantIndex];
  const usageHistoryStart =
    !currentTurnHasUser ||
    (previousAssistant !== undefined && hasHumanReadableToolOutcome(previousAssistant))
      ? Math.max(previousAssistantIndex, 0)
      : currentTurnStart;
  const usageStartIndex = projectConversationMessages(history.slice(0, usageHistoryStart)).length;
  const [firstProjectedMessage, ...remainingProjectedMessages] = messages;
  if (firstProjectedMessage === undefined || usageStartIndex >= messages.length)
    return Option.none();
  const snapshot = MemoryProvider.ConversationSnapshot.make({
    messages: [firstProjectedMessage, ...remainingProjectedMessages],
    usageStartIndex,
  });

  return Option.some(
    ConversationSnapshotProjection.make({
      allowancePeriodId: attribution.value.allowancePeriodId,
      conversation: snapshot,
      lastMessageId: assistantMessageId,
      sessionId,
      userId: attribution.value.userId,
    }),
  );
};

const findCommittedTurnAttribution = (
  history: ReadonlyArray<ProjectableMessage>,
  currentTurnStart: number,
  assistantIndex: number,
  sessionId: SessionId,
): Option.Option<{
  readonly allowancePeriodId: AllowancePeriodId;
  readonly userId: UserId;
}> => {
  for (let index = assistantIndex; index >= currentTurnStart; index -= 1) {
    const message = history[index];
    if (message === undefined) continue;
    const envelope = Schema.decodeUnknownOption(MessageMetadata)(message.metadata);
    if (Option.isNone(envelope)) continue;
    const terminal = envelope.value.osfoCommittedTurn?.attribution;
    if (terminal?.sessionId === sessionId) {
      if (
        terminal.executionMode === "exhaustedConversation" ||
        terminal.executionMode === "companyContinuity"
      ) {
        return Option.none();
      }
      return Option.some({
        allowancePeriodId: terminal.allowancePeriodId,
        userId: terminal.userId,
      });
    }
    const turn = envelope.value.turnMetadata;
    if (message.role === "user" && turn?.sessionId === sessionId) {
      if (
        turn.executionMode === "exhaustedConversation" ||
        turn.executionMode === "companyContinuity"
      ) {
        return Option.none();
      }
      return Option.some({
        allowancePeriodId: turn.allowancePeriodId,
        userId: turn.authorityIdentity.userId,
      });
    }
  }
  return Option.none();
};

const projectConversationMessages = (
  messages: ReadonlyArray<ProjectableMessage>,
): Array<MemoryProvider.ConversationMessage> =>
  messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    if (
      message.role === "assistant" &&
      Option.exists(
        readCommittedTurnTerminal(message.metadata),
        ({ status }) => status === "aborted" || status === "error",
      )
    )
      return [];
    const role = message.role === "user" ? ("user" as const) : ("assistant" as const);
    const content = message.parts
      .flatMap((part) => visiblePartText(part))
      .filter((text) => text.length > 0)
      .join("\n");
    return content.length === 0 ? [] : [{ content, role }];
  });

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
    const title = sanitizeOptionalLabel(sourceUrl.value.title);
    return [
      title === undefined || title.length === 0 ? safeUrl.value : `${title}: ${safeUrl.value}`,
    ];
  }

  const sourceDocument = Schema.decodeUnknownOption(SourceDocumentPart)(part);
  if (Option.isSome(sourceDocument)) {
    const title = sanitizeVisibleText(sourceDocument.value.title);
    const filename = sanitizeOptionalLabel(sourceDocument.value.filename);
    return [
      filename === undefined || filename.length === 0 ? title : `${title} (${filename})`,
    ].filter((value) => value.length > 0);
  }

  if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return [];
  const tool = Schema.decodeUnknownOption(ToolOutcomePart)(part);
  if (Option.isNone(tool)) return [];
  const outcome = humanReadableOutcome(tool.value.output);
  if (Option.isNone(outcome)) return [];
  const title = sanitizeOptionalLabel(tool.value.title);
  return [title === undefined || title.length === 0 ? outcome.value : `${title}: ${outcome.value}`];
};

const sanitizeOptionalLabel = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : sanitizeVisibleText(value);

const hasHumanReadableToolOutcome = (message: ProjectableMessage): boolean =>
  message.parts.some((part) => {
    if (part.type !== "dynamic-tool" && !part.type.startsWith("tool-")) return false;
    const tool = Schema.decodeUnknownOption(ToolOutcomePart)(part);
    return Option.isSome(tool) && Option.isSome(humanReadableOutcome(tool.value.output));
  });

const sanitizeSourceUrl = (value: string): Option.Option<string> => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return Option.none();
    if (isInfrastructureHostname(url.hostname)) return Option.none();
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return Option.some(redactSecrets(url.href));
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

const sanitizeJsonValue = (value: Schema.Json, depth: number): Schema.Json | undefined => {
  if (depth > 5) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    const fullJson = sanitizeFullJsonString(trimmed, depth + 1);
    if (fullJson.kind === "sanitized") return fullJson.value;
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
      .filter((item): item is Schema.Json => item !== undefined);
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
    const parsed = decodeJsonString(value.slice(start));
    if (Option.isNone(parsed)) continue;
    const sanitized = sanitizeJsonValue(parsed.value, depth + 1);
    if (sanitized === undefined) return Option.none();
    const prefix = redactSecrets(value.slice(0, start));
    return Option.some(`${prefix}${JSON.stringify(sanitized)}`);
  }
  return Option.none();
};

type FullJsonSanitization =
  | { readonly kind: "notJson" }
  | { readonly kind: "sanitized"; readonly value: Schema.Json | undefined };

const sanitizeFullJsonString = (value: string, depth: number): FullJsonSanitization => {
  if (!value.startsWith("{") && !value.startsWith("[")) return { kind: "notJson" };
  const parsed = decodeJsonString(value);
  return Option.match(parsed, {
    onNone: () => ({ kind: "notJson" }),
    onSome: (json) => ({ kind: "sanitized", value: sanitizeJsonValue(json, depth) }),
  });
};

const sanitizeVisibleText = (value: string): string => {
  const trimmed = value.trim();
  const fullJson = sanitizeFullJsonString(trimmed, 0);
  if (fullJson.kind === "sanitized") {
    return fullJson.value === undefined ? "" : JSON.stringify(fullJson.value);
  }
  const embedded = sanitizeEmbeddedJson(trimmed, 0);
  return redactSecrets(Option.getOrElse(embedded, () => trimmed));
};

const redactSecrets = (value: string): string =>
  value
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1")
    .replace(secretValue, "[redacted]")
    .trim();
