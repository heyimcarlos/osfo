/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside Effect tests. */
/* oxlint-disable typescript/consistent-return -- Test generator failures use Effect's typed error channel. */
import { expect, it } from "@effect/vitest";
import type { BrowserRequest } from "@osfo/api/browser-host";
import { Effect, Ref } from "effect";

import {
  AllowancePeriodId,
  CapabilityCatalogVersion,
  ModelAccessPolicyVersion,
  PlanPolicyVersion,
} from "../domain";
import { HostedBrowserProvider } from "./hosted-browser-provider";
import { HostedBrowserUsage } from "./hosted-browser-usage";

const request: BrowserRequest = {
  ownerUserId: "browser-owner",
  hostSessionId: "hosted:agent",
  taskId: "browser-task",
  operationId: "browser-open",
  turnId: "browser-turn",
  command: { _tag: "Open", url: "https://example.com" },
};
const period = AllowancePeriodId.make("browser-period");
const admission: HostedBrowserUsage.Admission = {
  allowancePeriodId: period,
  capabilityCatalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
  modelAccessPolicyVersion: ModelAccessPolicyVersion.make("model-access-v1"),
  planPolicyVersion: PlanPolicyVersion.make("launch-v1"),
  manifestVersion: null,
};

const fixture = Effect.gen(function* () {
  const rows = new Map<string, unknown>();
  const time = yield* Ref.make(1_000);
  const calls = yield* Ref.make<ReadonlyArray<HostedBrowserUsage.Settlement>>([]);
  const admissions = yield* Ref.make(0);
  const deny = yield* Ref.make(false);
  const failRecording = yield* Ref.make(false);
  const failStorage = yield* Ref.make(false);
  const policy = yield* Ref.make(admission.planPolicyVersion);
  const storage: HostedBrowserUsage.Storage = {
    get: (key) => Promise.resolve(rows.get(key)),
    put: (key, value) => {
      if (Ref.getUnsafe(failStorage)) return Promise.reject(new Error("storage unavailable"));
      rows.set(key, structuredClone(value));
      return Promise.resolve();
    },
    list: ({ prefix }) =>
      Promise.resolve(new Map(Array.from(rows).filter(([key]) => key.startsWith(prefix)))),
  };
  const make = () =>
    HostedBrowserUsage.make({
      storage,
      ownerUserId: request.ownerUserId,
      now: Ref.get(time),
      admit: () =>
        Effect.gen(function* () {
          yield* Ref.update(admissions, (count) => count + 1);
          if (yield* Ref.get(deny)) return yield* HostedBrowserProvider.unavailable();
          return { ...admission, planPolicyVersion: yield* Ref.get(policy) };
        }),
      record: (evidence) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (values) => [...values, evidence]);
          if (yield* Ref.get(failRecording)) return yield* HostedBrowserProvider.unavailable();
        }),
    });
  return { rows, time, calls, admissions, deny, failRecording, failStorage, policy, make };
});

it.effect("retains admission before provider dispatch without recording consumption", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().start(request);
    yield* f.make().start(request);
    expect(yield* Ref.get(f.admissions)).toBe(1);
    expect(yield* Ref.get(f.calls)).toEqual([]);
    expect(Array.from(f.rows.values())).toEqual([
      expect.objectContaining({ allowancePeriodId: period, state: { _tag: "Reserved" } }),
    ]);
  }),
);

it.effect("denies a new session before retaining a provider obligation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Ref.set(f.deny, true);
    yield* Effect.flip(f.make().start(request));
    expect(f.rows.size).toBe(0);
    expect(yield* Ref.get(f.calls)).toEqual([]);
  }),
);

