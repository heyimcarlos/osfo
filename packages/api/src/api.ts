import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { HealthGroup } from "./groups/health";
import { BillingGroup } from "./groups/billing";
import { ChannelLinksGroup } from "./groups/channel-links";
import { RegistrationGroup } from "./groups/registration";
import { ResearchReportsGroup } from "./groups/research-reports";
import { DocumentBuildsGroup } from "./groups/document-builds";
import { FilesGroup } from "./groups/files";
import { AccountGroup } from "./groups/account";
import { SkillsGroup } from "./groups/skills";
import { IntegrationsGroup } from "./groups/integrations";
import { ScheduledEmailsGroup } from "./groups/scheduled-emails";

/** Shared HTTP contract implemented by the Worker and consumed by clients. */
export const Api = HttpApi.make("osfo")
  .add(AccountGroup)
  .add(BillingGroup)
  .add(ChannelLinksGroup)
  .add(DocumentBuildsGroup)
  .add(FilesGroup)
  .add(HealthGroup)
  .add(IntegrationsGroup)
  .add(RegistrationGroup)
  .add(ResearchReportsGroup)
  .add(ScheduledEmailsGroup)
  .add(SkillsGroup)
  .annotateMerge(
    OpenApi.annotations({
      description: "Osfo control-plane HTTP API.",
      title: "Osfo API",
      version: "0.1.0",
    }),
  );

export { HealthGroup, HealthResponse } from "./groups/health";
export {
  BrowserFileId,
  BrowserFileName,
  BrowserFileUploadId,
  BrowserTextFileBytes,
  FileUploadConflict,
  FileUploadDenied,
  FileUploadLimitExceeded,
  FileUploadQuery,
  FileUploadRejected,
  FileUploadResponse,
  FileUploadUnavailable,
  maximumBrowserTextUploadBytes,
  FileStatusResponse,
  FilesGroup,
} from "./groups/files";
export {
  DocumentBuildNotifications,
  DocumentBuildNotificationSummary,
  DocumentBuildNotificationsUnavailable,
  DocumentBuildsGroup,
} from "./groups/document-builds";
export {
  IntegrationConnectionChanged,
  IntegrationConnectionSummary,
  IntegrationConnectRedirect,
  IntegrationToolkit,
  IntegrationsGroup,
  IntegrationsUnavailable,
} from "./groups/integrations";
export {
  ScheduledEmailApproval,
  ScheduledEmailApprovalDecision,
  ScheduledEmailApprovalDecisionAccepted,
  ScheduledEmailApprovals,
  ScheduledEmailNotifications,
  ScheduledEmailNotificationSummary,
  ScheduledEmailsGroup,
  ScheduledEmailsUnavailable,
} from "./groups/scheduled-emails";
export {
  AccountDeletionAction,
  AccountDeletionActionPresentation,
  AccountDeletionActionPresentationV1,
  AccountDeletionActionPresentationV2,
  AccountDeletionAuth,
  AccountDeletionCaller,
  type AccountDeletionCallerValue,
  AccountDeletionRequest,
  AccountDeletionReplayToken,
  AccountDeletionPresentationVersion,
  AccountDeletionResponse,
  AccountDeletionUnavailable,
  AccountGroup,
  accountDeletionPresentationDefinitions,
} from "./groups/account";
export {
  ChannelLinkAcceptanceResponse,
  ChannelLinkConflict,
  ChannelLinkInviteResponse,
  ChannelLinkInviteToken,
  ChannelLinkInviteUnavailable,
  ChannelLinkRegistrationRequired,
  ChannelLinksGroup,
  ChannelLinksUnavailable,
} from "./groups/channel-links";
export {
  BillingGroup,
  BillingForbidden,
  BillingReconciliation,
  BillingReconciliationRequest,
  BillingRedirect,
  BillingSummary,
  BillingUnavailable,
} from "./groups/billing";
export {
  AgentId,
  HelpArea,
  RegistrationLocale,
  RegistrationPhoneVerificationRequired,
  RegistrationProfile,
  RegistrationGroup,
  RegistrationResponse,
  RegistrationUnavailable,
  UserId,
} from "./groups/registration";
export {
  ResearchReportNotifications,
  ResearchReportNotificationSummary,
  ResearchReportNotificationsUnavailable,
  ResearchReportsGroup,
} from "./groups/research-reports";
export {
  Auth,
  AuthenticationUnavailable,
  CurrentUser,
  Unauthorized,
  type CurrentUserValue,
} from "./middleware/auth";
export {
  SkillAvailability,
  SkillChangeRequest,
  SkillChangeResponse,
  SkillConflict,
  SkillDeletionPresentation,
  SkillDeletionRequest,
  SkillDeletionResponse,
  SkillNotFound,
  SkillSummary,
  SkillsGroup,
  SkillsSummary,
  SkillsUnavailable,
  skillDeletionConfirmation,
  skillDeletionPresentationVersion,
} from "./groups/skills";
