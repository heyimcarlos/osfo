import { InventoryRequest, type InventoryResponse, requestIdentity } from "@osfo/api/browser-host";
import { Effect, Schema } from "effect";

import type { ThinkSubmissionId, UserId } from "../domain";

export interface Binding {
  readonly hostSessionId: string;
  readonly ownerUserId: string;
}

export interface Inspection {
  readonly operationId: string;
  readonly turnId: ThinkSubmissionId;
  readonly userId: UserId;
}

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  { message: Schema.String },
) {}

export interface Interface<Error = BrowserUnavailable> {
  readonly inspect: (request: Inspection) => Effect.Effect<InventoryResponse["outcome"], Error>;
}

/** Only the authenticated owner can advertise this managed browser as available. */
export const isAvailable = (binding: Binding | null, userId: UserId): boolean =>
  binding !== null && binding.ownerUserId === userId;

/** Admission precedes transport; every response must retain the exact request identity. */
export const make = <Error>(options: {
  readonly authorize: (request: Inspection) => Effect.Effect<void, Error>;
  readonly binding: (userId: UserId) => Binding | null;
  readonly dispatch: (
    request: InventoryRequest,
    binding: Binding,
  ) => Effect.Effect<InventoryResponse, BrowserUnavailable>;
}): Interface<Error | BrowserUnavailable> => ({
  inspect: Effect.fn("BrowserHost.inspect")(function* (inspection: Inspection) {
    const binding = options.binding(inspection.userId);
    if (binding === null || !isAvailable(binding, inspection.userId)) {
      return yield* unavailable();
    }
    const request = yield* Schema.decodeEffect(InventoryRequest)({
      hostSessionId: binding.hostSessionId,
      operation: "inventory",
      operationId: inspection.operationId,
      ownerUserId: inspection.userId,
      turnId: inspection.turnId,
    }).pipe(Effect.mapError(unavailable));
    yield* options.authorize(inspection);
    const response = yield* options.dispatch(request, binding);
    if (requestIdentity(response.request) !== requestIdentity(request)) {
      return yield* unavailable();
    }
    return response.outcome;
  }),
});

const unavailable = () =>
  new BrowserUnavailable({ message: "The managed browser is unavailable for this turn." });

export * as Browser from "./browser-host";