it.effect("blocks another reservation until previous usage has settled", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const another = { ...request, taskId: "another-task", operationId: "another-open" };
    yield* f.make().start(request);
    yield* Effect.flip(f.make().start(another));
    expect(yield* Ref.get(f.admissions)).toBe(1);
    yield* Ref.set(f.time, 61_000);
    yield* Ref.set(f.failRecording, true);
    yield* Effect.flip(f.make().close(request.taskId));
    yield* Effect.flip(f.make().start(another));
    expect(yield* Ref.get(f.admissions)).toBe(1);
    yield* Ref.set(f.failRecording, false);
    yield* f.make().start(another);
    expect(yield* Ref.get(f.admissions)).toBe(2);
  }),
);

it.effect("serializes competing starts over the same durable storage", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const another = { ...request, taskId: "another-task", operationId: "another-open" };
    yield* Effect.all(
      [Effect.result(f.make().start(request)), Effect.result(f.make().start(another))],
      { concurrency: 2 },
    );
    expect(yield* Ref.get(f.admissions)).toBe(1);
    expect(f.rows.size).toBe(1);
  }),
);

it.effect("fails start if the pre-dispatch obligation cannot be stored", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Ref.set(f.failStorage, true);
    yield* Effect.flip(f.make().start(request));
    expect(f.rows.size).toBe(0);
  }),
);

it.effect("rejects changed request identities and another owner", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().start(request);
    yield* Effect.flip(f.make().start({ ...request, operationId: "changed" }));
    yield* Effect.flip(f.make().start({ ...request, ownerUserId: "someone-else" }));
    expect(yield* Ref.get(f.admissions)).toBe(1);
  }),
);

it.effect("records elapsed duration conservatively once against the original period", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().start(request);
    yield* Ref.set(f.time, 61_001);
    yield* f.make().close(request.taskId);
    yield* Ref.set(f.time, 80_000);
    yield* f.make().close(request.taskId);
    expect(yield* Ref.get(f.calls)).toEqual([
      {
        allowancePeriodId: period,
        ownerUserId: request.ownerUserId,
        source: { sourceId: request.taskId, sourceType: "HostedBrowserSession" },
        items: [{ allowanceKind: "vendorUsdMicros", basis: "conservative", quantity: 1_501n }],
        durationMilliseconds: 60_001,
        usageEvent: null,
      },
    ]);
  }),
);

it.effect("retries the same retained duration after the Allowance write fails", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().start(request);
    yield* Ref.set(f.time, 61_000);
    yield* Ref.set(f.failRecording, true);
    yield* Effect.flip(f.make().close(request.taskId));
    yield* Ref.set(f.failRecording, false);
    yield* Ref.set(f.time, 90_000);
    yield* f.make().reconcile();
    const calls = yield* Ref.get(f.calls);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]?.durationMilliseconds).toBe(60_000);
  }),
);

it.effect("settles uncertain provider contact only after the full bounded lifetime", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().start(request);
    expect(yield* f.make().nextExpiry()).toBe(
      1_000 + HostedBrowserUsage.maximumLifetimeMilliseconds,
    );
    yield* Ref.set(f.time, 1_000 + HostedBrowserUsage.maximumLifetimeMilliseconds - 1);
    yield* f.make().reconcile();
    expect(yield* Ref.get(f.calls)).toEqual([]);
    yield* Ref.set(f.time, 1_000 + HostedBrowserUsage.maximumLifetimeMilliseconds);
    yield* f.make().reconcile();
    yield* f.make().reconcile();
    expect(yield* f.make().nextExpiry()).toBeNull();
    expect(yield* Ref.get(f.calls)).toEqual([
      expect.objectContaining({
        durationMilliseconds: HostedBrowserUsage.maximumLifetimeMilliseconds,
        items: [
          {
            allowanceKind: "vendorUsdMicros",
            basis: "conservative",
            quantity: HostedBrowserUsage.admissionVendorUsdMicros,
          },
        ],
      }),
    ]);
  }),
);

