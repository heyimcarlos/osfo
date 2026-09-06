import { Layer } from "effect";

import { BillingHandlers } from "./handlers/billing";
import { AccountHandlers } from "./handlers/account";
import { ChannelLinksHandlers } from "./handlers/channel-links";
import { HealthHandlers } from "./handlers/health";
import { RegistrationHandlers } from "./handlers/registration";
import { ResearchReportHandlers } from "./handlers/research-reports";
import { DocumentBuildHandlers } from "./handlers/document-builds";
import { FilesHandlers } from "./handlers/files";
import { SkillsHandlers } from "./handlers/skills";
import { IntegrationHandlers } from "./handlers/integrations";
import { ReminderHandlers } from "./handlers/reminders";
import { ScheduledEmailHandlers } from "./handlers/scheduled-emails";
import { publicWebBaseUrl, type CloudflareConfig } from "./config";
import { AccountDeletionComposition } from "./composition/account-deletion";
import { SupermemoryMemoryProvider } from "./integrations/supermemory/memory-provider";

/** Implement every typed Osfo API group. */
export const layer = (
  config: CloudflareConfig,
  bindings: AccountDeletionComposition.Bindings &
    SkillsHandlers.Bindings &
    IntegrationHandlers.Bindings &
    ReminderHandlers.Bindings &
    ScheduledEmailHandlers.Bindings &
    FilesHandlers.Bindings & { readonly DB: Pick<Hyperdrive, "connectionString"> },
) =>
  Layer.mergeAll(
    AccountHandlers.layer.pipe(
      Layer.provide(AccountDeletionComposition.layer(bindings)),
      Layer.provide(SupermemoryMemoryProvider.layerFromConfig(config.supermemory, bindings.DB)),
    ),
    BillingHandlers.layer(config),
    ChannelLinksHandlers.layer,
    DocumentBuildHandlers.layer,
    FilesHandlers.layer(bindings),
    HealthHandlers.layer(config.stage),
    IntegrationHandlers.layer(
      bindings,
      new URL("/settings/integrations", publicWebBaseUrl(config.auth)),
    ),
    RegistrationHandlers.layer,
    ResearchReportHandlers.layer,
    ReminderHandlers.layer(bindings),
    ScheduledEmailHandlers.layer(bindings),
    SkillsHandlers.layer(bindings),
  );

export * as Handlers from "./handlers";
