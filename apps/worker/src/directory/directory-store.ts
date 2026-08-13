import * as D1Client from "@effect/sql-d1/D1Client";
import { asc, eq } from "drizzle-orm";
import * as SQLiteD1Drizzle from "drizzle-orm/effect-d1";
import { Context, Effect, Layer, Result, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  AgentRoute,
  AllowancePeriodId,
  DenialFact,
  DenialFactId,
  DirectoryCommandId,
  DirectoryRequestDigest,
  ErasureReceipt,
  ErasureReceiptId,
  Plan,
  SubscriptionId,
  UserId,
  type CreateIdentityInput,
  type IdentityCreated,
  type RecordDenialFactInput,
  type RecordErasureReceiptInput,
} from "./directory-model";
import { erasureCommands, erasureReceipts } from "./erasure-schema";
import {
  agentDirectory,
  allowancePeriods,
  denialFacts,
  directoryCommands,
  securityAuditFacts,
  subscriptions,
  users,
} from "./schema";

/** Directory operation names used in safe storage failures. */
export const DirectoryOperation = Schema.Literals([
  "createIdentity",
  "readDenialFacts",
  "readErasureReceipt",
  "recordDenialFact",
  "recordErasureReceipt",
  "resolveAgent",
]);

/** Directory operation names used in safe storage failures. */
export type DirectoryOperation = typeof DirectoryOperation.Type;

/** Expected failure when a stable directory route does not exist. */
export class DirectoryEntryNotFound extends Schema.TaggedError<DirectoryEntryNotFound>()(
  "DirectoryEntryNotFound",
  { message: Schema.String, userId: UserId },
) {}

/** Expected invariant failure when a command exists without its denial fact. */
export class DenialFactNotFound extends Schema.TaggedError<DenialFactNotFound>()(
  "DenialFactNotFound",
  { denialFactId: DenialFactId, message: Schema.String },
) {}

/** Expected failure when an independent Erasure Receipt does not exist. */
export class ErasureReceiptNotFound extends Schema.TaggedError<ErasureReceiptNotFound>()(
  "ErasureReceiptNotFound",
  { message: Schema.String, receiptId: ErasureReceiptId },
) {}

/** Expected failure when an idempotency key is reused for different input. */
export class DirectoryCommandConflict extends Schema.TaggedError<DirectoryCommandConflict>()(
  "DirectoryCommandConflict",
  { commandId: DirectoryCommandId, message: Schema.String },
) {}

/** Expected failure when D1 rejects the domain facts in an atomic command. */
export class DirectoryWriteRejected extends Schema.TaggedError<DirectoryWriteRejected>()(
  "DirectoryWriteRejected",
  {
    cause: Schema.Defect(),
    commandId: DirectoryCommandId,
    message: Schema.String,
    operation: DirectoryOperation,
  },
) {}

/** Safe typed failure for an unavailable or inconsistent D1 operation. */
export class DirectoryStoreUnavailable extends Schema.TaggedError<DirectoryStoreUnavailable>()(
  "DirectoryStoreUnavailable",
  {
    cause: Schema.Defect(),
    message: Schema.String,
    operation: DirectoryOperation,
  },
) {}

interface DirectoryStoreService {
  readonly createIdentity: (
    input: CreateIdentityInput,
  ) => Effect.Effect<
    IdentityCreated,
    | DirectoryCommandConflict
    | DirectoryEntryNotFound
    | DirectoryStoreUnavailable
    | DirectoryWriteRejected
  >;
  readonly resolveAgent: (
    userId: UserId,
  ) => Effect.Effect<AgentRoute, DirectoryEntryNotFound | DirectoryStoreUnavailable>;
  readonly recordDenialFact: (
    input: RecordDenialFactInput,
  ) => Effect.Effect<
    DenialFact,
    | DenialFactNotFound
    | DirectoryCommandConflict
    | DirectoryStoreUnavailable
    | DirectoryWriteRejected
  >;
  readonly readDenialFacts: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<DenialFact>, DirectoryStoreUnavailable>;
  readonly recordErasureReceipt: (
    input: RecordErasureReceiptInput,
  ) => Effect.Effect<
    ErasureReceipt,
    | DirectoryCommandConflict
    | DirectoryStoreUnavailable
    | DirectoryWriteRejected
    | ErasureReceiptNotFound
  >;
  readonly readErasureReceipt: (
    receiptId: ErasureReceiptId,
  ) => Effect.Effect<ErasureReceipt, DirectoryStoreUnavailable | ErasureReceiptNotFound>;
}

