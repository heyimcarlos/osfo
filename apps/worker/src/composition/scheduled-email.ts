import { IncidentControlsPostgres } from "../integrations/postgres/incident-controls";
import { DateTime, Effect, Layer, Result, Predicate, Schema } from "effect";

import type { Database } from "@osfo/db";
import { OSFO_DIRECTORY_NAME } from "../agents/osfo/identity";
import { Db } from "../db";
import { BillingDb } from "../db/billing";
import { retainedCatalog } from "../domain/plan-policy";
import { ScheduledEmailFollowUpPostgres } from "../integrations/postgres/scheduled-email-follow-up";
import { ScheduledEmailPostgres } from "../integrations/postgres/scheduled-email";
import type { IncidentControls } from "../services/incident-controls";
import { Allowances } from "../services/allowances";
import { ScheduledEmail } from "../services/scheduled-email";
import { ScheduledEmailAccounting } from "../services/scheduled-email-accounting";
import { ScheduledEmailFollowUp } from "../services/scheduled-email-follow-up";
import type { Integrations } from "../services/integrations";

/* oxlint-disable effecttsgo/async-function, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle, osfo/no-unknown-returns, typescript/consistent-return -- This module is the Scheduled Email application composition root. Cloudflare RPC returns are untrusted and decoded immediately after the Promise boundary. */

type WorkflowInstanceHandle = Pick<WorkflowInstance, "restart" | "status" | "terminate">;

export interface WorkflowBinding {
  readonly create: (options: {
    readonly id: string;
    readonly params: ScheduledEmail.EncodedWorkflowPayload;
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
  checkNewCreation: Effect.Effect<void, IncidentControls.Paused | IncidentControls.Unavailable>,
): ScheduledEmail.PortInterface["workflow"] => ({
  create: (instanceId, payload) =>
    Effect.gen(function* () {
      const admission = yield* checkNewCreation.pipe(Effect.result);
      return yield* (
        Result.isFailure(admission)
          ? Effect.fail(unavailable("workflow.create", admission.failure))
          : Schema.encodeEffect(ScheduledEmail.EncodedWorkflowPayload)(payload).pipe(
              Effect.flatMap((params) =>
                Effect.tryPromise({
                  try: () => binding.create({ id: instanceId, params }).then(() => undefined),
                  catch: (cause) => unavailable("workflow.create", cause),
                }),
              ),
              Effect.mapError((cause) => unavailable("workflow.create", cause)),
            )
      ).pipe(
        Effect.catchTag("ScheduledEmailUnavailable", (failure) =>
          Effect.tryPromise({
            try: async () => {
              const instance = await binding.get(instanceId);
              return { instance, status: await instance.status() };
            },
            catch: (cause) => unavailable("workflow.reconcileCreate", cause),
          }).pipe(
            Effect.flatMap(({ instance, status }) => {
              if (status.status === "unknown") return Effect.fail(failure);
              if (!["complete", "errored", "terminated"].includes(status.status))
                return Effect.void;
              // Existing status acknowledges a host during a pause without restarting it.
              if (Result.isFailure(admission)) return Effect.void;
              return checkNewCreation.pipe(
                Effect.matchEffect({
                  onFailure: () => Effect.void,
                  onSuccess: () =>
                    Effect.tryPromise({
                      try: () => instance.restart(),
                      catch: (cause) => unavailable("workflow.restart", cause),
                    }),
                }),
              );
            }),
          ),
        ),
      );
    }),
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
  integrations: Integrations.Interface | null,
) => {
  const accounting = makeAccounting(database);
  const loadCurrentAuthorization = ScheduledEmailPostgres.makeCurrentAuthorization(database);
  const port = ScheduledEmail.Port.of({
    commitTerminalFollowUp: makeTerminalFollowUpCommitter(bindings, database),
    currentAuthorization: (email, authority) =>
      Effect.gen(function* () {
        if (integrations === null) {
          return yield* unavailable(
            "authorization.integrations",
            new Error("Integration provider is unavailable"),
          );
        }
        const current = yield* loadCurrentAuthorization(email, authority);
        const evidence = yield* integrations
          .connectionEvidence({ toolkit: "gmail", userId: email.userId })
          .pipe(Effect.mapError((cause) => unavailable("authorization.gmailConnection", cause)));
        const gmailConnection = Predicate.isTagged(evidence, "IntegrationConnectionConnected")
          ? ({ _tag: "Connected", toolkit: "gmail", userId: email.userId } as const)
          : null;
        return {
          ...current,
          authority:
            authority === "durableTrigger"
              ? {
                  _tag: "DurableTrigger" as const,
                  triggerId: email.workflowId,
                  triggerType: "workflow" as const,
                  userId: email.userId,
                }
              : current.authority,
          gmailConnection,
          integrationConnections: gmailConnection === null ? [] : [gmailConnection],
          originatingAuthority:
            authority === "durableTrigger"
              ? {
                  _tag: "DurableTrigger" as const,
                  triggerId: email.workflowId,
                  triggerType: "workflow" as const,
                }
              : current.originatingAuthority,
        };
      }),
    persistence: ScheduledEmailPostgres.make(database),
    reconcileSend: makeSendReconciler(integrations?.inspectAction ?? null),
    recordSendOutcome: (email) =>
      accounting
        .recordSendOutcome(email)
        .pipe(Effect.mapError((cause) => unavailable("accounting.gmailSend", cause))),
    recordWorkflowStart: (email) =>
      accounting
        .recordWorkflowStart(email)
        .pipe(Effect.mapError((cause) => unavailable("accounting.workflowStart", cause))),
    send: (email, authorize) =>
      integrations === null
        ? Effect.fail(
            new ScheduledEmail.SendAmbiguous({ message: "Integration provider unavailable" }),
          )
        : integrations
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
                IntegrationActionNotApplied: (cause) =>
                  Effect.fail(
                    new ScheduledEmail.SendNotApplied({
                      message: cause.message,
                      providerLogId: cause.providerLogId,
                    }),
                  ),
                IntegrationConnectionUnavailable: (cause) =>
                  Effect.fail(new ScheduledEmail.SendAuthorityEnded({ message: cause.message })),
                IntegrationExecutionRejected: (cause) =>
                  cause.code === "resultInvalid"
                    ? Effect.fail(new ScheduledEmail.SendAmbiguous({ message: cause.message }))
                    : Effect.fail(
                        new ScheduledEmail.SendNotApplied({
                          message: cause.message,
                          providerLogId: cause.providerLogId ?? null,
                        }),
                      ),
                IntegrationManifestUnavailable: (cause) =>
                  Effect.fail(
                    new ScheduledEmail.SendNotApplied({
                      message: cause.message,
                      providerLogId: null,
                    }),
                  ),
                IntegrationManifestValueInvalid: (cause) =>
                  Effect.fail(
                    new ScheduledEmail.SendNotApplied({
                      message: cause.message,
                      providerLogId: null,
                    }),
                  ),
                IntegrationPersistenceUnavailable: (cause) =>
                  Effect.fail(new ScheduledEmail.SendAmbiguous({ message: cause.message })),
                IntegrationProviderUnavailable: (cause) =>
                  Effect.fail(new ScheduledEmail.SendAmbiguous({ message: cause.message })),
              }),
            ),
    workflow: makeWorkflowPort(
      bindings.SCHEDULED_EMAIL_WORKFLOW,
      IncidentControlsPostgres.makeFromDatabase(database).check("newCostlyWork"),
    ),
  });
  return ScheduledEmail.layerWithoutDependencies.pipe(
    Layer.provide(Layer.succeed(ScheduledEmail.Port, port)),
  );
};

