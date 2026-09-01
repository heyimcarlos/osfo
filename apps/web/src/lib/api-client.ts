import {
  Api,
  type AccountDeletionAction,
  type AccountDeletionRequest,
  type BillingReconciliationRequest,
  ChannelLinkInviteToken,
  type HelpArea,
  type GmailSendApprovalDecision,
  type IntegrationToolkit,
  type RegistrationLocale,
  type ScheduledEmailApprovalDecision,
  type SkillChangeRequest,
  type SkillDeletionPresentation,
  skillDeletionConfirmation,
} from "@osfo/api";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";

import { apiBaseURL } from "../config";

const httpClientLayer = FetchHttpClient.layer.pipe(
  Layer.provideMerge(
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: "include",
    }),
  ),
);
const apiClient = HttpApiClient.make(Api, { baseUrl: apiBaseURL }).pipe(
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- The browser API client owns its Fetch runtime.
  Effect.provide(httpClientLayer),
);

/** Inspect a Channel Link Invite without exposing its represented external address. */
export const inspectChannelLinkInvite = (token: string) =>
  Effect.gen(function* () {
    const parsedToken = yield* Schema.decodeEffect(ChannelLinkInviteToken)(token);
    const client = yield* apiClient;
    return yield* client.channelLinks.inspect({ params: { token: parsedToken } });
  });

/** Accept a Channel Link Invite for the server-authenticated User. */
export const acceptChannelLinkInvite = (token: string) =>
  Effect.gen(function* () {
    const parsedToken = yield* Schema.decodeEffect(ChannelLinkInviteToken)(token);
    const client = yield* apiClient;
    return yield* client.channelLinks.accept({ params: { token: parsedToken } });
  });

/** Inspect the authenticated User's active Channel Links without provider addresses. */
export const inspectChannelLinks = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.channelLinks.list();
});

/** Revoke one exact active Channel Link owned by the authenticated User. */
export const revokeChannelLink = (channelLinkId: string) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.channelLinks.revoke({ params: { channelLinkId } });
  });

/** Complete authenticated registration through the shared typed contract. */
export interface CompleteRegistrationPayload {
  readonly helpAreas: ReadonlyArray<HelpArea>;
  readonly locale: RegistrationLocale;
  readonly preferredName: string | null;
}

/** Complete authenticated registration through the shared typed API contract. */
export const completeRegistration = (payload: CompleteRegistrationPayload) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.registration.complete({ payload });
  });

/** Inspect the authenticated User's current safe billing state. */
export const inspectBilling = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.billing.inspect();
});

/** Inspect delivered safe Research Report follow-ups for the authenticated User. */
export const inspectResearchReportNotifications = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.researchReports.notifications();
});

/** Inspect delivered safe Document Build follow-ups for the authenticated User. */
export const inspectDocumentBuildNotifications = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.documentBuilds.notifications();
});

/** Upload one UTF-8 text source through the authenticated User's owning Agent. */
export const uploadTextFile = (bytes: Uint8Array, fileName: string, uploadId: string) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.files.uploadText({ payload: bytes, query: { fileName, uploadId } });
  });

/** Inspect one User-owned source while normalization is still in flight. */
export const inspectFileStatus = (fileId: string) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.files.status({ params: { fileId } });
  });

/** Inspect the authenticated User's safe Integration Connection state. */
export const inspectIntegrations = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.integrations.inspect();
});

/** Inspect exact immediate Gmail Approvals and settled outcomes for the authenticated User. */
export const inspectGmailSends = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.integrations.gmailSends();
});

/** Dispatch one exact immediate Gmail Approval decision through the owning Agent. */
export const decideGmailSendApproval = (payload: GmailSendApprovalDecision) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.integrations.decideGmailSend({ payload });
  });

/** Acquire a provider-hosted connect URL for one exact toolkit. */
export const connectIntegration = (toolkit: IntegrationToolkit) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.integrations.connect({ payload: { toolkit } });
  });

/** Revoke the one current connected account for an exact toolkit. */
export const disconnectIntegration = (toolkit: IntegrationToolkit) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.integrations.disconnect({ payload: { toolkit } });
  });

/** Inspect exact pending Scheduled Email Approvals for the authenticated User. */
export const inspectScheduledEmailApprovals = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.scheduledEmails.approvals();
});

/** Dispatch one exact Scheduled Email Approval decision through the owning Agent. */
export const decideScheduledEmailApproval = (payload: ScheduledEmailApprovalDecision) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.scheduledEmails.decideApproval({ payload });
  });

/** Inspect delivered privacy-safe Scheduled Email outcomes. */
export const inspectScheduledEmailNotifications = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.scheduledEmails.notifications();
});

/** Start or recover Stripe-hosted Adventurer Checkout. */
export const startBillingCheckout = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.billing.checkout({ payload: {} });
});

/** Open Stripe Customer Portal for ordinary billing changes. */
export const openBillingPortal = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.billing.portal({ payload: {} });
});

/** Reconcile current Stripe state after a hosted Checkout or Portal return. */
export const reconcileBilling = (payload: BillingReconciliationRequest) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    if (payload.reason === "checkoutReturn") {
      return yield* client.billing.reconcile({ payload });
    }
    return yield* client.billing.reconcile({ payload });
  });

/** Fetch the exact server-owned Action that can permanently delete this account. */
export const presentAccountDeletion = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.account.presentAccountDeletion();
});

/** Consume the caller's exact Approval and start permanent account deletion. */
export const requestAccountDeletion = (request: AccountDeletionRequest) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    if (request.presentationVersion === "account-deletion-v1") {
      return yield* client.account.deleteAccount({ payload: request });
    }
    return yield* client.account.deleteAccount({ payload: request });
  });

/** Build the only caller decision accepted for one exact server-owned presentation. */
export const accountDeletionRequestFor = (
  action: AccountDeletionAction,
): AccountDeletionRequest => ({
  approval: { decision: "approved", presentation: action.presentation },
  confirmation: action.presentation.confirmation,
  presentationVersion: action.presentationVersion,
  replayToken: action.replayToken,
});

/** Inspect the authenticated User's active and archived personal Skills. */
export const inspectSkills = Effect.gen(function* () {
  const client = yield* apiClient;
  return yield* client.skills.inspect();
});

/** Commit one non-destructive personal Skill lifecycle change. */
export const changeSkill = (payload: SkillChangeRequest) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    if (payload.change === "archive") return yield* client.skills.change({ payload });
    if (payload.change === "restore") return yield* client.skills.change({ payload });
    return yield* client.skills.change({ payload });
  });

/** Present the exact current Skill lineage before destructive Approval. */
export const presentSkillDeletion = (reference: string) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.skills.presentDeletion({ params: { reference } });
  });

/** Consume the User's exact Approval over one server-owned Skill presentation. */
export const deleteSkill = (presentation: SkillDeletionPresentation) =>
  Effect.gen(function* () {
    const client = yield* apiClient;
    return yield* client.skills.delete({
      params: { reference: presentation.reference },
      payload: {
        approval: { decision: "approved", presentation },
        confirmation: skillDeletionConfirmation,
      },
    });
  });