/** Atomic authority for D1-owned cross-Agent directory facts. */
export class DirectoryStore extends Context.Service<DirectoryStore, DirectoryStoreService>()(
  "@osfo/worker/DirectoryStore",
) {}

/** Cloudflare D1 bindings used by the directory adapter. */
export interface DirectoryStoreBindings {
  readonly directory: D1Database;
  readonly erasureReceipts: D1Database;
}

/** Run the atomic identity creation operation through `DirectoryStore`. */
export const createIdentity = (input: CreateIdentityInput) =>
  Effect.flatMap(DirectoryStore, (service) => service.createIdentity(input));

/** Resolve the stable Agent route for one User through `DirectoryStore`. */
export const resolveAgent = (userId: UserId) =>
  Effect.flatMap(DirectoryStore, (service) => service.resolveAgent(userId));

/** Record one content-free denial fact through `DirectoryStore`. */
export const recordDenialFact = (input: RecordDenialFactInput) =>
  Effect.flatMap(DirectoryStore, (service) => service.recordDenialFact(input));

/** Read the current denial facts for one User through `DirectoryStore`. */
export const readDenialFacts = (userId: UserId) =>
  Effect.flatMap(DirectoryStore, (service) => service.readDenialFacts(userId));

/** Record one content-free receipt in the independent erasure ledger. */
export const recordErasureReceipt = (input: RecordErasureReceiptInput) =>
  Effect.flatMap(DirectoryStore, (service) => service.recordErasureReceipt(input));

/** Read one receipt from the independent erasure ledger. */
export const readErasureReceipt = (receiptId: ErasureReceiptId) =>
  Effect.flatMap(DirectoryStore, (service) => service.readErasureReceipt(receiptId));

/** Construct the D1-backed `DirectoryStore` Layer for one Worker runtime. */
export const makeDirectoryStoreLayer = (bindings: DirectoryStoreBindings) =>
  Layer.succeed(
    DirectoryStore,
    DirectoryStore.of({
      createIdentity: makeCreateIdentity(bindings.directory),
      readDenialFacts: makeReadDenialFacts(bindings.directory),
      readErasureReceipt: makeReadErasureReceipt(bindings.erasureReceipts),
      recordDenialFact: makeRecordDenialFact(bindings.directory),
      recordErasureReceipt: makeRecordErasureReceipt(bindings.erasureReceipts),
      resolveAgent: makeResolveAgent(bindings.directory),
    }),
  );

type DirectoryDatabase = SQLiteD1Drizzle.EffectSQLiteD1Database & {
  readonly $client: D1Client.D1Client;
};

interface DrizzleQuery {
  readonly toSQL: () => {
    readonly params: ReadonlyArray<unknown>;
    readonly sql: string;
  };
}

interface CommandFingerprint {
  readonly commandId: DirectoryCommandId;
  readonly requestDigest: DirectoryRequestDigest;
}

const StoredCommand = Schema.Struct({ requestDigest: DirectoryRequestDigest });
const SubscriptionSelection = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  plan: Plan,
  subscriptionId: SubscriptionId,
});

const makeCreateIdentity = (binding: D1Database) =>
  Effect.fn("DirectoryStore.createIdentity")(function* (input: CreateIdentityInput) {
    return yield* withD1Database(binding, (database) =>
      createIdentityWithDatabase(database, input),
    );
  });