export const makeSendReconciler =
  (
    inspectAction: Integrations.Interface["inspectAction"] | null,
  ): ScheduledEmail.PortInterface["reconcileSend"] =>
  (email) =>
    inspectAction === null
      ? Effect.fail(
          unavailable(
            "send.reconcile.integrations",
            new Error("Integration provider is unavailable"),
          ),
        )
      : inspectAction({
          actionId: email.actionId,
          identity: integrationIdentity(email),
          input: gmailInput(email),
          userId: email.userId,
        }).pipe(
          Effect.catchTag("IntegrationExecutionRejected", (cause) =>
            cause.code === "resultInvalid"
              ? Effect.succeed({ _tag: "Ambiguous" as const })
              : Effect.fail(cause),
          ),
          Effect.map((inspection): ScheduledEmail.SendReconciliation => {
            if (inspection._tag === "Applied") return inspection;
            if (inspection._tag === "NotApplied") {
              return { _tag: "NotApplied", providerLogId: inspection.providerLogId };
            }
            if (inspection._tag === "NotStarted" || inspection._tag === "Pending") {
              return inspection;
            }
            return { _tag: "Ambiguous" };
          }),
          Effect.mapError((cause) => unavailable("send.reconcile", cause)),
        );

export const effect = <Value, Failure>(
  bindings: Bindings,
  integrations: Integrations.Interface | null,
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

export const followUpLayerFromDatabase = (database: Database) =>
  ScheduledEmailFollowUp.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.succeed(ScheduledEmailFollowUp.Port, ScheduledEmailFollowUpPostgres.make(database)),
    ),
  );

export const followUpLayer = Layer.unwrap(Db.database.pipe(Effect.map(followUpLayerFromDatabase)));

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
  gmailResource: email.request.gmailResource,
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
