import { Uuid } from "@osfo/api";
import * as Schema from "effect/Schema";

export const ReferenceClientConfig = Schema.Struct({
  authenticationToken: Schema.NonEmptyString,
  baseUrl: Schema.URLFromString,
  threadId: Uuid,
});

export type ReferenceClientConfig = typeof ReferenceClientConfig.Type;

export const decodeReferenceClientConfig = Schema.decodeUnknownExit(ReferenceClientConfig);
