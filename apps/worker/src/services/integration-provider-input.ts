import { Schema } from "effect";

import {
  CalendarAvailabilityInput,
  CalendarCreateEventInput,
  CalendarDeleteEventInput,
  CalendarListEventsInput,
  CalendarUpdateEventInput,
  DriveDeliverArtifactInput,
  DriveGetMetadataInput,
  DriveReadFileInput,
  DriveSearchInput,
  GmailFetchThreadInput,
  GmailMessageInput,
  GmailSearchInput,
  type ResolvedIntegrationManifestOperation,
} from "../domain/integration-manifest";

/** Closed provider payload vocabulary reachable from the curated integration manifests. */
export type ProviderInput =
  | {
      readonly ids_only: false;
      readonly include_payload: false;
      readonly include_spam_trash: false;
      readonly max_results: number;
      readonly query: string;
      readonly user_id: "me";
      readonly verbose: false;
    }
  | {
      readonly body: string;
      readonly extra_recipients?: ReadonlyArray<string>;
      readonly is_html: false;
      readonly recipient_email: string;
      readonly subject: string;
      readonly user_id: "me";
    }
  | { readonly thread_id: string; readonly user_id: "me" }
  | {
      readonly calendarId: string;
      readonly maxResults: number;
      readonly showDeleted: false;
      readonly singleEvents: true;
      readonly timeMax: string;
      readonly timeMin: string;
      readonly timeZone: string;
    }
  | {
      readonly calendar_expansion_max: 1;
      readonly group_expansion_max: 1;
      readonly items: readonly [string];
      readonly time_max: string;
      readonly time_min: string;
      readonly timezone: string;
    }
  | {
      readonly attendees: readonly [];
      readonly calendar_id: string;
      readonly create_meeting_room: false;
      readonly end_datetime: string;
      readonly exclude_organizer: true;
      readonly recurrence?: ReadonlyArray<string>;
      readonly send_updates: "none";
      readonly start_datetime: string;
      readonly summary: string;
      readonly timezone: string;
      readonly visibility: "private";
    }
  | ({
      readonly calendar_id: string;
      readonly event_id: string;
      readonly send_updates: "none";
    } & CalendarPatchInput)
  | {
      readonly calendar_id: string;
      readonly event_id: string;
      readonly send_updates: "none";
    }
  | {
      readonly corpora: "user";
      readonly fields: "files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed)";
      readonly includeItemsFromAllDrives: false;
      readonly pageSize: number;
      readonly q: string;
      readonly spaces: "drive";
      readonly supportsAllDrives: false;
    }
  | {
      readonly fields: "id,name,mimeType,size,modifiedTime,webViewLink";
      readonly fileId: string;
      readonly supportsAllDrives: true;
    }
  | { readonly fileId: string; readonly mime_type: string }
  | {
      readonly file_to_upload: {
        readonly mimetype: string;
        readonly name: string;
        readonly s3key: string;
      };
      readonly folder_to_upload_to: null;
    };

export interface ProviderExecutionConstraints {
  readonly maximumDownloadBytes?: number;
}

