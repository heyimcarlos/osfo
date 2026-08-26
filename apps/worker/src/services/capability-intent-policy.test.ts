import { describe, expect, it } from "@effect/vitest";

import { isDeletionOrDataRightsIntent } from "./capability-intent-policy";

describe("deletion and data-rights intent", () => {
  it("recognizes direct requests to forget remembered knowledge", () => {
    const requests = [
      "Please forget what you know about me",
      "Delete everything you remember about me",
      "Please remove all memories about me",
      "Erase everything you know about me",
      "Forget everything about me",
      "Remove your memories of me",
    ];

    expect(requests.map(isDeletionOrDataRightsIntent)).toEqual(requests.map(() => true));
  });

  it("does not admit ordinary discussion that shares deletion vocabulary", () => {
    const ordinaryMessages = [
      "Tell me what you know about me",
      "Help me remember what you know about me",
      "Please forget what you know about machine learning",
      "Delete everything you remember about writing the report",
      "Write a story about removing memories",
      "Summarize an article about erasing memories",
    ];

    expect(ordinaryMessages.map(isDeletionOrDataRightsIntent)).toEqual(
      ordinaryMessages.map(() => false),
    );
  });
});
