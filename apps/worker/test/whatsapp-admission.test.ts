import { describe, expect, it } from "@effect/vitest";
import { DateTime, Effect, Redacted, Schema } from "effect";

import { AgentId, ChannelBindingId, ChannelIdentity, ProviderMessageId } from "../src/domain";
import {
  type AgentAcceptanceInput,
  InboundWhatsAppMessage,
  make,
  type Interface,
  type WhatsAppAdmissionUnavailable,
  WhatsAppMessageText,
} from "../src/services/whatsapp-admission";
import { AuthorizationContext } from "../src/services/authorization";
import { AcceptanceReceipt } from "../src/services/whatsapp-acceptance-receipt";
import type { WhatsAppOnboardingCommand } from "../src/services/whatsapp-onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and onboarding test values use the standard _tag discriminator. */

class SimulatedAgentFailure extends Schema.TaggedError<SimulatedAgentFailure>()(
  "SimulatedAgentFailure",
  { message: Schema.String },
) {}

describe("WhatsApp inbound admission", () => {
  it.effect("records accepted-message use only after the Acceptance Receipt is recoverable", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const receipt = acceptanceReceipt();
      const service = admission({
        accept: () => Effect.sync(() => (calls.push("accept"), receipt)),
        record: () => Effect.sync(() => (calls.push("record"), undefined)),
      });

      const outcome = yield* service.admit(textMessage());

      expect(outcome).toEqual({ _tag: "MessageAccepted", receipt });
      expect(calls).toEqual(["accept", "record"]);
    }),
  );

  it.effect(
    "recovers one receipt and one consumption after Agent failure following Think acceptance",
    () =>
      Effect.gen(function* () {
        const receipt = acceptanceReceipt();
        const acceptedInputs: Array<AgentAcceptanceInput> = [];
        let attempt = 0;
        let recorded = 0;
        const service = admission({
          accept: (_agentId, input) =>
            Effect.suspend(() => {
              acceptedInputs.push(input);
              attempt += 1;
              return attempt === 1
                ? Effect.fail(
                    new SimulatedAgentFailure({ message: "response lost after Think accepted" }),
                  )
                : Effect.succeed(receipt);
            }),
          record: () => Effect.sync(() => void (recorded += 1)),
        });

        yield* Effect.flip(service.admit(textMessage()));
        const recovered = yield* service.admit(textMessage());

        expect(recovered).toEqual({ _tag: "MessageAccepted", receipt });
        expect(acceptedInputs).toHaveLength(2);
        expect(acceptedInputs[1]).toEqual(acceptedInputs[0]);
        expect(recorded).toBe(1);
      }),
  );

  it.effect("routes an unknown sender into onboarding without creating a UserMessage", () =>
    Effect.gen(function* () {
      const commands: Array<WhatsAppOnboardingCommand> = [];
      const service = admission({
        route: () => Effect.succeed({ _tag: "Unbound" as const }),
        onboard: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { _tag: "InvitationIssued" as const };
          }),
      });

      const outcome = yield* service.admit(textMessage());

      expect(outcome).toEqual({ _tag: "OnboardingAccepted" });
      expect(commands).toEqual([
        {
          _tag: "UnknownSenderMessage",
          channelIdentity: "14165550123",
          eventId: "123456789:wamid.1",
          invitedPhoneNumber: "14165550123",
          locale: "en",
          message: "Please help",
        },
      ]);
    }),
  );

  it.effect("routes a valid enrollment control message without creating a UserMessage", () =>
    Effect.gen(function* () {
      const commands: Array<WhatsAppOnboardingCommand> = [];
      let enrollmentToken: string | null = null;
      const service = admission({
        route: () => Effect.succeed({ _tag: "Unbound" as const }),
        onboard: (command) =>
          Effect.sync(() => {
            commands.push(command);
            enrollmentToken =
              command._tag === "EnrollmentControlMessage" ? Redacted.value(command.token) : null;
            return { _tag: "EnrollmentCompleted" as const };
          }),
      });
      const token = "a".repeat(64);

      const outcome = yield* service.admit({
        ...textMessage(),
        message: WhatsAppMessageText.make(`OSFO ENROLL ${token}`),
      });

      expect(outcome).toEqual({ _tag: "OnboardingAccepted" });
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        _tag: "EnrollmentControlMessage",
        channelIdentity: "14165550123",
        eventId: "123456789:wamid.1",
      });
      expect(enrollmentToken).toBe(token);
    }),
  );
});

