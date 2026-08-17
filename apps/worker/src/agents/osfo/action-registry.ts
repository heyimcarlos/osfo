import { action, type PendingApproval } from "@cloudflare/think";
import { Effect, Option, Schema } from "effect";

import { ActionId } from "../../domain/action-execution";
import type { Denied } from "../../services/authorization";
import {
  ClearCoreMemoryInput,
  type ClearCoreMemoryInput as ClearCoreMemory,
  type CoreMemoryCleared,
  type CoreMemoryUnavailable,
  coreMemoryLabelFor,
} from "./core-memory";
import {
  ActionPresentation,
  ActionPresentationId,
  ActionPresentationUnavailable,
  type PendingThinkAction,
} from "./think-action-approvals";
import {
  makeTestProtectedAction,
  presentTestProtectedAction,
  sanitizeTestProtectedActionInput,
  testProtectedActionName,
  type TestProtectedActionState,
} from "./test-protected-action";
import { effectToolSchema } from "./effect-tool-schema";

type SanitizedPendingApprovalInput =
  | ClearCoreMemory
  | ReturnType<typeof sanitizeTestProtectedActionInput>;

/** Name registered with Think for the Core Memory clear Action. */
export const coreMemoryClearActionName = "osfoClearCoreMemory";

/** Build Osfo's cohesive Think Action registry. */
export const makeOsfoActions = (options: {
  readonly clearCoreMemory: (
    input: ClearCoreMemory,
    actionId: ActionId,
  ) => Promise<CoreMemoryCleared | CoreMemoryUnavailable | Denied>;
  readonly testProtectedActionState?: () => TestProtectedActionState;
}) => {
  const actions = {
    [coreMemoryClearActionName]: action({
      approval: true,
      approvalRisk: "high",
      approvalSummary: "Clear the selected Core Memory block",
      description: "Clear one selected Core Memory block after exact human Approval.",
      // oxlint-disable-next-line effecttsgo/async-function -- Think Actions require a Promise-returning execute callback.
      execute: async (input, context) =>
        await options.clearCoreMemory(input, ActionId.make(context.toolCallId)),
      idempotencyKey: ({ ctx }) => `core-memory-clear:${ctx.toolCallId}`,
      inputSchema: effectToolSchema(ClearCoreMemoryInput),
      kind: "durable-pause",
      permissions: ["memory:clear"],
    }),
  };
  return options.testProtectedActionState === undefined
    ? actions
    : Object.assign(actions, {
        [testProtectedActionName]: makeTestProtectedAction({
          readState: options.testProtectedActionState,
        }),
      });
};

/** Project one registered Action into its definition-owned safe presentation. */
export const presentOsfoAction = (pending: PendingThinkAction) =>
  pending.descriptor.action === coreMemoryClearActionName
    ? presentCoreMemoryClearAction(pending)
    : presentTestProtectedAction(pending);

/** Keep only definition-owned input fields on every pending Approval. */
export const sanitizePendingApproval = (approval: PendingApproval): PendingApproval => {
  if (approval.source !== "action") return withoutInput(approval);
  if (approval.descriptor.action === coreMemoryClearActionName) {
    return withInput(
      approval,
      Schema.decodeUnknownOption(ClearCoreMemoryInput)(approval.descriptor.input).pipe(
        Option.match({ onNone: () => ({}), onSome: (safe) => safe }),
      ),
    );
  }
  if (approval.descriptor.action === testProtectedActionName) {
    return withInput(approval, sanitizeTestProtectedActionInput(approval.descriptor.input));
  }
  return withoutInput(approval);
};

const presentCoreMemoryClearAction = (
  pending: PendingThinkAction,
): Effect.Effect<ActionPresentation, ActionPresentationUnavailable> =>
  Schema.decodeUnknownEffect(ClearCoreMemoryInput)(pending.descriptor.input).pipe(
    Effect.mapError(
      () =>
        new ActionPresentationUnavailable({
          action: pending.descriptor.action,
          message: "The Core Memory clear input cannot be projected safely",
        }),
    ),
    Effect.map((input) => {
      const label = coreMemoryLabelFor(input.block);
      return ActionPresentation.make({
        actionDefinitionVersion: "osfo-core-memory-clear-v1",
        actionId: ActionId.make(pending.descriptor.toolCallId),
        consequences: [`Permanently clear the ${label} block.`],
        description: `Clear the ${label} block.`,
        fields: [{ label: "Block", name: "block", value: label }],
        operation: "memory.clear",
        presentationId: ActionPresentationId.make(pending.executionId),
        title: `Clear ${label}`,
      });
    }),
  );

const withInput = (
  approval: PendingApproval,
  input: SanitizedPendingApprovalInput,
): PendingApproval =>
  Object.assign({}, approval, {
    descriptor: Object.assign({}, approval.descriptor, { input }),
  });

const withoutInput = (approval: PendingApproval): PendingApproval => withInput(approval, {});
