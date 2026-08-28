/* oxlint-disable effecttsgo/async-function, vitest/no-standalone-expect -- Cloudflare host stubs use the platform's Promise-only callback shape. */
import { describe, expect, it } from "@effect/vitest";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { Effect } from "effect";

import { DocumentBuild } from "../services/document-build";
import {
  matchesInstanceIdentity,
  requireRetryForRecoverableResult,
} from "./document-build-host-outcome";
import type { ExecutionResult } from "./document-build";
import {
  recoverableDocumentBuildStepConfig,
  runRecoverableMainOperation,
} from "./document-build-step";

describe("DocumentBuildWorkflow host outcomes", () => {
  it("retries ambiguous and interrupted compute instead of terminalizing", () => {
    expect(() => requireRetryForRecoverableResult({ failure: "recovery" })).toThrow(
      "reconciliation is pending",
    );
    expect(() => requireRetryForRecoverableResult({ failure: "unavailable" })).toThrow(
      "temporarily unavailable",
    );
  });

  it("returns already committed terminal truth", () => {
    expect(
      requireRetryForRecoverableResult({
        artifactContentId: null,
        state: "canceled",
        workflowId: DocumentBuild.WorkflowId.make("document-build:terminal"),
      }),
    ).toMatchObject({ state: "canceled" });
  });

  it("does not cache a recoverable step result and reruns the callback after it throws", async () => {
    const cache = new Map<string, ExecutionResult>();
    const configs = new Array<WorkflowStepConfig>();
    let callbacks = 0;
    const step = {
      do: async (
        name: string,
        config: WorkflowStepConfig,
        callback: () => Promise<ExecutionResult>,
      ) => {
        configs.push(config);
        const cached = cache.get(name);
        if (cached !== undefined) return cached;
        callbacks += 1;
        const result = await callback();
        cache.set(name, result);
        return result;
      },
    };
    let attempts = 0;
    const operation = () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? ({ failure: "unavailable" } as const)
          : ({
              artifactContentId: null,
              state: "success" as const,
              workflowId: DocumentBuild.WorkflowId.make("document-build:step-retry"),
            } as const),
      );
    };

    const runStep = () =>
      step.do(
        "authorize, render, validate, and publish document",
        recoverableDocumentBuildStepConfig,
        () => runRecoverableMainOperation(operation),
      );

    await expect(runStep()).rejects.toThrow("temporarily unavailable");
    expect(await runStep()).toMatchObject({ state: "success" });
    expect(await runStep()).toMatchObject({ state: "success" });
    expect(callbacks).toBe(2);
    expect(attempts).toBe(2);
    expect(configs).toEqual([
      recoverableDocumentBuildStepConfig,
      recoverableDocumentBuildStepConfig,
      recoverableDocumentBuildStepConfig,
    ]);
  });

  it.effect("rejects a payload delivered to a different main instance before product effects", () =>
    Effect.gen(function* () {
      const payload = DocumentBuild.WorkflowPayload.make({
        inputDigest: DocumentBuild.InputDigest.make("a".repeat(64)),
        workflowId: DocumentBuild.WorkflowId.make("document-build:host-identity"),
      });
      const identities = yield* DocumentBuild.cloudflareInstanceIdsFor(payload.workflowId);
      expect(yield* matchesInstanceIdentity("main", identities.main, payload)).toBe(true);
      expect(yield* matchesInstanceIdentity("main", identities.timer, payload)).toBe(false);
    }),
  );
});
