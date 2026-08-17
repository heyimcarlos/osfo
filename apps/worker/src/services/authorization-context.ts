import type { Plan, PlanPolicyVersion, UserId } from "../domain";
import { AuthorizationContext } from "./authorization";

/** Current facts shared by authenticated HTTP and durable protected-effect entry points. */
export interface CurrentAuthorizationFacts {
  readonly allowance: AuthorizationContext["allowance"];
  readonly authority: AuthorizationContext["authority"];
  readonly now: Date;
  readonly originatingAuthority: AuthorizationContext["originatingAuthority"];
  readonly plan: Plan;
  readonly planPolicyVersion: PlanPolicyVersion;
  readonly userId: UserId;
}

/** Project current trusted facts into the one Authorization context shape. */
export const project = (facts: CurrentAuthorizationFacts): AuthorizationContext =>
  AuthorizationContext.make({
    allowance: facts.allowance,
    approval: null,
    authority: facts.authority,
    deletionAccess: { _tag: "DeletionAccessAvailable" },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: facts.now,
    originatingAuthority: facts.originatingAuthority,
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: facts.userId,
    subscription: { plan: facts.plan, planPolicyVersion: facts.planPolicyVersion },
    user: { _tag: "ActiveUser", userId: facts.userId },
  });
