import { currentCapabilityCatalog } from "../../domain/capability-catalog";
import { currentLaunchPolicy } from "../../domain/plan-policy";
import type { AuthorizationContext } from "../../services/authorization";

/** Resolve the governed active Reminder limit without changing the pinned policy. */
export const activeReminderLimit = (subscription: AuthorizationContext["subscription"]): number =>
  subscription.planPolicyVersion === "shared-usage-v1"
    ? currentCapabilityCatalog.planResourceLimits[subscription.plan].activeReminders
    : Number(currentLaunchPolicy.plans[subscription.plan].liveLimits.activeReminders);
