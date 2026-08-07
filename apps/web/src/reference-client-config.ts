import { Uuid } from "@osfo/api";
import * as Schema from "effect/Schema";

export const ReferenceClientConfig = Schema.Struct({
  authenticationToken: Schema.NonEmptyString,
  baseUrl: Schema.URLFromString,
  clientInstanceId: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9])?$/u),
  ),
  threadId: Uuid,
});

export type ReferenceClientConfig = typeof ReferenceClientConfig.Type;

export const decodeReferenceClientConfig = Schema.decodeUnknownExit(ReferenceClientConfig);
