/* oxlint-disable effecttsgo/global-date -- Shared fixed accounting evidence for isolated tests. */
import type { UIMessage } from "ai";
import { Effect, Schema } from "effect";
import { ManagedTurnMetadata } from "../../src/domain/managed-conversation";
import { managedConversationModelPrice } from "../../src/domain/usage";
import { initialManagedSearchEvidence } from "../../src/domain/web-search-evidence";
import { managedSearchAdmissionUsdMicros } from "../../src/domain/web-search-price";
import { PaidSearchAttempt } from "../../src/services/web";
import {
  conversationUsageEvent,
  retainConversationModelStep,
} from "../../src/agents/osfo/conversation-usage";

export const metadata = Schema.decodeSync(ManagedTurnMetadata)({
  _tag: "OsfoManagedTurn",
  allowancePeriodId: "period-original",
  authorityIdentity: { _tag: "AuthSession", authSessionId: "auth-1", userId: "user-1" },
  conversationResourcePriceVersion: managedConversationModelPrice.resourcePriceVersion,
  conservativeVendorUsdMicros: 50_000,
  coreMemoryAuthorization: {
    authority: {
      _tag: "AuthSession",
      authSessionId: "auth-1",
      expiresAt: "2026-09-06T13:00:00Z",
      userId: "user-1",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    now: "2026-09-06T12:00:00Z",
    originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-1" },
    resourceOwnerUserId: "user-1",
    subscription: { plan: "free", planPolicyVersion: "shared-usage-v1" },
    user: { _tag: "ActiveUser", userId: "user-1" },
  },
  maxInputTokens: 32_000,
  maxOutputTokens: 4_096,
  maxRetries: 0,
  maxSteps: 5,
  originatingAuthority: { _tag: "AuthSession", authSessionId: "auth-1" },
  plan: "free",
  planPolicyVersion: "shared-usage-v1",
  route: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  routeId: "route-1",
  sessionId: "session-1",
  submissionId: "submission-1",
  targetInputTokens: 18_000,
});
export const userMessage: UIMessage = {
  id: "user-message",
  role: "user",
  parts: [{ type: "text", text: "Find the official page" }],
  metadata: { turnMetadata: metadata },
};
export const step = {
  cachedInputTokens: 100,
  inputTokens: 1_000,
  outputTokens: 100,
  stepNumber: 1,
};
export const occurredAt = new Date("2026-09-06T12:00:00Z");
export const paid = Schema.decodeSync(PaidSearchAttempt)({
  admission: {
    allowancePeriodId: metadata.allowancePeriodId,
    authorizedAt: occurredAt.toISOString(),
    capabilityCatalogVersion: metadata.capabilityCatalogVersion,
    originatingAuthority: metadata.originatingAuthority,
    planPolicyVersion: metadata.planPolicyVersion,
  },
  admittedVendorUsdMicros: managedSearchAdmissionUsdMicros.toString(),
  evidence: { ...initialManagedSearchEvidence("search-1"), ratedCostUsdMicros: 13_562 },
  outcome: "succeeded",
});
export const completed = Effect.gen(function* () {
  const message = yield* retainConversationModelStep([userMessage], metadata.submissionId, step);
  return yield* conversationUsageEvent(
    [message],
    metadata,
    [{ operationId: "search-1", attempt: paid }],
    occurredAt,
    1,
  );
});