const createIdentityWithDatabase = Effect.fn("DirectoryStore.createIdentityWithDatabase")(
  function* (database: DirectoryDatabase, input: CreateIdentityInput) {
    const command = yield* fingerprintCommand("createIdentity", input.commandId, [
      "create_identity",
      input.agentId,
      input.allowancePeriodEndsAt,
      input.allowancePeriodId,
      input.allowancePeriodStartsAt,
      input.knowledgeSpaceId,
      input.occurredAt,
      input.planPolicyVersion,
      input.subscriptionId,
      input.threadId,
      input.userId,
    ]);
    const existingCommand = yield* findCommand(database, input.commandId, "createIdentity").pipe(
      Effect.mapError((cause) => storeUnavailable("createIdentity", cause)),
    );
    if (existingCommand !== undefined) {
      if (existingCommand.requestDigest !== command.requestDigest) {
        return yield* commandConflict(input.commandId);
      }
      return yield* readIdentity(database, input.userId);
    }

    const inserts = [
      database.insert(directoryCommands).values({
        commandId: input.commandId,
        completedAt: input.occurredAt,
        operation: "create_identity",
        requestDigest: command.requestDigest,
      }),
      database.insert(users).values({
        createdAt: input.occurredAt,
        userId: input.userId,
      }),
      database.insert(agentDirectory).values({
        agentId: input.agentId,
        createdAt: input.occurredAt,
        knowledgeSpaceId: input.knowledgeSpaceId,
        threadId: input.threadId,
        userId: input.userId,
      }),
      database.insert(subscriptions).values({
        createdAt: input.occurredAt,
        plan: "free",
        planPolicyVersion: input.planPolicyVersion,
        subscriptionId: input.subscriptionId,
        userId: input.userId,
      }),
      database.insert(allowancePeriods).values({
        allowancePeriodId: input.allowancePeriodId,
        endsAt: input.allowancePeriodEndsAt,
        plan: "free",
        planPolicyVersion: input.planPolicyVersion,
        startsAt: input.allowancePeriodStartsAt,
        userId: input.userId,
      }),
      database.insert(securityAuditFacts).values({
        action: "identity_created",
        commandId: input.commandId,
        occurredAt: input.occurredAt,
        outcome: "applied",
        userId: input.userId,
      }),
    ];

    const concurrentResult = yield* database.$client
      .batch(inserts.map((query) => toD1Statement(database, query)))
      .pipe(
        Effect.as<IdentityCreated | undefined>(undefined),
        Effect.catch((cause) =>
          recoverConcurrentCommand(
            findCommand(database, input.commandId, "createIdentity"),
            command,
            cause,
            "createIdentity",
            readIdentity(database, input.userId),
          ),
        ),
      );
    if (concurrentResult !== undefined) {
      return concurrentResult;
    }

    return identityCreated(input);
  },
);

const makeResolveAgent = (binding: D1Database) =>
  Effect.fn("DirectoryStore.resolveAgent")(function* (userId: UserId) {
    return yield* withD1Database(binding, (database) => readAgentRoute(database, userId));
  });

const makeRecordDenialFact = (binding: D1Database) =>
  Effect.fn("DirectoryStore.recordDenialFact")(function* (input: RecordDenialFactInput) {
    return yield* withD1Database(binding, (database) =>
      recordDenialFactWithDatabase(database, input),
    );
  });

const recordDenialFactWithDatabase = Effect.fn("DirectoryStore.recordDenialFactWithDatabase")(
  function* (database: DirectoryDatabase, input: RecordDenialFactInput) {
    const command = yield* fingerprintCommand("recordDenialFact", input.commandId, [
      "record_denial_fact",
      input.denialFactId,
      input.kind,
      input.occurredAt,
      input.resourceId,
      input.userId,
    ]);
    const existingCommand = yield* findCommand(database, input.commandId, "recordDenialFact").pipe(
      Effect.mapError((cause) => storeUnavailable("recordDenialFact", cause)),
    );
    if (existingCommand !== undefined) {
      if (existingCommand.requestDigest !== command.requestDigest) {
        return yield* commandConflict(input.commandId);
      }
      return yield* readDenialFact(database, input.denialFactId);
    }

    const inserts = [
      database.insert(directoryCommands).values({
        commandId: input.commandId,
        completedAt: input.occurredAt,
        operation: "record_denial_fact",
        requestDigest: command.requestDigest,
      }),
      database.insert(denialFacts).values({
        denialFactId: input.denialFactId,
        kind: input.kind,
        occurredAt: input.occurredAt,
        resourceId: input.resourceId,
        userId: input.userId,
      }),
      database.insert(securityAuditFacts).values({
        action: "denial_recorded",
        commandId: input.commandId,
        occurredAt: input.occurredAt,
        outcome: "applied",
        userId: input.userId,
      }),
    ];

    const concurrentResult = yield* database.$client
      .batch(inserts.map((query) => toD1Statement(database, query)))
      .pipe(
        Effect.as<DenialFact | undefined>(undefined),
        Effect.catch((cause) =>
          recoverConcurrentCommand(
            findCommand(database, input.commandId, "recordDenialFact"),
            command,
            cause,
            "recordDenialFact",
            readDenialFact(database, input.denialFactId),
          ),
        ),
      );
    if (concurrentResult !== undefined) {
      return concurrentResult;
    }
    return denialFactFromInput(input);
  },
);