/** Translate one already-decoded manifest input into its exact provider payload. */
export const providerInputFor = (
  manifest: ResolvedIntegrationManifestOperation,
  input: Schema.Json,
): ProviderInput => {
  switch (manifest.operation) {
    case "GMAIL_SEARCH_EMAILS": {
      const value = Schema.decodeUnknownSync(GmailSearchInput)(input);
      return {
        ids_only: false,
        include_payload: false,
        include_spam_trash: value.includeSpamTrash,
        max_results: value.maximumMessages,
        query: value.query,
        user_id: "me",
        verbose: false,
      };
    }
    case "GMAIL_FETCH_THREAD": {
      const value = Schema.decodeUnknownSync(GmailFetchThreadInput)(input);
      return { thread_id: value.threadId, user_id: "me" };
    }
    case "GMAIL_SEND_EMAIL": {
      const value = Schema.decodeUnknownSync(GmailMessageInput)(input);
      const [recipient, ...extraRecipients] = value.recipients;
      const common = {
        body: value.body,
        is_html: false,
        recipient_email: recipient,
        subject: value.subject,
        user_id: "me",
      } as const;
      return extraRecipients.length === 0
        ? common
        : { ...common, extra_recipients: extraRecipients };
    }
    case "CALENDAR_LIST_EVENTS": {
      const value = Schema.decodeUnknownSync(CalendarListEventsInput)(input);
      return {
        calendarId: value.calendarId,
        maxResults: value.maximumEvents,
        showDeleted: false,
        singleEvents: true,
        timeMax: value.endsAt,
        timeMin: value.startsAt,
        timeZone: value.timeZone,
      };
    }
    case "CALENDAR_FIND_AVAILABILITY": {
      const value = Schema.decodeUnknownSync(CalendarAvailabilityInput)(input);
      return {
        calendar_expansion_max: 1,
        group_expansion_max: 1,
        items: [value.calendarId],
        time_max: value.endsAt,
        time_min: value.startsAt,
        timezone: value.timeZone,
      };
    }
    case "CALENDAR_CREATE_EVENT": {
      const value = Schema.decodeUnknownSync(CalendarCreateEventInput)(input);
      const common = {
        attendees: [],
        calendar_id: value.calendarId,
        create_meeting_room: false,
        end_datetime: value.endsAt,
        exclude_organizer: true,
        send_updates: "none",
        start_datetime: value.startsAt,
        summary: value.title,
        timezone: value.timeZone,
        visibility: "private",
      } as const;
      const recurrence = calendarRecurrence(value.recurrence);
      return recurrence === undefined ? common : { ...common, recurrence };
    }
    case "CALENDAR_UPDATE_EVENT": {
      const value = Schema.decodeUnknownSync(CalendarUpdateEventInput)(input);
      return {
        calendar_id: value.calendarId,
        event_id: value.eventId,
        send_updates: "none",
        ...calendarPatchInput(value.changes),
      };
    }
    case "CALENDAR_DELETE_EVENT": {
      const value = Schema.decodeUnknownSync(CalendarDeleteEventInput)(input);
      return { calendar_id: value.calendarId, event_id: value.eventId, send_updates: "none" };
    }
    case "DRIVE_SEARCH": {
      const value = Schema.decodeUnknownSync(DriveSearchInput)(input);
      return {
        corpora: "user",
        fields: "files(id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,trashed)",
        includeItemsFromAllDrives: false,
        pageSize: value.maximumFiles,
        q: `name contains '${escapeDriveSearchLiteral(value.query)}' and 'me' in owners and trashed = false`,
        spaces: "drive",
        supportsAllDrives: false,
      };
    }
    case "DRIVE_GET_METADATA": {
      const value = Schema.decodeUnknownSync(DriveGetMetadataInput)(input);
      return {
        fields: "id,name,mimeType,size,modifiedTime,webViewLink",
        fileId: value.fileId,
        supportsAllDrives: true,
      };
    }
    case "DRIVE_READ_FILE": {
      const value = Schema.decodeUnknownSync(DriveReadFileInput)(input);
      return { fileId: value.fileId, mime_type: value.expectedMediaType };
    }
    case "DRIVE_DELIVER_ARTIFACT": {
      const value = Schema.decodeUnknownSync(DriveDeliverArtifactInput)(input);
      return {
        file_to_upload: {
          mimetype: value.mediaType,
          name: value.fileName,
          s3key: value.artifactId,
        },
        folder_to_upload_to: value.targetFolderId,
      };
    }
    default:
      throw new Error(`Unsupported retained integration operation: ${manifest.operation}`);
  }
};

export const providerConstraintsFor = (
  manifest: ResolvedIntegrationManifestOperation,
  input: Schema.Json,
): ProviderExecutionConstraints | undefined =>
  manifest.operation === "DRIVE_READ_FILE"
    ? { maximumDownloadBytes: Schema.decodeUnknownSync(DriveReadFileInput)(input).maximumBytes }
    : undefined;

interface CalendarPatchInput {
  description?: string;
  end_time?: string;
  location?: string;
  recurrence?: ReadonlyArray<string>;
  start_time?: string;
  summary?: string;
  timezone?: string;
}

const calendarPatchInput = (
  changes: typeof CalendarUpdateEventInput.Type.changes,
): CalendarPatchInput => {
  const patch: CalendarPatchInput = {};
  if (changes.description !== undefined) patch.description = changes.description;
  if (changes.endsAt !== undefined) patch.end_time = changes.endsAt;
  if (changes.location !== undefined) patch.location = changes.location;
  if (changes.recurrence !== undefined)
    patch.recurrence = calendarRecurrence(changes.recurrence) ?? [];
  if (changes.startsAt !== undefined) patch.start_time = changes.startsAt;
  if (changes.timeZone !== undefined) patch.timezone = changes.timeZone;
  if (changes.title !== undefined) patch.summary = changes.title;
  return patch;
};

const calendarRecurrence = (
  recurrence: typeof CalendarCreateEventInput.Type.recurrence,
): ReadonlyArray<string> | undefined =>
  recurrence === null
    ? undefined
    : [
        `RRULE:FREQ=${recurrence.frequency};INTERVAL=${recurrence.interval};COUNT=${recurrence.count}`,
      ];

const escapeDriveSearchLiteral = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