it.effect("retains fixed evidence when acknowledgement persistence fails after billing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().start(request);
    const usage = HostedBrowserUsage.make({
      storage: {
        get: (key) => Promise.resolve(f.rows.get(key)),
        put: (key, value) => {
          if (Ref.getUnsafe(f.failStorage)) return Promise.reject(new Error("storage unavailable"));
          f.rows.set(key, structuredClone(value));
          return Promise.resolve();
        },
        list: ({ prefix }) =>
          Promise.resolve(new Map(Array.from(f.rows).filter(([key]) => key.startsWith(prefix)))),
      },
      ownerUserId: request.ownerUserId,
      now: Ref.get(f.time),
      admit: () => Effect.succeed(admission),
      record: (evidence) =>
        Ref.update(f.calls, (calls) => [...calls, evidence]).pipe(
          Effect.andThen(Ref.set(f.failStorage, true)),
        ),
    });
    yield* Ref.set(f.time, 41_000);
    yield* Effect.flip(usage.close(request.taskId));
    yield* Ref.set(f.failStorage, false);
    yield* Ref.set(f.time, 61_000);
    yield* f.make().reconcile();
    const calls = yield* Ref.get(f.calls);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
  }),
);

it.effect("rejects malformed retained usage instead of discarding the obligation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    f.rows.set("hosted-browser:usage:broken", { state: { _tag: "Reserved" } });
    yield* Effect.flip(f.make().reconcile());
    expect(f.rows.size).toBe(1);
    expect(yield* Ref.get(f.calls)).toEqual([]);
  }),
);

it.effect("rates useful browser duration against the pinned shared Usage policy", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Ref.set(f.policy, PlanPolicyVersion.make("shared-usage-v1"));
    yield* f.make().start(request);
    yield* f.make().observed(request.taskId);
    yield* Ref.set(f.policy, PlanPolicyVersion.make("launch-v1"));
    yield* Ref.set(f.time, 61_000);
    yield* Ref.set(f.failRecording, true);
    yield* Effect.flip(f.make().close(request.taskId));
    yield* Ref.set(f.failRecording, false);
    yield* Ref.set(f.time, 80_000);
    yield* f.make().reconcile();
    const calls = yield* Ref.get(f.calls);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[1]?.usageEvent).toMatchObject({
      allowancePeriodId: period,
      usagePolicyVersion: "shared-usage-v1",
      source: { sourceId: request.taskId, sourceType: "HostedBrowserSession" },
      outcome: {
        _tag: "UsefulPartial",
        charge: {
          planUsageMicros: 1_500n,
          ratedCostUsdMicros: 1_500n,
          components: [
            {
              activity: "webAndResearch",
              resourcePriceVersion: "browser-duration-prices-2026-09-06",
              ratedCostUsdMicros: 1_500n,
            },
          ],
        },
      },
    });
  }),
);

it.effect(
  "records uncertain failed creation as Company Cost without inventing useful shared Usage",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.set(f.policy, PlanPolicyVersion.make("shared-usage-v1"));
      yield* f.make().start(request);
      yield* Ref.set(f.time, 1_000 + HostedBrowserUsage.maximumLifetimeMilliseconds);
      yield* f.make().reconcile();
      const calls = yield* Ref.get(f.calls);
      expect(calls[0]?.items).toEqual([
        { allowanceKind: "vendorUsdMicros", basis: "conservative", quantity: 30_000n },
      ]);
      expect(calls[0]?.usageEvent?.outcome).toEqual({ _tag: "Failed" });
    }),
);

it.effect("releases proven uncontacted reservations without either kind of consumption", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().cancel("missing");
    yield* f.make().start(request);
    yield* f.make().cancel(request.taskId);
    yield* f.make().cancel(request.taskId);
    yield* f.make().reconcile();
    expect(yield* Ref.get(f.calls)).toEqual([]);
    expect(yield* f.make().nextExpiry()).toBeNull();
    yield* f.make().start({ ...request, taskId: "another-task", operationId: "another-open" });
    expect(yield* Ref.get(f.admissions)).toBe(2);
  }),
);

it.effect("refuses to cancel a session whose useful page evidence proves provider contact", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.make().start(request);
    yield* f.make().observed(request.taskId);
    yield* Effect.flip(f.make().cancel(request.taskId));
  }),
);
