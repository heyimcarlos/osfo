// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "@effect/vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { SettingsChannelsPage } from "./settings-channels-page";

afterEach(cleanup);

describe("SettingsChannelsPage", () => {
  it("directs channel linking to a private messenger conversation", () => {
    render(<SettingsChannelsPage />);

    expect(screen.getByText(/Send Osfo a private message/u)).toBeDefined();
    expect(screen.getByText(/Links are never posted in group conversations/u)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
