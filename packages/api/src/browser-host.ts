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
