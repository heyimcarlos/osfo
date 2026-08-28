import { DateTime, Effect, Layer, Predicate, Schema } from "effect";

import type { Database } from "@osfo/db";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { Db } from "../db";
import { BillingDb } from "../db/billing";
import { retainedCatalog } from "../domain/plan-policy";
import { ScheduledEmailFollowUpPostgres } from "../integrations/postgres/scheduled-email-follow-up";
import { ScheduledEmailPostgres } from "../integrations/postgres/scheduled-email";
import { Allowances } from "../services/allowances";
import { ScheduledEmail } from "../services/scheduled-email";
import { ScheduledEmailAccounting } from "../services/scheduled-email-accounting";
import { ScheduledEmailFollowUp } from "../services/scheduled-email-follow-up";
import type { Integrations } from "../services/integrations";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle, osfo/no-unknown-returns, typescript/consistent-return -- This module is the Scheduled Email application composition root. Cloudflare RPC returns are untrusted and decoded immediately after the Promise boundary. */

type WorkflowInstanceHandle = Pick<WorkflowInstance, "status" | "terminate">;

export interface WorkflowBinding {
  readonly create: (options: {
    readonly id: string;
    readonly params: ScheduledEmail.WorkflowPayload;
  }) => Promise<WorkflowInstanceHandle>;
  readonly get: (id: string) => Promise<WorkflowInstanceHandle>;
}

export interface DirectoryBinding {
  readonly getByName: (name: string) => {
    readonly submitScheduledEmailFollowUp: (notificationId: string) => Promise<unknown>;
  };
}

export interface Bindings {
  readonly DB: Pick<Hyperdrive, "connectionString">;
  readonly OSFO_DIRECTORY: DirectoryBinding;
  readonly SCHEDULED_EMAIL_WORKFLOW: WorkflowBinding;
}

export const bindingsFromEnv = (env: Env): Bindings => ({
  DB: env.DB,
  OSFO_DIRECTORY: env.OSFO_DIRECTORY,
  SCHEDULED_EMAIL_WORKFLOW: env.SCHEDULED_EMAIL_WORKFLOW,
});

export const makeWorkflowPort = (
  binding: WorkflowBinding,
): ScheduledEmail.PortInterface["workflow"] => ({
  create: (instanceId, payload) =>
    Effect.tryPromise({
      try: () => binding.create({ id: instanceId, params: payload }).then(() => undefined),
      catch: (cause) => unavailable("workflow.create", cause),
    }).pipe(
      Effect.catchTag("ScheduledEmailUnavailable", (failure) =>
        Effect.tryPromise({
          try: async () => {
            const instance = await binding.get(instanceId);
            const status = await instance.status();
            if (status.status === "unknown") throw failure;
          },
          catch: (cause) => unavailable("workflow.reconcileCreate", cause),
        }),
      ),
    ),
  terminate: (instanceId) =>
    Effect.tryPromise({
      try: async () => {
        const instance = await binding.get(instanceId);
        const status = await instance.status();
        if (!["complete", "errored", "terminated", "unknown"].includes(status.status)) {
          await instance.terminate();
        }
      },
      catch: (cause) => unavailable("workflow.terminate", cause),
    }),
});

export const serviceLayerFromDatabase = (
  bindings: Bindings,
  database: Database,
  integrations: Integrations.Interface,
) => {
  const accounting = makeAccounting(database);
  const currentAuthorization = ScheduledEmailPostgres.makeCurrentAuthorization(database);
  const port = ScheduledEmail.Port.of({
    commitTerminalFollowUp: makeTerminalFollowUpCommitter(bindings, database),
    currentAuthorization: (email) =>
      Effect.gen(function* () {
        const current = yield* currentAuthorization(email);
        const evidence = yield* integrations
          .connectionEvidence({ toolkit: "gmail", userId: email.userId })
          .pipe(Effect.mapError((cause) => unavailable("authorization.gmailConnection", cause)));
        const gmailConnection = Predicate.isTagged(evidence, "IntegrationConnectionConnected")
          ? ({ _tag: "Connected", toolkit: "gmail", userId: email.userId } as const)
          : null;
        return {
          ...current,
          gmailConnection,
          integrationConnections: gmailConnection === null ? [] : [gmailConnection],
        };
      }),
    persistence: ScheduledEmailPostgres.make(database),
    reconcileSend: (email) =>
      integrations
        .inspectAction({
          actionId: email.actionId,
          identity: integrationIdentity(email),
          input: gmailInput(email),
        })
        .pipe(
          Effect.map((inspection): ScheduledEmail.SendReconciliation => {
            if (inspection._tag === "Applied") return inspection;
            if (inspection._tag === "NotApplied") {
              return { _tag: "NotApplied", providerLogId: email.providerLogId };
            }
            if (inspection._tag === "NotStarted") return inspection;
            return { _tag: "Pending" };
          }),
          Effect.mapError((cause) => unavailable("send.reconcile", cause)),
        ),
    recordSendOutcome: (email) =>
      accounting
        .recordSendOutcome(email)
        .pipe(Effect.mapError((cause) => unavailable("accounting.gmailSend", cause))),
    recordWorkflowStart: (email) =>
      accounting
        .recordWorkflowStart(email)
        .pipe(Effect.mapError((cause) => unavailable("accounting.workflowStart", cause))),
    send: (email, authorize) =>
      integrations
        .execute({
          actionId: email.actionId,
          authorize,
          identity: integrationIdentity(email),
          input: gmailInput(email),
          userId: email.userId,
        })
        .pipe(
          Effect.flatMap((result) =>
            result._tag === "IntegrationEffectCompleted"
              ? Effect.succeed(result)
              : Effect.fail(unavailable("send.readOutcome", result)),
          ),
          Effect.catchTags({
            IntegrationActionAmbiguous: (cause) =>
              Effect.fail(new ScheduledEmail.SendAmbiguous({ message: cause.message })),
            IntegrationActionConflict: (cause) =>
              Effect.fail(new ScheduledEmail.SendAmbiguous({ message: cause.message })),
            IntegrationConnectionUnavailable: (cause) =>
              Effect.fail(new ScheduledEmail.SendAuthorityEnded({ message: cause.message })),
            IntegrationExecutionRejected: (cause) =>
              Effect.fail(
                new ScheduledEmail.SendNotApplied({
                  message: cause.message,
                  providerLogId: cause.providerLogId ?? null,
                }),
              ),
            IntegrationManifestUnavailable: (cause) =>
              Effect.fail(
                new ScheduledEmail.SendNotApplied({ message: cause.message, providerLogId: null }),
              ),
            IntegrationManifestValueInvalid: (cause) =>
              Effect.fail(
                new ScheduledEmail.SendNotApplied({ message: cause.message, providerLogId: null }),
              ),
            IntegrationPersistenceUnavailable: (cause) =>
              Effect.fail(new ScheduledEmail.SendAmbiguous({ message: cause.message })),
            IntegrationProviderUnavailable: (cause) =>
              Effect.fail(
                new ScheduledEmail.SendNotApplied({ message: cause.message, providerLogId: null }),
              ),
          }),
        ),
    workflow: makeWorkflowPort(bindings.SCHEDULED_EMAIL_WORKFLOW),
  });
  return ScheduledEmail.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
  );
};

