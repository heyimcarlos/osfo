/* oxlint-disable eslint/no-underscore-dangle, typescript/consistent-return -- Usage states and generator failures use Effect's discriminator and typed error channel. */
import { encodeBrowserRequest, type BrowserRequest } from "@osfo/api/browser-host";
import { Clock, DateTime, Effect, Result, Schema, Semaphore } from "effect";

import {
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ManifestVersion,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
  ResourcePriceVersion,
} from "../domain";
import type { AllowanceItem, AllowanceSource } from "../domain/allowance";
import { hostedBrowserPrice, rateHostedBrowserDuration } from "../domain/browser-price";
import { retainedCatalog } from "../domain/plan-policy";
import { rate } from "../domain/usage";
import type { UsageEvent } from "../domain/usage-event";
import { HostedBrowserProvider } from "./hosted-browser-provider";

export const taskLifetimeMilliseconds = 600_000;
export const maximumLifetimeMilliseconds = 1_200_000;
export const admissionVendorUsdMicros = 30_000n;

export const Admission = Schema.Struct({
  allowancePeriodId: AllowancePeriodId,
  planPolicyVersion: PlanPolicyVersion,
  capabilityCatalogVersion: CapabilityCatalogVersion,
  modelAccessPolicyVersion: ModelAccessPolicyVersion,
  manifestVersion: Schema.NullOr(ManifestVersion),
});
export type Admission = typeof Admission.Type;

export interface Storage {
  // oxlint-disable-next-line osfo/no-unknown-returns -- Durable Object storage is decoded by this owning adapter.
  readonly get: (key: string) => Promise<unknown>;
  // oxlint-disable-next-line osfo/no-unknown-parameters -- The platform storage port accepts values whose schema this adapter owns.
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly list: (options: { readonly prefix: string }) => Promise<Map<string, unknown>>;
}

export interface Settlement {
  readonly allowancePeriodId: AllowancePeriodId;
  readonly ownerUserId: string;
  readonly source: AllowanceSource;
  readonly items: ReadonlyArray<AllowanceItem>;
  readonly durationMilliseconds: number;
  readonly usageEvent: UsageEvent | null;
}

export interface Options {
  readonly storage: Storage;
  readonly ownerUserId: string;
  readonly now?: Effect.Effect<number>;
  readonly admit: (
    request: BrowserRequest,
  ) => Effect.Effect<Admission, HostedBrowserProvider.Unavailable>;
  readonly record: (evidence: Settlement) => Effect.Effect<void, HostedBrowserProvider.Unavailable>;
}

const Duration = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumLifetimeMilliseconds }),
);
const Receipt = Schema.Struct({
  ...Admission.fields,
  ownerUserId: Schema.String,
  taskId: Schema.String,
  request: Schema.String,
  startedAt: Schema.Int,
  rootOperationId: Schema.String,
  resourcePriceVersion: Schema.Literal(hostedBrowserPrice.resourcePriceVersion),
  useful: Schema.Boolean,
  state: Schema.TaggedUnion({
    Reserved: {},
    Pending: { durationMilliseconds: Duration },
    Recorded: { durationMilliseconds: Duration },
  }),
});
type Receipt = typeof Receipt.Type;
const prefix = "hosted-browser:usage:";
const key = (taskId: string) => `${prefix}${taskId}`;
const locks = new WeakMap<Storage, Semaphore.Semaphore>();
const unavailable = HostedBrowserProvider.unavailable;
const boundary = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: unavailable });

