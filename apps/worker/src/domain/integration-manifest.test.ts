import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { ManifestVersion } from "../domain";
import { parseManifestCatalog, resolveManifest } from "./integration-manifest";

describe("Integration Capability Manifests", () => {
  it("resolves only an exact immutable operation and manifest version", () => {
    const resolved = resolveManifest({
      manifestVersion: ManifestVersion.make("gmail-v1"),
      operation: "GMAIL_FETCH_THREAD",
      toolkit: "gmail",
    });
    expect(Result.getOrThrow(resolved)).toMatchObject({
      consequences: [],
      exhaustedMode: { _tag: "EmailThread", maximumMessages: 20 },
      hardBounds: {
        maximumRecords: 20,
        maximumResponseBytes: 65_536n,
        mutations: 0,
        providerExecutions: 1,
      },
      manifestVersion: ManifestVersion.make("gmail-v1"),
      outputContract: "gmailThreadV1",
      providerTool: "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      safeErrors: [
        "connectionUnavailable",
        "inputRejected",
        "notFound",
        "providerRateLimited",
        "providerUnavailable",
        "resultInvalid",
      ],
    });
    expect(
      Result.isFailure(
        resolveManifest({
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_UNKNOWN",
          toolkit: "gmail",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        resolveManifest({
          manifestVersion: ManifestVersion.make("gmail-v2"),
          operation: "GMAIL_FETCH_THREAD",
          toolkit: "gmail",
        }),
      ),
    ).toBe(true);
  });

  it("pins every Osfo operation to one direct provider tool and never exposes provider meta tools", () => {
    const expected = new Map([
      ["GMAIL_SEARCH_EMAILS", "GMAIL_FETCH_EMAILS"],
      ["GMAIL_FETCH_THREAD", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"],
      ["GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL"],
      ["CALENDAR_LIST_EVENTS", "GOOGLECALENDAR_EVENTS_LIST"],
      ["CALENDAR_FIND_AVAILABILITY", "GOOGLECALENDAR_FIND_FREE_SLOTS"],
      ["CALENDAR_CREATE_EVENT", "GOOGLECALENDAR_CREATE_EVENT"],
      ["CALENDAR_UPDATE_EVENT", "GOOGLECALENDAR_PATCH_EVENT"],
      ["CALENDAR_DELETE_EVENT", "GOOGLECALENDAR_DELETE_EVENT"],
      ["DRIVE_SEARCH", "GOOGLEDRIVE_FIND_FILE"],
      ["DRIVE_GET_METADATA", "GOOGLEDRIVE_GET_FILE_METADATA"],
      ["DRIVE_READ_FILE", "GOOGLEDRIVE_DOWNLOAD_FILE"],
      ["DRIVE_DELIVER_ARTIFACT", "GOOGLEDRIVE_UPLOAD_FILE"],
    ]);

    for (const [operation, providerTool] of expected) {
      const manifestVersion = operation.startsWith("GMAIL_")
        ? "gmail-v1"
        : operation.startsWith("CALENDAR_")
          ? "calendar-v1"
          : "drive-v1";
      const toolkit = operation.startsWith("GMAIL_")
        ? "gmail"
        : operation.startsWith("CALENDAR_")
          ? "googlecalendar"
          : "googledrive";
      expect(
        Result.getOrThrow(
          resolveManifest({
            manifestVersion: ManifestVersion.make(manifestVersion),
            operation,
            toolkit,
          }),
        ).providerTool,
      ).toBe(providerTool);
    }
    expect([...expected.values()]).not.toContain("COMPOSIO_SEARCH_TOOLS");
    expect([...expected.values()]).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect([...expected.values()].some((tool) => /WORKBENCH|BASH|SANDBOX/u.test(tool))).toBe(false);
  });

  it("keeps approval consequence-based across providers", () => {
    expect(
      Result.getOrThrow(
        resolveManifest({
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEND_EMAIL",
          toolkit: "gmail",
        }),
      ).consequences,
    ).toEqual(["externalCommunication"]);
    expect(
      Result.getOrThrow(
        resolveManifest({
          manifestVersion: ManifestVersion.make("calendar-v1"),
          operation: "CALENDAR_CREATE_EVENT",
          toolkit: "googlecalendar",
        }),
      ).consequences,
    ).toEqual(["futureOrRecurringExternalEffect"]);
    expect(
      Result.getOrThrow(
        resolveManifest({
          manifestVersion: ManifestVersion.make("calendar-v1"),
          operation: "CALENDAR_UPDATE_EVENT",
          toolkit: "googlecalendar",
        }),
      ).consequences,
    ).toEqual(["destructionOrOverwrite"]);
  });

  it("rejects unknown manifest fields at the trust boundary", () => {
    const result = parseManifestCatalog({ manifests: [], surprise: true });
    expect(Result.isFailure(result)).toBe(true);
  });

  it("decodes provider input and completed evidence through operation-owned bounds", () => {
    const manifest = Result.getOrThrow(
      resolveManifest({
        manifestVersion: ManifestVersion.make("gmail-v1"),
        operation: "GMAIL_FETCH_THREAD",
        toolkit: "gmail",
      }),
    );

    expect(
      Result.isSuccess(
        manifest.decodeInput({
          includeAttachments: false,
          maximumMessages: 20,
          threadId: "thread-1",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        manifest.decodeInput({
          includeAttachments: false,
          maximumMessages: 21,
          threadId: "thread-1",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        manifest.decodeCompletedEvidence({
          _tag: "CompletedIntegrationRead",
          providerLogIds: ["execution-1"],
          records: 20,
          responseBytes: 65_536n,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        manifest.decodeCompletedEvidence({
          _tag: "CompletedIntegrationRead",
          providerLogIds: ["execution-1"],
          providerPayload: { secret: "must not persist" },
          records: 20,
          responseBytes: 65_536n,
        }),
      ),
    ).toBe(true);
  });

  it("gives every retained operation an executable input and evidence contract", () => {
    const cases = [
      {
        evidence: {
          _tag: "CompletedIntegrationRead",
          providerLogIds: ["gmail-read"],
          records: 20,
          responseBytes: 65_536n,
        },
        identity: {
          manifestVersion: "gmail-v1",
          operation: "GMAIL_FETCH_THREAD",
          toolkit: "gmail",
        },
        input: { includeAttachments: false, maximumMessages: 20, threadId: "thread-1" },
      },
      ...["GMAIL_SEND_EMAIL"].map((operation) => ({
        evidence: {
          _tag: "CompletedIntegrationEffect",
          mutations: 1,
          providerLogId: `gmail-effect:${operation}`,
          providerResourceId: "message-1",
        },
        identity: { manifestVersion: "gmail-v1", operation, toolkit: "gmail" },
        input: { body: "Message body", recipients: ["person@example.test"], subject: "Subject" },
      })),
      {
        evidence: {
          _tag: "CompletedIntegrationRead",
          providerLogIds: ["calendar-read"],
          records: 10,
          responseBytes: 65_536n,
        },
        identity: {
          manifestVersion: "calendar-v1",
          operation: "CALENDAR_LIST_EVENTS",
          toolkit: "googlecalendar",
        },
        input: {
          calendarId: "primary",
          endsAt: "2026-09-14T00:00:00Z",
          maximumEvents: 10,
          startsAt: "2026-09-01T00:00:00Z",
          timeZone: "America/Toronto",
        },
      },
      {
        evidence: {
          _tag: "CompletedIntegrationEffect",
          mutations: 1,
          providerLogId: "calendar-create",
          providerResourceId: "event-created",
        },
        identity: {
          manifestVersion: "calendar-v1",
          operation: "CALENDAR_CREATE_EVENT",
          toolkit: "googlecalendar",
        },
        input: {
          attendeeCount: 0,
          calendarId: "primary",
          endsAt: "2026-09-01T13:00:00Z",
          recurrence: null,
          sendNotifications: false,
          startsAt: "2026-09-01T12:00:00Z",
          timeZone: "America/Toronto",
          title: "Private event",
        },
      },
      {
        evidence: {
          _tag: "CompletedIntegrationEffect",
          mutations: 1,
          providerLogId: "calendar-update",
          providerResourceId: "event-1",
        },
        identity: {
          manifestVersion: "calendar-v1",
          operation: "CALENDAR_UPDATE_EVENT",
          toolkit: "googlecalendar",
        },
        input: {
          calendarId: "primary",
          changes: {
            endsAt: "2026-09-01T14:00:00Z",
            startsAt: "2026-09-01T13:00:00Z",
            timeZone: "America/Toronto",
          },
          eventId: "event-1",
          sendNotifications: false,
        },
      },
      {
        evidence: {
          _tag: "CompletedIntegrationRead",
          providerLogIds: ["drive-read"],
          records: 1,
          responseBytes: 16_384n,
        },
        identity: {
          manifestVersion: "drive-v1",
          operation: "DRIVE_GET_METADATA",
          toolkit: "googledrive",
        },
        input: { fileId: "file-1" },
      },
    ] as const;

    for (const contract of cases) {
      const manifest = Result.getOrThrow(
        resolveManifest({
          ...contract.identity,
          manifestVersion: ManifestVersion.make(contract.identity.manifestVersion),
        }),
      );
      expect(Result.isSuccess(manifest.decodeInput(contract.input))).toBe(true);
      expect(Result.isSuccess(manifest.decodeCompletedEvidence(contract.evidence))).toBe(true);
    }
  });
});
