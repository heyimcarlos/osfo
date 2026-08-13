import { Schema } from "effect";

/** Stages that own separate Osfo resources and configuration. */
export const OsfoStage = Schema.Literals(["development", "test", "production"]);

/** A parsed Osfo deployment stage. */
export type OsfoStage = typeof OsfoStage.Type;

/** Parse an Osfo stage at a Cloudflare binding boundary. */
export const decodeOsfoStage = Schema.decodeUnknownOption(OsfoStage);