/** Reserve before dispatch; persist final evidence before its idempotent Allowance write. */
export const make = (options: Options) => {
  const existingLock = locks.get(options.storage);
  const lock = existingLock ?? Semaphore.makeUnsafe(1);
  if (existingLock === undefined) locks.set(options.storage, lock);
  const now = options.now ?? Clock.currentTimeMillis;
  const put = (receipt: Receipt) =>
    boundary(() => options.storage.put(key(receipt.taskId), receipt));
  // oxlint-disable-next-line osfo/no-unknown-parameters -- Decode retained storage at its owning boundary.
  const decode = (raw: unknown) =>
    Schema.decodeUnknownEffect(Receipt)(raw).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((receipt) =>
        receipt.ownerUserId === options.ownerUserId
          ? Effect.succeed(receipt)
          : Effect.fail(unavailable()),
      ),
    );

  const settle = Effect.fn("HostedBrowserUsage.settle")(function* (
    receipt: Receipt,
    durationMilliseconds: number,
  ) {
    if (receipt.state._tag === "Recorded") return;
    const pending: Receipt =
      receipt.state._tag === "Reserved"
        ? { ...receipt, state: { _tag: "Pending", durationMilliseconds } }
        : receipt;
    if (pending.state._tag !== "Pending") return yield* unavailable();
    yield* put(pending);
    const quantity = rateHostedBrowserDuration(pending.state.durationMilliseconds);
    const source = { sourceId: pending.taskId, sourceType: "HostedBrowserSession" };
    const usageEvent = yield* usageEventFor(
      pending,
      quantity,
      source,
      pending.state.durationMilliseconds,
    );
    yield* options.record({
      allowancePeriodId: pending.allowancePeriodId,
      ownerUserId: pending.ownerUserId,
      source,
      items: [
        {
          allowanceKind: "vendorUsdMicros",
          basis: "conservative",
          quantity,
        },
      ],
      durationMilliseconds: pending.state.durationMilliseconds,
      usageEvent,
    });
    yield* put({
      ...pending,
      state: { _tag: "Recorded", durationMilliseconds: pending.state.durationMilliseconds },
    });
  });

  const start = Effect.fn("HostedBrowserUsage.start")(function* (request: BrowserRequest) {
    if (request.ownerUserId !== options.ownerUserId || request.command._tag !== "Open")
      return yield* unavailable();
    const encoded = encodeBrowserRequest(request);
    const raw = yield* boundary(() => options.storage.get(key(request.taskId)));
    if (raw !== undefined) {
      const receipt = yield* decode(raw);
      if (receipt.request !== encoded) return yield* unavailable();
      return;
    }
    yield* reconcile();
    const retained = yield* boundary(() => options.storage.list({ prefix }));
    const receipts = yield* Effect.forEach(Array.from(retained.values()), decode);
    if (receipts.some((receipt) => receipt.state._tag !== "Recorded")) return yield* unavailable();
    const admission = yield* options.admit(request);
    const startedAt = yield* now;
    // A crash after this write may hide an accepted create. Retain the full reservation.
    yield* put({
      ...admission,
      ownerUserId: options.ownerUserId,
      taskId: request.taskId,
      request: encoded,
      startedAt,
      rootOperationId: request.turnId,
      resourcePriceVersion: hostedBrowserPrice.resourcePriceVersion,
      useful: false,
      state: { _tag: "Reserved" },
    });
  });

  const observed = Effect.fn("HostedBrowserUsage.observed")(function* (taskId: string) {
    const raw = yield* boundary(() => options.storage.get(key(taskId)));
    const receipt = yield* decode(raw);
    if (receipt.useful) return;
    if (receipt.state._tag !== "Reserved") return yield* unavailable();
    yield* put({ ...receipt, useful: true });
  });

  const cancel = Effect.fn("HostedBrowserUsage.cancel")(function* (taskId: string) {
    const raw = yield* boundary(() => options.storage.get(key(taskId)));
    if (raw === undefined) return;
    const receipt = yield* decode(raw);
    if (receipt.state._tag === "Recorded" && receipt.state.durationMilliseconds === 0) return;
    if (receipt.state._tag !== "Reserved" || receipt.useful) return yield* unavailable();
    yield* put({ ...receipt, state: { _tag: "Recorded", durationMilliseconds: 0 } });
  });

  const close = Effect.fn("HostedBrowserUsage.close")(function* (taskId: string) {
    const raw = yield* boundary(() => options.storage.get(key(taskId)));
    if (raw === undefined) return yield* unavailable();
    const receipt = yield* decode(raw);
    const time = yield* now;
    yield* settle(
      receipt,
      Math.min(maximumLifetimeMilliseconds, Math.max(0, time - receipt.startedAt)),
    );
  });

  const reconcile = Effect.fn("HostedBrowserUsage.reconcile")(function* () {
    const rows = yield* boundary(() => options.storage.list({ prefix }));
    const time = yield* now;
    yield* Effect.forEach(
      Array.from(rows.values()),
      (raw) =>
        decode(raw).pipe(
          Effect.flatMap((receipt) =>
            receipt.state._tag === "Pending" ||
            (receipt.state._tag === "Reserved" &&
              time >= receipt.startedAt + maximumLifetimeMilliseconds)
              ? settle(receipt, maximumLifetimeMilliseconds)
              : Effect.void,
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  const nextExpiry = Effect.fn("HostedBrowserUsage.nextExpiry")(function* () {
    const rows = yield* boundary(() => options.storage.list({ prefix }));
    const receipts = yield* Effect.forEach(Array.from(rows.values()), decode);
    const time = yield* now;
    const deadlines = receipts.flatMap((receipt) =>
      receipt.state._tag === "Recorded"
        ? []
        : [
            receipt.state._tag === "Pending"
              ? time + 60_000
              : receipt.startedAt + maximumLifetimeMilliseconds,
          ],
    );
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  });

  return {
    start: (request: BrowserRequest) => lock.withPermit(start(request)),
    close: (taskId: string) => lock.withPermit(close(taskId)),
    observed: (taskId: string) => lock.withPermit(observed(taskId)),
    cancel: (taskId: string) => lock.withPermit(cancel(taskId)),
    reconcile: () => lock.withPermit(reconcile()),
    nextExpiry: () => lock.withPermit(nextExpiry()),
  };
};

const usageEventFor = Effect.fn("HostedBrowserUsage.usageEventFor")(function* (
  receipt: Receipt,
  quantity: bigint,
  source: AllowanceSource,
  durationMilliseconds: number,
): Effect.fn.Return<UsageEvent | null, HostedBrowserProvider.Unavailable> {
  if (receipt.planPolicyVersion === "launch-v1") return null;
  const rated = rate(
    [],
    [
      {
        activity: "webAndResearch",
        ratedCostUsdMicros: quantity,
        resourcePriceVersion: ResourcePriceVersion.make(receipt.resourcePriceVersion),
      },
    ],
    retainedCatalog,
    receipt.planPolicyVersion,
  );
  if (Result.isFailure(rated)) return yield* unavailable();
  return {
    allowancePeriodId: receipt.allowancePeriodId,
    capabilityCatalogVersion: receipt.capabilityCatalogVersion,
    manifestVersion: receipt.manifestVersion,
    modelAccessPolicyVersion: receipt.modelAccessPolicyVersion,
    usagePolicyVersion: receipt.planPolicyVersion,
    rootOperationId: receipt.rootOperationId,
    source,
    occurredAt: DateTime.toDateUtc(DateTime.makeUnsafe(receipt.startedAt + durationMilliseconds)),
    evidenceReferences: [{ kind: "companyCost", reference: receipt.taskId }],
    // Useful page evidence does not establish completion of the User's wider task.
    outcome: receipt.useful ? { _tag: "UsefulPartial", charge: rated.success } : { _tag: "Failed" },
  };
});

export * as HostedBrowserUsage from "./hosted-browser-usage";