const makeReadDenialFacts = (binding: D1Database) =>
  Effect.fn("DirectoryStore.readDenialFacts")(function* (userId: UserId) {
    return yield* withD1Database(binding, (database) =>
      Effect.gen(function* () {
        const rows = yield* database
          .select({
            denialFactId: denialFacts.denialFactId,
            kind: denialFacts.kind,
            occurredAt: denialFacts.occurredAt,
            resourceId: denialFacts.resourceId,
            userId: denialFacts.userId,
          })
          .from(denialFacts)
          .where(eq(denialFacts.userId, userId))
          .orderBy(asc(denialFacts.occurredAt), asc(denialFacts.denialFactId))
          .pipe(Effect.mapError((cause) => storeUnavailable("readDenialFacts", cause)));
        return yield* decodeRow(Schema.Array(DenialFact), rows, "readDenialFacts");
      }),
    );
  });

const makeRecordErasureReceipt = (binding: D1Database) =>
  Effect.fn("DirectoryStore.recordErasureReceipt")(function* (input: RecordErasureReceiptInput) {
    return yield* withD1Database(binding, (database) =>
      recordErasureReceiptWithDatabase(database, input),
    );
  });

const recordErasureReceiptWithDatabase = Effect.fn(
  "DirectoryStore.recordErasureReceiptWithDatabase",
)(function* (database: DirectoryDatabase, input: RecordErasureReceiptInput) {
  const command = yield* fingerprintCommand("recordErasureReceipt", input.commandId, [
    "record_erasure_receipt",
    input.manifestDigest,
    input.receiptId,
    input.recordedAt,
    input.resourceId,
    input.scope,
  ]);
  const existingCommand = yield* findErasureCommand(database, input.commandId).pipe(
    Effect.mapError((cause) => storeUnavailable("recordErasureReceipt", cause)),
  );
  if (existingCommand !== undefined) {
    if (existingCommand.requestDigest !== command.requestDigest) {
      return yield* commandConflict(input.commandId);
    }
    return yield* readErasureReceiptWithDatabase(database, input.receiptId);
  }

  const inserts = [
    database.insert(erasureCommands).values({
      commandId: input.commandId,
      completedAt: input.recordedAt,
      requestDigest: command.requestDigest,
    }),
    database.insert(erasureReceipts).values({
      manifestDigest: input.manifestDigest,
      receiptId: input.receiptId,
      recordedAt: input.recordedAt,
      resourceId: input.resourceId,
      scope: input.scope,
    }),
  ];
  const concurrentResult = yield* database.$client
    .batch(inserts.map((query) => toD1Statement(database, query)))
    .pipe(
      Effect.as<ErasureReceipt | undefined>(undefined),
      Effect.catch((cause) =>
        recoverConcurrentCommand(
          findErasureCommand(database, input.commandId),
          command,
          cause,
          "recordErasureReceipt",
          readErasureReceiptWithDatabase(database, input.receiptId),
        ),
      ),
    );
  if (concurrentResult !== undefined) {
    return concurrentResult;
  }
  return erasureReceiptFromInput(input);
});

const makeReadErasureReceipt = (binding: D1Database) =>
  Effect.fn("DirectoryStore.readErasureReceipt")(function* (receiptId: ErasureReceiptId) {
    return yield* withD1Database(binding, (database) =>
      readErasureReceiptWithDatabase(database, receiptId),
    );
  });

const withD1Database = <A, E>(
  binding: D1Database,
  use: (database: DirectoryDatabase) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(D1Client.layer({ db: binding }).pipe(Layer.orDie));
      return yield* SQLiteD1Drizzle.makeWithDefaults({}).pipe(
        Effect.flatMap(use),
        Effect.provide(context),
      );
    }),
  );

