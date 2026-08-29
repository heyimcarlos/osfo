import { describe, expect, it } from "@effect/vitest";

import { qualificationChecksum } from "./qualification-checksum";

describe("qualification checksum", () => {
  it("produces a canonical collision-resistant digest independent of key insertion order", () => {
    const first = qualificationChecksum({ nested: { a: 1, b: 2 }, value: 3n });
    const reordered = qualificationChecksum({ value: 3n, nested: { b: 2, a: 1 } });

    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(reordered).toBe(first);
    expect(qualificationChecksum({ nested: { a: 1, b: 3 }, value: 3n })).not.toBe(first);
  });
});
