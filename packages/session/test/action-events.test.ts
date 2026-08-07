import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ActionApprovalRequestedSchema,
  ActionReceiptRecordedSchema,
  InvalidThreadProjection,
  applyThreadEvent,
  makeActionApprovalRequested,
  makeActionReceiptRecorded,
  makeEmptyThreadSnapshot,
  makeUserMessageAppended,
  type ActionReceiptRecordedInput,
  type ThreadEvent,
  type ThreadSnapshot,
} from "../src/index.js";

const threadId = "6ef239bd-3f04-4c77-8976-1171e75ea0ab";
const agentRunId = "96ae49eb-b1ab-41cb-a468-b68893ec82c3";
const toolCallId = "tool_86290831-b9ca-414a-abf1-4055b5347133";
const approvalRequestId = "53146ff7-2205-44b0-8de4-685509112ac9";
const occurredAt = "2026-08-07T12:00:00.000Z";

const actionDefinition = { name: "sendDemoEmail", version: 1 } as const;
const presentation = {
  version: 1,
  title: "Send demo email",
  description: "Send one message to the controlled development inbox.",
  fields: [
    { label: "Destination", value: "Controlled development inbox" },
    { label: "Subject", value: "Osfo approval demo" },
  ],
} as const;
const successBoundary = {
  name: "mailpitMessageStored",
  version: 1,
  appliedMeans: "controlled sink stored one message with the Action stable Message-ID",
  doesNotProve: "delivery to a real recipient",
} as const;

const envelope = (event: ThreadEvent) => ({
  ...event,
  cursor: `cursor-${event.threadPosition}`,
});

const makeInput = () =>
  makeUserMessageAppended({
    eventId: "34dc8a78-a94d-4050-8c5b-e3bf21077c40",
    threadId,
    threadPosition: "1",
    userMessageId: "e9a31389-50d8-436a-b7be-7303b9fe42d0",
    agentRunId,
    occurredAt,
    content: "Send the demo message",
  });

const makeApprovalRequest = () =>
  makeActionApprovalRequested({
    eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
    threadId,
    threadPosition: "2",
    occurredAt,
    agentRunId,
    approvalRequestId,
    toolCallId,
    expiresAt: "2026-08-07T12:05:00.000Z",
    actionDefinition,
    presentation,
  });

const receiptInput = (
  outcome: ActionReceiptRecordedInput["outcome"],
): ActionReceiptRecordedInput => ({
  eventId: "a4a60d24-7d2e-4808-b6fc-f192ea7631de",
  threadId,
  threadPosition: "3",
  occurredAt,
  agentRunId,
  toolCallId,
  approval: { type: "approved", approvalRequestId },
  actionDefinition,
  presentation,
  successBoundary,
  outcome,
});

const fold = (snapshot: ThreadSnapshot, events: ReadonlyArray<ThreadEvent>) =>
  Effect.reduce(
    events,
    () => snapshot,
    (state, event) => applyThreadEvent(state, envelope(event)),
  );