const admission = (overrides: {
  readonly accept?: Interface<TestFailure>["agent"]["accept"];
  readonly onboard?: Interface<TestFailure>["onboarding"]["handle"];
  readonly record?: Interface<TestFailure>["allowances"]["recordAcceptedMessage"];
  readonly route?: Interface<TestFailure>["persistence"]["route"];
}) =>
  make<TestFailure>({
    agent: { accept: overrides.accept ?? (() => Effect.succeed(acceptanceReceipt())) },
    allowances: {
      recordAcceptedMessage: overrides.record ?? (() => Effect.void),
    },
    onboarding: {
      handle: overrides.onboard ?? (() => Effect.succeed({ _tag: "InvitationIssued" as const })),
    },
    persistence: {
      route:
        overrides.route ??
        (() =>
          Effect.succeed({
            _tag: "Bound" as const,
            agentId: AgentId.make("agent-1"),
            authorization: authorization(),
            channelBindingId: ChannelBindingId.make("binding-1"),
          })),
    },
  });

type TestFailure = SimulatedAgentFailure | WhatsAppAdmissionUnavailable;

const textMessage = (): InboundWhatsAppMessage =>
  Schema.decodeSync(InboundWhatsAppMessage)({
    _tag: "TextMessage",
    channelIdentity: ChannelIdentity.make("14165550123"),
    message: "Please help",
    phoneNumberId: "123456789",
    providerMessageId: ProviderMessageId.make("wamid.1"),
  });

const acceptanceReceipt = (): AcceptanceReceipt =>
  Schema.decodeSync(AcceptanceReceipt)({
    _tag: "AcceptanceReceipt",
    acceptedAt: "2026-08-16T12:00:00Z",
    allowancePeriodId: "period-1",
    channelBindingId: "binding-1",
    providerMessageId: "wamid.1",
    receiptId: "receipt-fixed",
    sessionId: "session-1",
    thinkSubmissionId: "submission-fixed",
    userMessageId: "message-fixed",
  });

const authorization = () =>
  Schema.decodeSync(AuthorizationContext)({
    allowance: {
      _tag: "Metered" as const,
      allowancePeriodId: "period-1",
      endsAt: date("2026-09-01T00:00:00.000Z"),
      plan: "free" as const,
      planPolicyVersion: "launch-v1",
      startsAt: date("2026-08-01T00:00:00.000Z"),
      usage: [],
    },
    approval: null,
    authority: {
      _tag: "ChannelBinding" as const,
      channelBindingId: "binding-1",
      userId: "user-1",
    },
    deletionAccess: { _tag: "DeletionAccessAvailable" as const },
    gmailConnection: null,
    liveFacts: {
      activeGmSummonsInSession: 0n,
      activeReminders: 0n,
      concurrentWorkflows: 0n,
      retainedFileBytes: 0n,
    },
    now: date("2026-08-16T12:00:00.000Z"),
    originatingAuthority: { _tag: "ChannelBinding" as const, channelBindingId: "binding-1" },
    requestVendorUsdMicros: 0n,
    resourceOwnerUserId: "user-1",
    subscription: { plan: "free" as const, planPolicyVersion: "launch-v1" },
    user: { _tag: "ActiveUser" as const, userId: "user-1" },
  });

const date = (iso: string) => DateTime.toDateUtc(DateTime.makeUnsafe(iso));
