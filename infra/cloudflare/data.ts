import type { OsfoStage } from "@osfo/worker/env";

/** Define the stage-local data resource group. */
export const dataResources = (stage: OsfoStage) => ({ stage });
