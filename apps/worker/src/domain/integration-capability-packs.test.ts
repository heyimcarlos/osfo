import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { ManifestVersion } from "../domain";
import { resolveManifest } from "./integration-manifest";

const expectedOperations = [
  ["gmail", "gmail-v1", "GMAIL_SEARCH_EMAILS", "GMAIL_FETCH_EMAILS", "read"],
  ["gmail", "gmail-v1", "GMAIL_FETCH_THREAD", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "read"],
  ["gmail", "gmail-v1", "GMAIL_SEND_EMAIL", "GMAIL_SEND_EMAIL", "effect"],
  ["googlecalendar", "calendar-v1", "CALENDAR_LIST_EVENTS", "GOOGLECALENDAR_EVENTS_LIST", "read"],
  [
    "googlecalendar",
    "calendar-v1",
    "CALENDAR_FIND_AVAILABILITY",
    "GOOGLECALENDAR_FIND_FREE_SLOTS",
    "read",
  ],
  [
    "googlecalendar",
    "calendar-v1",
    "CALENDAR_CREATE_EVENT",
    "GOOGLECALENDAR_CREATE_EVENT",
    "effect",
  ],
  [
    "googlecalendar",
    "calendar-v1",
    "CALENDAR_UPDATE_EVENT",
    "GOOGLECALENDAR_PATCH_EVENT",
    "effect",
  ],
  [
    "googlecalendar",
    "calendar-v1",
    "CALENDAR_DELETE_EVENT",
    "GOOGLECALENDAR_DELETE_EVENT",
    "effect",
  ],
  ["googledrive", "drive-v1", "DRIVE_SEARCH", "GOOGLEDRIVE_FIND_FILE", "read"],
  ["googledrive", "drive-v1", "DRIVE_GET_METADATA", "GOOGLEDRIVE_GET_FILE_METADATA", "read"],
  ["googledrive", "drive-v1", "DRIVE_READ_FILE", "GOOGLEDRIVE_DOWNLOAD_FILE", "read"],
  ["googledrive", "drive-v1", "DRIVE_DELIVER_ARTIFACT", "GOOGLEDRIVE_UPLOAD_FILE", "effect"],
] as const;

