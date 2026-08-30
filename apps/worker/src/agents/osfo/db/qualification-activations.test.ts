import { describe, expect, it } from "@effect/vitest";

import { qualificationActivationCause } from "./qualification-activations";

describe("qualification activation cause", () => {
  it("classifies the first admitted request only from complete initialization state", () => {
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-1",
        currentDeploymentVersionId: "version-1",
        firstUseClaimed: true,
        historyComplete: true,
        state: {
          lastActivationId: null,
          lastDeploymentVersionId: null,
          requestCount: 0,
        },
      }),
    ).toBe("firstUse");
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-1",
        currentDeploymentVersionId: "version-1",
        firstUseClaimed: false,
        historyComplete: false,
        state: null,
      }),
    ).toBeNull();
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-1",
        currentDeploymentVersionId: "version-1",
        firstUseClaimed: false,
        historyComplete: true,
        state: {
          lastActivationId: null,
          lastDeploymentVersionId: null,
          requestCount: 0,
        },
      }),
    ).toBeNull();
  });

  it("does not call a qualification request first-use after an ordinary admitted request", () => {
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-1",
        currentDeploymentVersionId: "version-1",
        firstUseClaimed: false,
        historyComplete: true,
        state: {
          lastActivationId: "activation-1",
          lastDeploymentVersionId: "version-1",
          requestCount: 1,
        },
      }),
    ).toBe("warm");
  });

  it("requires the same activation identity for warm and a changed version for deployment", () => {
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-1",
        currentDeploymentVersionId: "version-1",
        firstUseClaimed: false,
        historyComplete: true,
        state: {
          lastActivationId: "activation-1",
          lastDeploymentVersionId: "version-1",
          requestCount: 1,
        },
      }),
    ).toBe("warm");
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-2",
        currentDeploymentVersionId: "version-2",
        firstUseClaimed: false,
        historyComplete: true,
        state: {
          lastActivationId: "activation-1",
          lastDeploymentVersionId: "version-1",
          requestCount: 1,
        },
      }),
    ).toBe("deployment");
  });

  it("keeps a same-version new activation and missing version metadata unknown", () => {
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-2",
        currentDeploymentVersionId: "version-1",
        firstUseClaimed: false,
        historyComplete: true,
        state: {
          lastActivationId: "activation-1",
          lastDeploymentVersionId: "version-1",
          requestCount: 1,
        },
      }),
    ).toBeNull();
    expect(
      qualificationActivationCause({
        currentActivationId: "activation-2",
        currentDeploymentVersionId: null,
        firstUseClaimed: false,
        historyComplete: true,
        state: {
          lastActivationId: "activation-1",
          lastDeploymentVersionId: "version-1",
          requestCount: 1,
        },
      }),
    ).toBeNull();
  });
});
