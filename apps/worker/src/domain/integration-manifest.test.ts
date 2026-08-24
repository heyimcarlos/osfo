import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { ManifestVersion } from "../domain";
import { parseManifestCatalog, resolveManifest } from "./integration-manifest";

describe("Integration Capability Manifests", () => {
  it("resolves only an exact immutable operation and manifest version", () => {
    const resolved = resolveManifest(
      "gmail",
      "GMAIL_FETCH_THREAD",
      ManifestVersion.make("gmail-v1"),
    );
    expect(Result.getOrThrow(resolved)).toMatchObject({
      consequences: [],
      exhaustedMode: { _tag: "EmailThread", maximumMessages: 20 },
      manifestVersion: ManifestVersion.make("gmail-v1"),
    });
    expect(
      Result.isFailure(resolveManifest("gmail", "GMAIL_UNKNOWN", ManifestVersion.make("gmail-v1"))),
    ).toBe(true);
    expect(
      Result.isFailure(
        resolveManifest("gmail", "GMAIL_FETCH_THREAD", ManifestVersion.make("gmail-v2")),
      ),
    ).toBe(true);
  });

  it("keeps approval consequence-based across providers", () => {
    expect(
      Result.getOrThrow(
        resolveManifest("gmail", "GMAIL_CREATE_DRAFT", ManifestVersion.make("gmail-v1")),
      ).consequences,
    ).toEqual([]);
    expect(
      Result.getOrThrow(
        resolveManifest("gmail", "GMAIL_SEND_EMAIL", ManifestVersion.make("gmail-v1")),
      ).consequences,
    ).toEqual(["externalCommunication"]);
    expect(
      Result.getOrThrow(
        resolveManifest(
          "googlecalendar",
          "CALENDAR_CREATE_PRIVATE",
          ManifestVersion.make("calendar-v1"),
        ),
      ).consequences,
    ).toEqual([]);
    expect(
      Result.getOrThrow(
        resolveManifest(
          "googlecalendar",
          "CALENDAR_UPDATE_EVENT",
          ManifestVersion.make("calendar-v1"),
        ),
      ).consequences,
    ).toEqual(["destructionOrOverwrite"]);
  });

  it("rejects unknown manifest fields at the trust boundary", () => {
    const result = parseManifestCatalog({ manifests: [], surprise: true });
    expect(Result.isFailure(result)).toBe(true);
  });
});
