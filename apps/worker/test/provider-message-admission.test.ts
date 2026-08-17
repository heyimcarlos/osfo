import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import * as ProviderAdmission from "../src/services/provider-message-admission";

const acceptsIdentity = (_digest: ProviderAdmission.ProviderAdmissionIdentityDigest) => true;

describe("provider message admission identities", () => {
  it("keeps content and admission identity digests distinct", () => {
    const content = Schema.decodeSync(ProviderAdmission.ProviderContentDigest)("a".repeat(40));
    const identity = Schema.decodeSync(ProviderAdmission.ProviderAdmissionIdentityDigest)(
      "b".repeat(40),
    );

    expect(content).toBe("a".repeat(40));
    expect(identity).toBe("b".repeat(40));
    expect(() =>
      Schema.decodeSync(ProviderAdmission.ProviderContentDigest)("not-a-digest"),
    ).toThrow("Expected a string matching the pattern");

    // @ts-expect-error Content evidence cannot stand in for an admission identity digest.
    acceptsIdentity(content);
  });
});
