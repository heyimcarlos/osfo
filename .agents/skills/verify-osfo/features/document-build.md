# Build a document

Document Build turns one or more existing User-owned File IDs into a bounded PDF or DOCX. Both Plans expose the capability. The build retains an immutable source snapshot before Cloudflare acceptance, validates one stable pending artifact, commits accounting and publication in order, and follows up with safe status rather than private result content.

## Sub-features

- authenticated UTF-8 text-file ingress through the ordinary owning Agent File lifecycle;
- ordinary start without Approval and safe status inspection;
- stable main and timer Workflow identities;
- exact immutable source digest and owned File snapshot;
- validated pending artifact becoming the same final published Content ID;
- launch-v1 Workflow-start, provider-cost, and generated-document evidence;
- terminal product truth before one delivered Agent follow-up;
- authenticated document download only after successful publication;
- permanent deletion of source, artifact, compute evidence, follow-up, wake-up, and Workflow obligations.

## How to get to it (user POV)

After registration and the single Telegram linking attempt, upload a small `.txt` source on the authenticated Agent dashboard. Copy the visible ready File ID. Ask the linked Agent to build a PDF from that exact File ID, then inspect the returned Workflow ID.

## Driving it with Chrome

1. Complete [registration](registration.md) and [channel linking](channel-linking.md) in one Chrome tab. Run `channel-invite` exactly once; do not request another Telegram invitation.
2. On the authenticated Agent dashboard, choose `Choose text file` and select a small UTF-8 `.txt` fixture containing no private data. Wait for `Ready. File ID:` and copy the visible ID.
3. Start Document Build evidence and capture the ready File ID as `action.png`. Run `control-osfo telegram-reply <run-id> "Build a PDF from supplied File ID <file-id>."` once. This sends a natural linked-channel message through the production Telegram webhook; it does not call the Document Build service directly.
4. Wait for the Agent acknowledgement containing one stable Document Build Workflow ID. Run `control-osfo telegram-reply <run-id> "Inspect Document Build <workflow-id> status."` once.
5. Wait for the linked Agent to report `success`, the same artifact Content ID, and no safe failure code. Open the dashboard's `Document Build notifications`, require one terminal completion card, and choose `Download PDF`. The authenticated response must download a valid nonempty PDF.
6. Capture the terminal card as `result.png`, record both screenshots, run `observe document-build`, and finish its evidence.
7. Continue to [account deletion](account-deletion.md). Its observer must prove the Document Build PostgreSQL graph, Agent source, R2 source/artifact/attempt/owner objects, accounting, notifications, and executable Workflow obligations are gone.

PASS requires one successful PDF build within 60 minutes; a ready owning-Agent source snapshot matching the exact snapshot in `request_json`; distinct accepted main and timer instance identities; one stable artifact Content ID across preview storage and success; accounted R2 content, attempt, and ownership objects; one launch Workflow-start, one generated-document fact, and one stable provider-cost fact; terminal product truth before exactly one delivered terminal notification; a successful authenticated browser download; and no second Telegram linking attempt.

## Gotchas

- Browser upload currently supports only bounded UTF-8 `text/plain`; it is a real File ingress, not a test route and not a claim of Telegram attachment support.
- `PreviewReady` is a progress milestone for the same pending artifact. It never exposes a download, even if that notification row is later joined to a successful build.
- The terminal follow-up contains only safe lifecycle facts. It never sends document content through Telegram or WhatsApp.
- Do not seed a FileRecord or invoke Document Build directly. A direct request is qualification, not this browser proof.
