import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";

import { AgentId, ChannelBindingId, ChannelIdentity, ProviderMessageId } from "../src/domain";
import {
  type AgentAcceptanceInput,
  InboundWhatsAppMessage,
  make,
  type Interface,
  type WhatsAppAdmissionUnavailable,
  WhatsAppMessageText,
} from "../src/services/whatsapp-admission";
import { AcceptanceReceipt } from "../src/services/whatsapp-acceptance-receipt";
import type { WhatsAppOnboardingCommand } from "../src/services/whatsapp-onboarding";

/* oxlint-disable eslint/no-underscore-dangle -- Effect and onboarding test values use the standard _tag discriminator. */

class SimulatedAgentFailure extends Schema.TaggedError<SimulatedAgentFailure>()(
  "SimulatedAgentFailure",
  { message: Schema.String },
) {}

describe("WhatsApp inbound admission", () => {
  it.effect("recovers an existing receipt when current allowance admission is unavailable", () =>
    Effect.gen(function* () {
      const receipt = acceptanceReceipt();
      let recorded = 0;
      const service = admission({
        admit: () =>
          Effect.fail(
            new SimulatedAgentFailure({ message: "No current allowance period is available" }),
          ),
        record: () => Effect.sync(() => void (recorded += 1)),
        recover: () => Effect.succeed(receipt),
      });

      const outcome = yield* service.admit(textMessage());

      expect(outcome).toEqual({ _tag: "MessageAccepted", receipt });
      expect(recorded).toBe(1);
    }),
  );

  it.effect("records accepted-message use only after the Acceptance Receipt is recoverable", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const receipt = acceptanceReceipt();
      const service = admission({
        accept: () => Effect.sync(() => (calls.push("accept"), receipt)),
        admit: () => Effect.sync(() => void calls.push("admit")),
        record: () => Effect.sync(() => (calls.push("record"), undefined)),
        recover: () => Effect.sync(() => (calls.push("recover"), null)),
      });

      const outcome = yield* service.admit(textMessage());

      expect(outcome).toEqual({ _tag: "MessageAccepted", receipt });
      expect(calls).toEqual(["recover", "admit", "accept", "record"]);
    }),
  );

  it.effect(
    "recovers one receipt and one consumption after Agent failure following Think acceptance",
    () =>
      Effect.gen(function* () {
        const receipt = acceptanceReceipt();
        const acceptedInputs: Array<AgentAcceptanceInput> = [];
        let recoverable: AcceptanceReceipt | null = null;
        let recorded = 0;
        const service = admission({
          accept: (_agentId, input) =>
            Effect.suspend(() => {
              acceptedInputs.push(input);
              recoverable = receipt;
              return Effect.fail(
                new SimulatedAgentFailure({ message: "response lost after Think accepted" }),
              );
            }),
          record: () => Effect.sync(() => void (recorded += 1)),
          recover: () => Effect.succeed(recoverable),
        });

        yield* Effect.flip(service.admit(textMessage()));
        const recovered = yield* service.admit(textMessage());

        expect(recovered).toEqual({ _tag: "MessageAccepted", receipt });
        expect(acceptedInputs).toHaveLength(1);
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
  readonly admit?: Interface<TestFailure>["persistence"]["admit"];
  readonly onboard?: Interface<TestFailure>["onboarding"]["handle"];
  readonly record?: Interface<TestFailure>["allowances"]["recordAcceptedMessage"];
  readonly recover?: Interface<TestFailure>["agent"]["recover"];
  readonly route?: Interface<TestFailure>["persistence"]["route"];
}) =>
  make<TestFailure>({
    agent: {
      accept: overrides.accept ?? (() => Effect.succeed(acceptanceReceipt())),
      recover: overrides.recover ?? (() => Effect.succeed(null)),
    },
    allowances: {
      recordAcceptedMessage: overrides.record ?? (() => Effect.void),
    },
    onboarding: {
      handle: overrides.onboard ?? (() => Effect.succeed({ _tag: "InvitationIssued" as const })),
    },
    persistence: {
      admit: overrides.admit ?? (() => Effect.void),
      route:
        overrides.route ??
        (() =>
          Effect.succeed({
            _tag: "Bound" as const,
            agentId: AgentId.make("agent-1"),
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
