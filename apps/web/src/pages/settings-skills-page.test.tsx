// @vitest-environment happy-dom
/* oxlint-disable effecttsgo/async-function -- Testing Library owns browser Promises. */

import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime, Effect } from "effect";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type SettingsSkillsDependencies,
  SettingsSkillsFailure,
  SkillsSettingsContent,
  SettingsSkillsPage,
} from "./settings-skills-page";

afterEach(cleanup);

const skill = {
  availability: { state: "available" },
  behavior: "Put the summary before the details.",
  canUndo: true,
  capabilities: ["Generate one bounded PDF or DOCX."],
  lastUsedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-26T12:00:00.000Z")),
  purpose: "Prepare the weekly report.",
  reference: "private-skill-id",
  revisionReference: "private-version-id",
  status: "active",
} as const;

const deletion = {
  actionId: "skill-delete:private-skill-id:private-version-id",
  confirmation: "delete-this-skill",
  consequence: "Permanently delete this Skill, its previous revisions, and its learning history.",
  expectedRevision: "private-version-id",
  reference: "private-skill-id",
  title: "Delete Prepare the weekly report.",
  version: "personal-skill-delete-v1",
} as const;

const dependencies = (
  inspect: SettingsSkillsDependencies["inspect"],
): SettingsSkillsDependencies => ({
  change: (input) =>
    Effect.succeed({
      notice: input.change === "restore" ? "Skill restored." : "Skill archived.",
      skill: {
        ...skill,
        revisionReference: `${input.expectedRevision}-next`,
        status: input.change === "restore" ? "active" : "archived",
      },
    }),
  delete: () => Effect.succeed({ status: "deleted" }),
  inspect,
  presentDeletion: () => Effect.succeed(deletion),
});

describe("SkillsSettingsContent", () => {
  it("shows the empty state without developer-oriented Skill internals", () => {
    const html = renderToStaticMarkup(
      <SkillsSettingsContent
        busyReference={null}
        notice={null}
        skills={[]}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("No Skills yet");
    expect(html).toContain("Osfo will tell you when it learns a reusable preference");
    expect(html).not.toContain("Markdown");
    expect(html).not.toContain("version");
    expect(html).not.toContain("prompt");
  });

  it("shows plain-language active, unavailable, and archived controls without internal references", () => {
    const html = renderToStaticMarkup(
      <SkillsSettingsContent
        busyReference={null}
        notice="Latest Skill change undone."
        onChange={() => undefined}
        onDelete={() => undefined}
        skills={[
          {
            availability: { state: "available" },
            behavior: "Put the summary before the details.",
            canUndo: true,
            capabilities: ["Generate one bounded PDF or DOCX."],
            lastUsedAt: DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-26T12:00:00.000Z")),
            purpose: "Prepare the weekly report.",
            reference: "private-skill-id",
            revisionReference: "private-version-id",
            status: "active",
          },
          {
            availability: {
              explanation:
                "This Skill needs an Integration Connection that is not connected right now.",
              state: "unavailable",
            },
            behavior: "Read the latest messages before drafting a reply.",
            canUndo: true,
            capabilities: ["Read Gmail."],
            lastUsedAt: null,
            purpose: "Draft inbox replies.",
            reference: "private-archived-id",
            revisionReference: "private-archived-version",
            status: "archived",
          },
        ]}
      />,
    );

    expect(html).toContain("Prepare the weekly report");
    expect(html).toContain("Put the summary before the details");
    expect(html).toContain("Available");
    expect(html).toContain("Integration Connection");
    expect(html).toContain("Archive");
    expect(html).toContain("Restore");
    expect(html).toContain("Undo latest change");
    expect(html).toContain("Delete");
    expect(html).not.toContain("private-skill-id");
    expect(html).not.toContain("private-version-id");
  });

  it("hides undo when the authority reports no safe target", () => {
    const html = renderToStaticMarkup(
      <SkillsSettingsContent
        busyReference={null}
        notice={null}
        onChange={() => undefined}
        skills={[{ ...skill, canUndo: false }]}
      />,
    );

    expect(html).not.toContain("Undo latest change");
  });

  it("keeps loading and failed inspection safe, then retries from the authority", async () => {
    const loading = render(<SettingsSkillsPage dependencies={dependencies(Effect.never)} />);
    expect(screen.getByText("Loading Skills...")).toBeDefined();
    loading.unmount();

    let attempts = 0;
    render(
      <SettingsSkillsPage
        dependencies={dependencies(
          Effect.suspend(() => {
            attempts += 1;
            return attempts === 1
              ? Effect.fail(
                  new SettingsSkillsFailure({ message: "The Skills authority is offline." }),
                )
              : Effect.succeed({ skills: [] });
          }),
        )}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("No Skills yet")).toBeDefined());
    expect(attempts).toBe(2);
  });

  it("round-trips lifecycle controls and restores focus after cancelling deletion", async () => {
    const changes: Array<unknown> = [];
    const approvals: Array<unknown> = [];
    const testDependencies: SettingsSkillsDependencies = {
      ...dependencies(Effect.succeed({ skills: [skill] })),
      change: (input) => {
        changes.push(input);
        return Effect.succeed({
          notice: input.change === "restore" ? "Skill restored." : "Skill archived.",
          skill: {
            ...skill,
            revisionReference:
              input.change === "restore" ? "private-version-restored" : "private-version-next",
            status: input.change === "restore" ? "active" : "archived",
          },
        });
      },
      delete: (approval) => {
        approvals.push(approval);
        return Effect.succeed({ status: "deleted" });
      },
    };
    render(<SettingsSkillsPage dependencies={testDependencies} />);
    await waitFor(() => expect(screen.getByText("Prepare the weekly report.")).toBeDefined());

    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(screen.getByText("Skill archived.")).toBeDefined());
    expect(changes).toEqual([
      {
        change: "archive",
        expectedRevision: "private-version-id",
        reference: "private-skill-id",
      },
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByText("Skill restored.")).toBeDefined());
    expect(changes).toEqual([
      {
        change: "archive",
        expectedRevision: "private-version-id",
        reference: "private-skill-id",
      },
      {
        change: "restore",
        expectedRevision: "private-version-next",
        reference: "private-skill-id",
      },
    ]);

    const deleteTrigger = screen.getByRole("button", { name: "Delete" });
    await userEvent.click(deleteTrigger);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeDefined());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(deleteTrigger);

    await userEvent.click(deleteTrigger);
    await userEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(screen.getByText("No Skills yet")).toBeDefined());
    expect(approvals).toEqual([deletion]);
  });
});