describe("curated integration capability packs", () => {
  it("publishes only the reviewed current provider operations", () => {
    for (const [
      toolkit,
      manifestVersion,
      operation,
      providerTool,
      operationKind,
    ] of expectedOperations) {
      expect(
        Result.getOrThrow(
          resolveManifest({
            manifestVersion: ManifestVersion.make(manifestVersion),
            operation,
            toolkit,
          }),
        ),
      ).toMatchObject({ operationKind, providerTool });
    }

    for (const removed of [
      ["gmail", "gmail-v1", "GMAIL_CREATE_DRAFT"],
      ["googledrive", "drive-v1", "GOOGLEDRIVE_CREATE_PERMISSION"],
      ["googledrive", "drive-v1", "GOOGLEDRIVE_DELETE_FILE"],
    ] as const) {
      expect(
        Result.isFailure(
          resolveManifest({
            manifestVersion: ManifestVersion.make(removed[1]),
            operation: removed[2],
            toolkit: removed[0],
          }),
        ),
      ).toBe(true);
    }
  });

  it("requires exact Approval for every Calendar mutation and Drive delivery", () => {
    for (const operation of [
      "CALENDAR_CREATE_EVENT",
      "CALENDAR_UPDATE_EVENT",
      "CALENDAR_DELETE_EVENT",
    ]) {
      expect(
        Result.getOrThrow(
          resolveManifest({
            manifestVersion: ManifestVersion.make("calendar-v1"),
            operation,
            toolkit: "googlecalendar",
          }),
        ).consequences,
      ).not.toEqual([]);
    }
    expect(
      Result.getOrThrow(
        resolveManifest({
          manifestVersion: ManifestVersion.make("drive-v1"),
          operation: "DRIVE_DELIVER_ARTIFACT",
          toolkit: "googledrive",
        }),
      ).consequences,
    ).toEqual(["accessOrOwnershipChange"]);
  });

  it("keeps one-call reads bounded and Drive delivery within the 5 MB provider limit", () => {
    expect(
      Result.getOrThrow(
        resolveManifest({
          manifestVersion: ManifestVersion.make("gmail-v1"),
          operation: "GMAIL_SEARCH_EMAILS",
          toolkit: "gmail",
        }),
      ).hardBounds,
    ).toMatchObject({ maximumRecords: 20, providerExecutions: 1 });
    expect(
      Result.getOrThrow(
        resolveManifest({
          manifestVersion: ManifestVersion.make("drive-v1"),
          operation: "DRIVE_DELIVER_ARTIFACT",
          toolkit: "googledrive",
        }),
      ).hardBounds,
    ).toMatchObject({ maximumRequestBytes: 5_000_000n, mutations: 1 });
  });

  it("binds Calendar recurrence changes to one exact provider event identity", () => {
    const deletion = Result.getOrThrow(
      resolveManifest({
        manifestVersion: ManifestVersion.make("calendar-v1"),
        operation: "CALENDAR_DELETE_EVENT",
        toolkit: "googlecalendar",
      }),
    );

    expect(
      Result.isSuccess(
        deletion.decodeInput({
          calendarId: "primary",
          eventId: "recurring-event",
          sendNotifications: false,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isSuccess(
        deletion.decodeInput({
          calendarId: "primary",
          eventId: "recurring-event_20260901T140000Z",
          sendNotifications: false,
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        deletion.decodeInput({
          calendarId: "primary",
          eventId: "recurring-event",
          recurringScope: "series",
          sendNotifications: false,
        }),
      ),
    ).toBe(true);
  });

  it("requires ordered offset-aware Calendar windows and explicit mutation boundaries", () => {
    const list = Result.getOrThrow(
      resolveManifest({
        manifestVersion: ManifestVersion.make("calendar-v1"),
        operation: "CALENDAR_LIST_EVENTS",
        toolkit: "googlecalendar",
      }),
    );
    const create = Result.getOrThrow(
      resolveManifest({
        manifestVersion: ManifestVersion.make("calendar-v1"),
        operation: "CALENDAR_CREATE_EVENT",
        toolkit: "googlecalendar",
      }),
    );
    const update = Result.getOrThrow(
      resolveManifest({
        manifestVersion: ManifestVersion.make("calendar-v1"),
        operation: "CALENDAR_UPDATE_EVENT",
        toolkit: "googlecalendar",
      }),
    );

    expect(
      Result.isFailure(
        list.decodeInput({
          calendarId: "primary",
          endsAt: "2026-08-28T09:00:00",
          maximumEvents: 10,
          startsAt: "2026-08-28T10:00:00",
          timeZone: "America/Toronto",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        create.decodeInput({
          attendeeCount: 1,
          calendarId: "primary",
          endsAt: "2026-08-28T11:00:00-04:00",
          recurrence: null,
          sendNotifications: false,
          startsAt: "2026-08-28T10:00:00-04:00",
          timeZone: "America/Toronto",
          title: "Unapproved attendee",
        }),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        update.decodeInput({
          calendarId: "primary",
          changes: { startsAt: "2026-08-28T10:00:00-04:00" },
          eventId: "event-1",
          sendNotifications: false,
        }),
      ),
    ).toBe(true);
  });

  it("confines owned Drive artifact delivery to the User's private My Drive root", () => {
    const delivery = Result.getOrThrow(
      resolveManifest({
        manifestVersion: ManifestVersion.make("drive-v1"),
        operation: "DRIVE_DELIVER_ARTIFACT",
        toolkit: "googledrive",
      }),
    );
    expect(
      Result.isFailure(
        delivery.decodeInput({
          artifactId: "artifact-1",
          expectedBytes: 3,
          fileName: "report.pdf",
          mediaType: "application/pdf",
          targetFolderId: "arbitrary-shared-folder",
        }),
      ),
    ).toBe(true);
  });
});
