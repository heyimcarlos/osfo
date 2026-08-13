import type { OsfoStage } from "@osfo/worker/env";

/** Define the stage-local public web resource group. */
export const webResources = (stage: OsfoStage) => ({ stage });