const findCommand = (
  database: DirectoryDatabase,
  commandId: DirectoryCommandId,
  operation: DirectoryOperation,
) =>
  database
    .select({ requestDigest: directoryCommands.requestDigest })
    .from(directoryCommands)
    .where(eq(directoryCommands.commandId, commandId))
    .limit(1)
    .pipe(Effect.flatMap((rows) => decodeOptionalRow(StoredCommand, rows[0], operation)));

const findErasureCommand = (database: DirectoryDatabase, commandId: DirectoryCommandId) =>
  database
    .select({ requestDigest: erasureCommands.requestDigest })
    .from(erasureCommands)
    .where(eq(erasureCommands.commandId, commandId))
    .limit(1)
    .pipe(
      Effect.flatMap((rows) => decodeOptionalRow(StoredCommand, rows[0], "recordErasureReceipt")),
    );

const fingerprintCommand = Effect.fn("DirectoryStore.fingerprintCommand")(function* (
  operation: DirectoryOperation,
  commandId: DirectoryCommandId,
  fields: ReadonlyArray<string>,
) {
  const bytes = new TextEncoder().encode(
    fields.map((field) => `${field.length}:${field}`).join(""),
  );
  const hash = yield* Effect.tryPromise({
    try: () => globalThis.crypto.subtle.digest("SHA-256", bytes),
    catch: (cause) => storeUnavailable(operation, cause),
  });
  const hexadecimal = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    commandId,
    requestDigest: DirectoryRequestDigest.make(`sha256:${hexadecimal}`),
  } satisfies CommandFingerprint;
});

const recoverConcurrentCommand = <A, E, EQuery>(
  findExisting: Effect.Effect<typeof StoredCommand.Type | undefined, EQuery>,
  command: CommandFingerprint,
  cause: SqlError,
  operation: DirectoryOperation,
  readResult: Effect.Effect<A, E>,
) =>
  findExisting.pipe(
    Effect.mapError(() => storeUnavailable(operation, cause)),
    Effect.flatMap((existingCommand) =>
      Effect.gen(function* () {
        if (existingCommand === undefined) {
          return yield* writeRejected(operation, command.commandId, cause);
        }
        if (existingCommand.requestDigest !== command.requestDigest) {
          return yield* commandConflict(command.commandId);
        }
        return yield* readResult;
      }),
    ),
  );

const storeUnavailable = (operation: DirectoryOperation, cause: unknown) =>
  new DirectoryStoreUnavailable({
    cause,
    message: `D1 could not complete ${operation}`,
    operation,
  });

const writeRejected = (
  operation: DirectoryOperation,
  commandId: DirectoryCommandId,
  cause: unknown,
) =>
  new DirectoryWriteRejected({
    cause,
    commandId,
    message: `D1 rejected the atomic ${operation} facts`,
    operation,
  });

const commandConflict = (commandId: DirectoryCommandId) =>
  new DirectoryCommandConflict({
    commandId,
    message: "The command identity was already used for different input",
  });

const decodeRow = <A, Encoded extends object>(
  schema: Schema.Codec<A, Encoded>,
  row: Encoded,
  operation: DirectoryOperation,
) => {
  const decoded = Schema.decodeResult(schema)(row);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(storeUnavailable(operation, decoded.failure));
};

const decodeOptionalRow = <A, Encoded extends object>(
  schema: Schema.Codec<A, Encoded>,
  row: Encoded | undefined,
  operation: DirectoryOperation,
) =>
  Effect.gen(function* () {
    return row === undefined ? undefined : yield* decodeRow(schema, row, operation);
  });

const readIdentity = (database: DirectoryDatabase, userId: UserId) =>
  Effect.all([readAgentRoute(database, userId), readSubscription(database, userId)]).pipe(
    Effect.map(([route, subscription]) => ({ ...route, ...subscription })),
  );

const readAgentRoute = (
  database: DirectoryDatabase,
  userId: UserId,
): Effect.Effect<AgentRoute, DirectoryEntryNotFound | DirectoryStoreUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* database
      .select({
        agentId: agentDirectory.agentId,
        knowledgeSpaceId: agentDirectory.knowledgeSpaceId,
        threadId: agentDirectory.threadId,
        userId: agentDirectory.userId,
      })
      .from(agentDirectory)
      .where(eq(agentDirectory.userId, userId))
      .limit(1)
      .pipe(Effect.mapError((cause) => storeUnavailable("resolveAgent", cause)));
    const route = rows[0];
    if (route === undefined) {
      return yield* new DirectoryEntryNotFound({
        message: "No stable Agent route exists for the User",
        userId,
      });
    }
    return yield* decodeRow(AgentRoute, route, "resolveAgent");
  });