export const effect = <Value, Failure>(
  bindings: Bindings,
  integrations: Integrations.Interface,
  operation: Effect.Effect<Value, Failure, ScheduledEmail.Service>,
) =>
  Effect.scoped(
    Db.database.pipe(
      Effect.flatMap((database) =>
        operation.pipe(Effect.provide(serviceLayerFromDatabase(bindings, database, integrations))),
      ),
      Effect.provide(Db.layer({ db: bindings.DB })),
    ),
  );

const provideFollowUp = <Value, Failure>(
  database: Database,
  operation: Effect.Effect<Value, Failure, ScheduledEmailFollowUp.Service>,
) =>
  operation.pipe(
    Effect.provide(
      ScheduledEmailFollowUp.layerWithoutDependencies.pipe(
        Layer.provide(
          Layer.succeed(ScheduledEmailFollowUp.Port, ScheduledEmailFollowUpPostgres.make(database)),
        ),
      ),
    ),
  );

export const followUpEffect = <Value, Failure>(
  bindings: Pick<Bindings, "DB">,
  operation: Effect.Effect<Value, Failure, ScheduledEmailFollowUp.Service>,
) =>
  Effect.scoped(
    Db.database.pipe(
      Effect.flatMap((database) => provideFollowUp(database, operation)),
      Effect.provide(Db.layer({ db: bindings.DB })),
    ),
  );

export const makeTerminalFollowUpCommitter = (
  bindings: Pick<Bindings, "OSFO_DIRECTORY">,
  database: Database,
): ScheduledEmail.PortInterface["commitTerminalFollowUp"] =>
  Effect.fn("ScheduledEmailComposition.commitTerminalFollowUp")(function* (email) {
    const claimed = yield* provideFollowUp(
      database,
      ScheduledEmailFollowUp.Service.pipe(
        Effect.flatMap((followUps) => followUps.claimTerminal(email)),
      ),
    ).pipe(Effect.mapError((cause) => unavailable("followUp.claim", cause)));
    if (claimed._tag !== "Claimed") return;
    const notificationId = claimed.notification.notificationId;
    const untrusted = yield* Effect.tryPromise({
      try: () =>
        bindings.OSFO_DIRECTORY.getByName(OSFO_DIRECTORY_NAME).submitScheduledEmailFollowUp(
          notificationId,
        ),
      catch: (cause) => unavailable("followUp.directory", cause),
    });
    const result = yield* Schema.decodeUnknownEffect(ScheduledEmailFollowUp.SubmissionSuccess)(
      untrusted,
    ).pipe(Effect.mapError((cause) => unavailable("followUp.decode", cause)));
    if (result.notificationId !== notificationId) {
      return yield* unavailable("followUp.identity", result.notificationId);
    }
  });

const makeAccounting = (database: Database) =>
  ScheduledEmailAccounting.make({
    recordLegacy: (allowancePeriodId, source, items) =>
      Allowances.make({
        billing: BillingDb.make(database),
        catalog: retainedCatalog,
        now: DateTime.now.pipe(Effect.map(DateTime.toDateUtc)),
      })
        .record(allowancePeriodId, source, items)
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) => new ScheduledEmailAccounting.PersistenceUnavailable({ cause }),
          ),
        ),
  });

const gmailInput = (email: ScheduledEmail.Record) => ({
  body: email.request.body,
  recipients: email.request.recipients,
  subject: email.request.subject,
});

const integrationIdentity = (email: ScheduledEmail.Record) => ({
  manifestVersion: email.manifestVersion,
  operation: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
});

const unavailable = (operation: string, cause: unknown) =>
  new ScheduledEmail.Unavailable({
    cause,
    message: "Scheduled Email composition is unavailable",
    operation,
  });

export * as ScheduledEmailComposition from "./scheduled-email";
