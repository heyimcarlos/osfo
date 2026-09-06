import { Option, Schema } from "effect";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(100_000),
);

/** Private host transport. No arbitrary JavaScript or browser actions cross this boundary. */
export const InventoryRequest = Schema.Struct({
  hostSessionId: identity,
  operation: Schema.Literal("inventory"),
  operationId: identity,
  ownerUserId: identity,
  turnId: identity,
});
export type InventoryRequest = typeof InventoryRequest.Type;

export const InventoryResponse = Schema.Struct({
  request: InventoryRequest,
  outcome: Schema.TaggedUnion({
    Observed: {
      browsers: Schema.Array(
        Schema.Struct({ id: identity, name: identity, tabCount: count }),
      ).check(Schema.isMaxLength(16)),
      observedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    },
    Unavailable: {},
    ApprovalRequired: {},
    Unknown: {},
  }),
});
export type InventoryResponse = typeof InventoryResponse.Type;

/** Promise consumers can decode without mixing the host's SDK Effect runtime with API Effect. */
export const decodeInventoryRequest = (body: string): InventoryRequest | undefined =>
  Option.getOrUndefined(
    Schema.decodeOption(Schema.fromJsonString(InventoryRequest))(body, {
      onExcessProperty: "error",
    }),
  );
export const decodeInventoryResponse = (body: string): InventoryResponse | undefined =>
  Option.getOrUndefined(
    Schema.decodeOption(Schema.fromJsonString(InventoryResponse))(body, {
      onExcessProperty: "error",
    }),
  );

/** The identity includes its owner and host, so a reused tool call cannot cross a binding. */
export const requestIdentity = (request: InventoryRequest): string =>
  JSON.stringify([
    request.ownerUserId,
    request.hostSessionId,
    request.turnId,
    request.operationId,
    request.operation,
  ]);

export const encodeInventoryResponse = Schema.encodeSync(Schema.fromJsonString(InventoryResponse));

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

/** Host-generated page evidence. Targets belong only to this exact observation. */
export const BrowserObservation = Schema.Struct({
  observationId: identity,
  taskId: identity,
  url: boundedText(4096),
  observedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  text: boundedText(48_000),
});
export type BrowserObservation = typeof BrowserObservation.Type;

/** Each DOM interaction is one exact protected Action, never arbitrary JavaScript. */
export const BrowserInteraction = Schema.TaggedUnion({
  Click: { target: identity },
  Fill: { target: identity, value: Schema.String.check(Schema.isMaxLength(4096)) },
  Select: { target: identity, value: boundedText(4096) },
});
export type BrowserInteraction = typeof BrowserInteraction.Type;

export const BrowserCommand = Schema.TaggedUnion({
  Open: { url: boundedText(4096) },
  Observe: {},
  Interact: { observationId: identity, interaction: BrowserInteraction },
  Outcome: { operationId: identity },
  Close: {},
  Revoke: {},
});
export type BrowserCommand = typeof BrowserCommand.Type;

export const BrowserRequest = Schema.Struct({
  ownerUserId: identity,
  hostSessionId: identity,
  turnId: identity,
  operationId: identity,
  taskId: identity,
  command: BrowserCommand,
});
export type BrowserRequest = typeof BrowserRequest.Type;

/** Observed confirms page evidence, never an appointment merely because a click returned. */
export const BrowserOutcome = Schema.TaggedUnion({
  Observed: { observation: BrowserObservation },
  HumanRequired: {},
  Stale: {},
  Closed: {},
  Unavailable: {},
  Conflict: {},
  Unknown: {},
});
export type BrowserOutcome = typeof BrowserOutcome.Type;

export const BrowserResponse = Schema.Struct({ request: BrowserRequest, outcome: BrowserOutcome });
export type BrowserResponse = typeof BrowserResponse.Type;

export const encodeBrowserRequest = Schema.encodeSync(Schema.fromJsonString(BrowserRequest));
export const encodeBrowserResponse = Schema.encodeSync(Schema.fromJsonString(BrowserResponse));
export const decodeBrowserRequest = (body: string): BrowserRequest | undefined =>
  Option.getOrUndefined(
    Schema.decodeOption(Schema.fromJsonString(BrowserRequest))(body, { onExcessProperty: "error" }),
  );
export const decodeBrowserResponse = (body: string): BrowserResponse | undefined =>
  Option.getOrUndefined(
    Schema.decodeOption(Schema.fromJsonString(BrowserResponse))(body, {
      onExcessProperty: "error",
    }),
  );

/** A caller cannot change a command or its payload when replaying the same operation. */
export const browserRequestIdentity = (request: BrowserRequest): string =>
  JSON.stringify([request.ownerUserId, request.hostSessionId, request.taskId, request.operationId]);