const readSubscription = (database: DirectoryDatabase, userId: UserId) =>
  Effect.gen(function* () {
    const rows = yield* database
      .select({
        allowancePeriodId: allowancePeriods.allowancePeriodId,
        plan: subscriptions.plan,
        subscriptionId: subscriptions.subscriptionId,
      })
      .from(subscriptions)
      .innerJoin(allowancePeriods, eq(allowancePeriods.userId, subscriptions.userId))
      .where(eq(subscriptions.userId, userId))
      .orderBy(asc(allowancePeriods.startsAt))
      .limit(1)
      .pipe(Effect.mapError((cause) => storeUnavailable("createIdentity", cause)));
    const subscription = rows[0];
    if (subscription === undefined) {
      return yield* new DirectoryEntryNotFound({
        message: "No Subscription and allowance period exist for the User",
        userId,
      });
    }
    return yield* decodeRow(SubscriptionSelection, subscription, "createIdentity");
  });

const readDenialFact = (database: DirectoryDatabase, denialFactId: DenialFactId) =>
  Effect.gen(function* () {
    const rows = yield* database
      .select({
        denialFactId: denialFacts.denialFactId,
        kind: denialFacts.kind,
        occurredAt: denialFacts.occurredAt,
        resourceId: denialFacts.resourceId,
        userId: denialFacts.userId,
      })
      .from(denialFacts)
      .where(eq(denialFacts.denialFactId, denialFactId))
      .limit(1)
      .pipe(Effect.mapError((cause) => storeUnavailable("recordDenialFact", cause)));
    const fact = rows[0];
    if (fact === undefined) {
      return yield* new DenialFactNotFound({
        denialFactId,
        message: "The command exists without its required denial fact",
      });
    }
    return yield* decodeRow(DenialFact, fact, "recordDenialFact");
  });

const readErasureReceiptWithDatabase = (database: DirectoryDatabase, receiptId: ErasureReceiptId) =>
  Effect.gen(function* () {
    const rows = yield* database
      .select({
        manifestDigest: erasureReceipts.manifestDigest,
        receiptId: erasureReceipts.receiptId,
        recordedAt: erasureReceipts.recordedAt,
        resourceId: erasureReceipts.resourceId,
        scope: erasureReceipts.scope,
      })
      .from(erasureReceipts)
      .where(eq(erasureReceipts.receiptId, receiptId))
      .limit(1)
      .pipe(Effect.mapError((cause) => storeUnavailable("readErasureReceipt", cause)));
    const receipt = rows[0];
    if (receipt === undefined) {
      return yield* new ErasureReceiptNotFound({
        message: "No independent Erasure Receipt exists for the receipt identity",
        receiptId,
      });
    }
    return yield* decodeRow(ErasureReceipt, receipt, "readErasureReceipt");
  });

const toD1Statement = (database: DirectoryDatabase, query: DrizzleQuery) => {
  const compiled = query.toSQL();
  return database.$client.unsafe(compiled.sql, compiled.params);
};

const identityCreated = (input: CreateIdentityInput): IdentityCreated => ({
  agentId: input.agentId,
  allowancePeriodId: input.allowancePeriodId,
  knowledgeSpaceId: input.knowledgeSpaceId,
  plan: "free",
  subscriptionId: input.subscriptionId,
  threadId: input.threadId,
  userId: input.userId,
});

const denialFactFromInput = (input: RecordDenialFactInput): DenialFact => ({
  denialFactId: input.denialFactId,
  kind: input.kind,
  occurredAt: input.occurredAt,
  resourceId: input.resourceId,
  userId: input.userId,
});

const erasureReceiptFromInput = (input: RecordErasureReceiptInput): ErasureReceipt => ({
  manifestDigest: input.manifestDigest,
  receiptId: input.receiptId,
  recordedAt: input.recordedAt,
  resourceId: input.resourceId,
  scope: input.scope,
});
