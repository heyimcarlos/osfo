import { Context, Effect, Layer, Schema } from "effect";

import { ChannelIdentity, ThinkSubmissionId } from "../domain";
import type { AgentId, AllowancePeriodId, ChannelBindingId, UserId } from "../domain";
import type { AuthorizationContext } from "./authorization";
import type { SubmitManagedConversationInput } from "./managed-conversation";
import { ChannelProvider } from "./onboarding";

/** Provider-authenticated message facts accepted by transport-neutral admission. */
export const MessageAdmissionInput = Schema.Struct({
  channelIdentity: ChannelIdentity,
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64_000)),
  provider: ChannelProvider,
});

/** Provider-authenticated message facts accepted by transport-neutral admission. */
export type MessageAdmissionInput = typeof MessageAdmissionInput.Type;

/** Current bound route and authority facts read before Think admission. */
export interface BoundChannel {
  readonly agentId: AgentId;
  readonly allowance: Extract<AuthorizationContext["allowance"], { readonly _tag: "Metered" }>;
  readonly channelBindingId: ChannelBindingId;
  readonly now: Date;
  readonly userId: UserId;
}

/** Expected failure while admitting or recording one provider message. */
export class MessagingAdmissionUnavailable extends Schema.TaggedError<MessagingAdmissionUnavailable>()(
  "MessagingAdmissionUnavailable",
  { cause: Schema.Defect(), message: Schema.String, operation: Schema.String },
) {}

/** Persistence needed to resolve a binding and record accepted-message use. */
export interface PersistencePort {
  readonly begin: (
    input: MessageAdmissionInput,
  ) => Effect.Effect<
    BoundChannel | { readonly _tag: "Duplicate" | "InProgress" | "Unbound" },
    MessagingAdmissionUnavailable
  >;
  readonly complete: (
    input: MessageAdmissionInput,
    now: Date,
  ) => Effect.Effect<void, MessagingAdmissionUnavailable>;
  readonly recordAccepted: (
    allowancePeriodId: AllowancePeriodId,
    submissionId: ThinkSubmissionId,
  ) => Effect.Effect<void, MessagingAdmissionUnavailable>;
}

/** Control-plane admission persistence supplied by PostgreSQL. */
export class Persistence extends Context.Service<Persistence, PersistencePort>()(
  "@osfo/MessagingAdmission/Persistence",
) {}

/** Stable named-Agent submission boundary. */
export interface AgentSubmissionPort {
  readonly submit: (
    agentId: AgentId,
    input: typeof SubmitManagedConversationInput.Type,
  ) => Effect.Effect<{ readonly accepted: boolean }, MessagingAdmissionUnavailable>;
}

/** Named-Agent submission supplied by Cloudflare Durable Object RPC. */
export class AgentSubmission extends Context.Service<AgentSubmission, AgentSubmissionPort>()(
  "@osfo/MessagingAdmission/AgentSubmission",
) {}

/** Transport-neutral admission result. */
export type AdmissionResult =
  | { readonly _tag: "Accepted" }
  | { readonly _tag: "Duplicate" }
  | { readonly _tag: "InProgress" }
  | { readonly _tag: "Unbound" };

/** Transport-neutral message-admission interface. */
export interface Interface {
  readonly accept: (
    input: MessageAdmissionInput,
  ) => Effect.Effect<AdmissionResult, MessagingAdmissionUnavailable>;
}

/** Provider-neutral message admission for a stable Think Session. */
export class Service extends Context.Service<Service, Interface>()("@osfo/MessagingAdmission") {}

/** Construct message admission from current binding facts and named-Agent RPC. */
export const make = Effect.gen(function* () {
  const persistence = yield* Persistence;
  const submission = yield* AgentSubmission;

  const accept = Effect.fn("MessagingAdmission.accept")(function* (input: MessageAdmissionInput) {
    const begun = yield* persistence.begin(input);
    if ("_tag" in begun) return begun;
    const bound = begun;
    const submissionId = yield* Schema.decodeEffect(ThinkSubmissionId)(input.eventId).pipe(
      Effect.mapError(
        (cause) =>
          new MessagingAdmissionUnavailable({
            cause,
            message: "The provider event identity cannot identify a Think Submission",
            operation: "makeSubmissionIdentity",
          }),
      ),
    );
    const submitted = yield* submission.submit(bound.agentId, {
      authorization: authorizationForCurrentLaunchFacts(bound),
      idempotencyKey: input.eventId,
      message: input.message,
      submissionId,
    });
    yield* persistence.recordAccepted(bound.allowance.allowancePeriodId, submissionId);
    yield* persistence.complete(input, bound.now);
    return submitted.accepted ? ({ _tag: "Accepted" } as const) : ({ _tag: "Duplicate" } as const);
  });

  return Service.of({ accept });
});

/** Message-admission Layer that preserves concrete persistence and RPC requirements. */
export const layerWithoutDependencies = Layer.effect(Service, make);

/**
 * Build launch authorization while no suspension, deletion, Gmail, or live-resource stores exist.
 * Their current absence is the product invariant: active, available, disconnected, and zero use.
 */
const authorizationForCurrentLaunchFacts = (bound: BoundChannel): AuthorizationContext => ({
  allowance: bound.allowance,
  approval: null,
  authority: {
    _tag: "ChannelBinding",
    channelBindingId: bound.channelBindingId,
    userId: bound.userId,
  },
  deletionAccess: { _tag: "DeletionAccessAvailable" },
  gmailConnection: null,
  liveFacts: {
    activeGmSummonsInSession: 0n,
    activeReminders: 0n,
    concurrentWorkflows: 0n,
    retainedFileBytes: 0n,
  },
  now: bound.now,
  originatingAuthority: {
    _tag: "ChannelBinding",
    channelBindingId: bound.channelBindingId,
  },
  requestVendorUsdMicros: 0n,
  resourceOwnerUserId: bound.userId,
  subscription: {
    plan: bound.allowance.plan,
    planPolicyVersion: bound.allowance.planPolicyVersion,
  },
  user: { _tag: "ActiveUser", userId: bound.userId },
});