describe("Action client projection", () => {
  it.effect("projects the exact approval presentation as active client state", () =>
    Effect.gen(function* () {
      const initial = yield* makeEmptyThreadSnapshot({
        threadId,
        throughCursor: "origin",
      });
      const input = yield* makeInput();
      const request = yield* makeApprovalRequest();
      const snapshot = yield* fold(initial, [input, request]);

      expect(request).toEqual({
        eventId: "f04d3470-bf0c-4b72-90de-0454ac404c9c",
        eventType: "ActionApprovalRequested",
        eventVersion: 1,
        threadId,
        threadPosition: "2",
        occurredAt,
        payload: {
          approvalRequestId,
          toolCallId,
          agentRunId,
          expiresAt: "2026-08-07T12:05:00.000Z",
          actionDefinition,
          presentation,
        },
      });
      expect(snapshot.activeState).toEqual([
        expect.objectContaining({
          type: "activeAgentRun",
          agentRunId,
          phase: { type: "pending" },
        }),
        {
          type: "activeActionApproval",
          approvalRequestId,
          toolCallId,
          agentRunId,
          introducedBy: {
            eventId: request.eventId,
            position: "2",
            occurredAt,
          },
          expiresAt: "2026-08-07T12:05:00.000Z",
          actionDefinition,
          presentation,
        },
      ]);
      expect(JSON.stringify(snapshot)).not.toContain("recipient@example.com");
      expect(JSON.stringify(snapshot)).not.toContain("smtp.example.com");
      expect(JSON.stringify(snapshot)).not.toContain("private message body");
    }),
  );

  it.effect.each(["applied", "notApplied", "unresolved"] as const)(
    "records an immutable %s receipt and removes the approval",
    (outcome) =>
      Effect.gen(function* () {
        const initial = yield* makeEmptyThreadSnapshot({
          threadId,
          throughCursor: "origin",
        });
        const input = yield* makeInput();
        const request = yield* makeApprovalRequest();
        const receipt = yield* makeActionReceiptRecorded(receiptInput(outcome));
        const snapshot = yield* fold(initial, [input, request, receipt]);

        expect(snapshot.timeline.at(-1)).toEqual({
          type: "actionReceipt",
          toolCallId,
          agentRunId,
          approval: { type: "approved", approvalRequestId },
          source: {
            firstEventId: receipt.eventId,
            firstPosition: "3",
            firstOccurredAt: occurredAt,
            lastEventId: receipt.eventId,
            lastPosition: "3",
            lastOccurredAt: occurredAt,
          },
          actionDefinition,
          presentation,
          successBoundary,
          outcome,
        });
        expect(snapshot.activeState).toEqual([
          expect.objectContaining({
            type: "activeAgentRun",
            agentRunId,
            phase: { type: "running" },
          }),
        ]);
      }),
  );

  it.effect("accepts a permitted receipt without an approval request", () =>
    Effect.gen(function* () {
      const initial = yield* makeEmptyThreadSnapshot({
        threadId,
        throughCursor: "origin",
      });
      const input = yield* makeInput();
      const permitted = yield* makeActionReceiptRecorded({
        ...receiptInput("applied"),
        threadPosition: "2",
        approval: { type: "notRequired" },
      });
      const snapshot = yield* fold(initial, [input, permitted]);

      expect(snapshot.timeline.at(-1)).toMatchObject({
        type: "actionReceipt",
        approval: { type: "notRequired" },
        outcome: "applied",
      });
    }),
  );

  it.effect("records policy denial without inventing an approval request", () =>
    Effect.gen(function* () {
      const initial = yield* makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" });
      const input = yield* makeInput();
      const denied = yield* makeActionReceiptRecorded({
        ...receiptInput("notApplied"),
        threadPosition: "2",
        approval: { type: "notAuthorized", reason: "operationGateDenied" },
      });
      const snapshot = yield* fold(initial, [input, denied]);

      expect(snapshot.timeline.at(-1)).toMatchObject({
        type: "actionReceipt",
        approval: { type: "notAuthorized", reason: "operationGateDenied" },
        outcome: "notApplied",
      });
    }),
  );

  it.effect("rejects a denial receipt that claims an uncertain external outcome", () =>
    Effect.gen(function* () {
      const initial = yield* makeEmptyThreadSnapshot({ threadId, throughCursor: "origin" });
      const input = yield* makeInput();
      const active = yield* applyThreadEvent(initial, envelope(input));
      const invalid = yield* makeActionReceiptRecorded({
        ...receiptInput("unresolved"),
        threadPosition: "2",
        approval: {
          type: "notAuthorized",
          reason: "currentAuthorizationDenied",
        },
      });
      const error = yield* Effect.flip(applyThreadEvent(active, envelope(invalid)));

      expect(error).toEqual(new InvalidThreadProjection({ reason: "authorityConflict" }));
    }),
  );

  it.effect("rejects an approval-linked receipt without its active request", () =>
    Effect.gen(function* () {
      const initial = yield* makeEmptyThreadSnapshot({
        threadId,
        throughCursor: "origin",
      });
      const input = yield* makeInput();
      const active = yield* applyThreadEvent(initial, envelope(input));
      const receipt = yield* makeActionReceiptRecorded({
        ...receiptInput("applied"),
        threadPosition: "2",
      });
      const error = yield* Effect.flip(applyThreadEvent(active, envelope(receipt)));

      expect(error).toEqual(new InvalidThreadProjection({ reason: "authorityConflict" }));
    }),
  );

  it.effect("rejects a receipt whose presentation does not match the active approval", () =>
    Effect.gen(function* () {
      const initial = yield* makeEmptyThreadSnapshot({
        threadId,
        throughCursor: "origin",
      });
      const input = yield* makeInput();
      const request = yield* makeApprovalRequest();
      const waiting = yield* fold(initial, [input, request]);
      const receipt = yield* makeActionReceiptRecorded({
        ...receiptInput("applied"),
        presentation: {
          ...presentation,
          fields: [presentation.fields[0], { label: "Subject", value: "Changed subject" }],
        },
      });
      const error = yield* Effect.flip(applyThreadEvent(waiting, envelope(receipt)));

      expect(error).toEqual(new InvalidThreadProjection({ reason: "authorityConflict" }));
    }),
  );

  it.effect("handles replay duplicates, semantic duplicates, gaps, and position conflicts", () =>
    Effect.gen(function* () {
      const initial = yield* makeEmptyThreadSnapshot({
        threadId,
        throughCursor: "origin",
      });
      const input = yield* makeInput();
      const request = yield* makeApprovalRequest();
      const waiting = yield* fold(initial, [input, request]);
      const replay = yield* applyThreadEvent(waiting, envelope(request));
      const conflict = {
        ...request,
        eventId: "269787db-071e-4478-806f-1d85d00b7337",
      };
      const conflictError = yield* Effect.flip(applyThreadEvent(waiting, envelope(conflict)));
      const receipt = yield* makeActionReceiptRecorded(receiptInput("applied"));
      const gap = { ...receipt, threadPosition: "4" };
      const gapError = yield* Effect.flip(applyThreadEvent(waiting, envelope(gap)));
      const terminal = yield* applyThreadEvent(waiting, envelope(receipt));
      const duplicateReceipt = {
        ...receipt,
        eventId: "71c5311f-9b88-480e-a6b3-f572c868a9a1",
        threadPosition: "4",
      };
      const duplicateError = yield* Effect.flip(
        applyThreadEvent(terminal, envelope(duplicateReceipt)),
      );

      expect(replay).toBe(waiting);
      expect(conflictError).toEqual(new InvalidThreadProjection({ reason: "authorityConflict" }));
      expect(gapError).toEqual(new InvalidThreadProjection({ reason: "gap" }));
      expect(duplicateError).toEqual(new InvalidThreadProjection({ reason: "authorityConflict" }));
    }),
  );

  it.effect("rejects unsupported versions, outcomes, and sensitive presentation fields", () =>
    Effect.gen(function* () {
      const request = yield* makeApprovalRequest();
      const receipt = yield* makeActionReceiptRecorded(receiptInput("applied"));
      const badVersion = yield* Effect.flip(
        Schema.decodeUnknownEffect(ActionApprovalRequestedSchema)({
          ...request,
          eventVersion: 2,
        }),
      );
      const badOutcome = yield* Effect.flip(
        Schema.decodeUnknownEffect(ActionReceiptRecordedSchema)({
          ...receipt,
          payload: { ...receipt.payload, outcome: "accepted" },
        }),
      );
      const sensitiveField = yield* Effect.flip(
        Schema.decodeUnknownEffect(ActionApprovalRequestedSchema, {
          onExcessProperty: "error",
        })({
          ...request,
          payload: {
            ...request.payload,
            presentation: {
              ...request.payload.presentation,
              recipient: "recipient@example.com",
              content: "private message body",
              provider: "smtp.example.com",
            },
          },
        }),
      );
      expect(badVersion).toBeDefined();
      expect(badOutcome).toBeDefined();
      expect(sensitiveField).toBeDefined();
    }),
  );
});
