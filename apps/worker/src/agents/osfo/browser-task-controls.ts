import { BrowserTaskSelection } from "@osfo/api";
import { Schema } from "effect";

import { UserId } from "../../domain";
import { AuthSessionId } from "../../domain/auth-session";

export const Actor = Schema.TaggedStruct("AuthSession", {
  authSessionId: AuthSessionId,
  expiresAt: Schema.DateFromString,
  userId: UserId,
});
export type Actor = typeof Actor.Encoded;

export const Request = Schema.Struct({ actor: Actor, ...BrowserTaskSelection.fields });
export type Request = typeof Request.Encoded;

export * as BrowserTaskControls from "./browser-task-controls";
