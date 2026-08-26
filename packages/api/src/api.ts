import { HttpApi, OpenApi } from "effect/unstable/httpapi";

import { HealthGroup } from "./groups/health";
import { BillingGroup } from "./groups/billing";
import { ChannelLinksGroup } from "./groups/channel-links";
import { RegistrationGroup } from "./groups/registration";
import { AccountGroup } from "./groups/account";

/** Shared HTTP contract implemented by the Worker and consumed by clients. */
export const Api = HttpApi.make("osfo")
  .add(AccountGroup)
  .add(BillingGroup)
  .add(ChannelLinksGroup)
  .add(HealthGroup)
  .add(RegistrationGroup)
  .annotateMerge(
    OpenApi.annotations({
      description: "Osfo control-plane HTTP API.",
      title: "Osfo API",
      version: "0.1.0",
    }),
  );

export { HealthGroup, HealthResponse } from "./groups/health";
export {
  AccountDeletionActionPresentation,
  AccountDeletionAuth,
  AccountDeletionCaller,
  type AccountDeletionCallerValue,
  AccountDeletionRequest,
  AccountDeletionResponse,
  AccountDeletionUnavailable,
  AccountGroup,
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
  Auth,
  AuthenticationUnavailable,
  CurrentUser,
  Unauthorized,
  type CurrentUserValue,
} from "./middleware/auth";
