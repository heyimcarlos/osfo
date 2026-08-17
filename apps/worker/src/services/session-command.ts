import { Effect, type DateTime } from "effect";

import { SessionId, type ConversationRouteId } from "../domain";
import type { ManagedSessionReplacementAdmitted } from "./managed-conversation";
import type { SessionLifecycleNotFound, SessionLifecycleUnavailable } from "./session-lifecycle";
import type {
  CurrentSessionActivationUnavailable,
  CurrentSessionReplacementConflict,
} from "./session-replacement";
import type {
  SessionCommandReceipt,
  SessionCommandReceiptConflict,
  SessionCommandReceiptInput,
} from "./session-command-receipt";

/** Persistence input for atomically terminating one accepted Session command. */
export interface SessionCommandRecordInput {
  readonly expectedCurrentSessionId: SessionId;
  readonly receipt: SessionCommandReceiptInput;
  readonly replacedAt: DateTime.Utc;
  readonly replacementSessionId: SessionId;
  readonly routeId: ConversationRouteId;
}

/** Application-owned persistence port for one Session command. */
export interface SessionCommandStore {
  readonly readRoute: (
    routeId: ConversationRouteId,
  ) => Effect.Effect<
    { readonly currentSessionId: SessionId; readonly routeId: ConversationRouteId },
    SessionLifecycleNotFound | SessionLifecycleUnavailable
  >;
  readonly replaceCurrentWithCommandReceipt: (
    input: SessionCommandRecordInput,
  ) => Effect.Effect<
    SessionCommandReceipt,
    | CurrentSessionReplacementConflict
    | SessionCommandReceiptConflict
    | SessionLifecycleNotFound
    | SessionLifecycleUnavailable
  >;
}

/** Dependencies for the atomic Session-command application operation. */
export interface SessionCommandDependencies {
  readonly activateCurrent: Effect.Effect<void, CurrentSessionActivationUnavailable>;
  readonly now: Effect.Effect<DateTime.Utc>;
  readonly store: SessionCommandStore;
}

/** Construct the atomic and recoverable Session-command operation. */
export const makeSessionCommand = (dependencies: SessionCommandDependencies) => ({
  replace: (command: ManagedSessionReplacementAdmitted, receipt: SessionCommandReceiptInput) =>
    Effect.gen(function* () {
      const route = yield* dependencies.store.readRoute(command.routeId);
      const commandReceipt = yield* dependencies.store.replaceCurrentWithCommandReceipt({
        expectedCurrentSessionId: route.currentSessionId,
        receipt,
        replacedAt: yield* dependencies.now,
        replacementSessionId: SessionId.make(`session-${command.submissionId}`),
        routeId: route.routeId,
      });
      yield* dependencies.activateCurrent;
      return commandReceipt;
    }),
});
