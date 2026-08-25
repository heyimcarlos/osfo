/* oxlint-disable effecttsgo/strict-effect-provide -- it.effect is the entry point for this isolated Effect. */
/* oxlint-disable vitest/no-standalone-expect -- Assertions execute inside the Effect returned directly to it.effect. */
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { CapabilityCatalogVersion, UserId } from "../../domain";
import { Capabilities } from "../../services/capabilities";
import { CapabilityTurn } from "./capability-turn";

it.effect("publishes a loaded multi-Tool Skill on the next model step", () =>
  Effect.gen(function* () {
    const capabilities = Capabilities.make();
    const userId = UserId.make("capability-turn-user");
    const availableToolNames = ["exportDocument", "generateDocument", "loadSkill"];
    const index = yield* capabilities.eligibleIndex({
      availableIntegrationToolkits: [],
      availableRequirements: ["document-renderer", "file-storage", "personal-agent"],
      availableToolNames,
      catalogVersion: CapabilityCatalogVersion.make("governed-capabilities-v1"),
      declaredRequirements: [],
      origin: "authSession",
      personalSkills: [],
      plan: "free",
      taskDescription: "Create a PDF document",
      taskKinds: ["document"],
      userId,
    });
    const turn = CapabilityTurn.make({
      availableToolNames,
      baseInstructions: "Agent instructions",
      capabilities,
      index,
      loadedSkills: [],
      personalSkills: [],
      toolSchemas: [],
      userId,
    });

    expect(turn.step().activeToolNames).toEqual(["loadSkill"]);
    const loaded = yield* turn.loadSkill({
      skillId: "document-production",
      skillVersion: "system-document-production-v1",
    });
    expect(turn.step().activeToolNames).toEqual(["loadSkill"]);
    expect(turn.commitLoadedSkill(loaded)).toBe(true);

    const nextStep = turn.step();
    expect(nextStep.activeToolNames).toEqual(["exportDocument", "generateDocument", "loadSkill"]);
    expect(nextStep.instructions).toContain("# Document production");
  }),
);
