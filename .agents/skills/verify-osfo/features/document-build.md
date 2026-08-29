# Build a document

Document Build turns one or more existing User-owned File IDs into a bounded PDF or DOCX. Under `launch-v1`, the Free Plan has no Document Build entitlement: its request must be denied before source resolution, persistence, Workflow hosting, artifact or provider work, and accounting. The Adventurer Plan exposes the capability. A successful build retains an immutable source snapshot before Cloudflare acceptance, validates one stable pending artifact, commits accounting and publication in order, and follows up with safe status rather than private result content.

`shared-usage-v1` does not create a verifier exception or local Free admission. It may expose Document Build only after the normal versioned Authorization policy activates it.

## Sub-features

- authenticated UTF-8 text-file ingress through the ordinary owning Agent File lifecycle;
- one safe linked-channel denial while the User is still launch-v1 Free;
- ordinary Adventurer start without Approval and safe status inspection;
- stable main and timer Workflow identities;
- exact immutable source digest and owned File snapshot;
- validated pending artifact becoming the same final published Content ID;
- launch-v1 Workflow-start, provider-cost, and generated-document evidence;
- terminal product truth before one delivered Agent follow-up;
- authenticated document download only after successful publication;
- permanent deletion of source, artifact, compute evidence, follow-up, wake-up, and Workflow obligations.

## How to get to it (user POV)

After registration and the single Telegram linking attempt, upload a small `.txt` source on the authenticated Agent dashboard and copy the visible ready File ID. While the User is still launch-v1 Free, ask the linked Agent to build a PDF from that exact File ID and capture the safe denial. Prove zero effects before changing billing. Upgrade the same User to the Adventurer Plan, ask for the build again, and inspect the returned Workflow ID.

## Driving it with Chrome

1. Complete [registration](registration.md) and [channel linking](channel-linking.md) in the first Chrome tab. Run `channel-invite` exactly once; do not request another Telegram invitation.
2. On the authenticated Agent dashboard in that tab, choose `Choose text file` and select a small UTF-8 `.txt` fixture containing no private data. Wait for `Ready. File ID:` and copy the visible ID. This real browser upload is the only source ingress for both attempts. Keep the original authenticated Agent dashboard tab mounted with the ready File ID visible until the paid action screenshot.
3. Start `document-build-free-denial` evidence. Capture the visible ready File ID as `document-build-free-denial/action.png`. Run `control-osfo document-build-free-denial <run-id> <file-id>` exactly once. This command sends one natural request through the linked Telegram webhook and records the Agent's safe reply; it does not seed a FileRecord or call the Document Build service directly. The local model must first select the eligible `document-build@system-document-build-v1` Skill through `loadSkill`, then select `startDocumentBuild` with the single configured Free action identity. The checkpoint fails before returning if either selection is absent or repeated.
4. Open the exact `inbox=` URL printed by the command in a temporary second Chrome tab. Keep the dashboard tab mounted. This run-owned local provider inbox is the browser verification boundary for Telegram delivery. It renders the run identity and the actual Telegram ledger entries over loopback HTTP; it is not an application route or generated evidence text. Require the exact safe reply `Document Build is not available on your current plan.` It must not contain an internal policy name, denial reason, action identity, or Workflow ID. Capture it as `document-build-free-denial/result.png`; record the result with the phrase `launch-v1 Free safe denial`. Close the inbox tab and return to the original dashboard tab.
5. Before changing billing, run `observe <run-id> document-build-free-denial` and finish that evidence. The observer must find the uploaded source but no candidate main or timer Workflow instance, no accepted Document Build row, no artifact/attempt/owner object, no document provider-operation or Usage Event fact, and zero `workflowStarts`, `generatedDocuments`, and vendor cost for the run User. Stop the drive if this checkpoint fails.
6. Open a second Chrome tab in the same Chrome session and complete the browser-owned Adventurer upgrade in [billing](billing.md) for the same User. After the Adventurer paid state is visible, close or leave the billing tab. Return to the original dashboard tab and require the same `Ready. File ID:` value to remain visible. Start `document-build` evidence there and capture that ready File ID as `action.png`. Run `control-osfo telegram-reply <run-id> "Build a PDF from uploaded File ID <file-id>."` once. The verifier gives this paid attempt an action identity distinct from the Free denial without changing either natural request body.
7. Wait for the Agent acknowledgement containing one stable Document Build Workflow ID. Run `control-osfo telegram-reply <run-id> "Inspect Document Build <workflow-id> status."` once.
8. Wait for the linked Agent to report `success`, the same artifact Content ID, and no safe failure code. Open the dashboard's `Document Build notifications`, require one terminal completion card, and choose `Download PDF`. The authenticated response must download a valid nonempty PDF.
9. Capture the terminal card as `document-build/result.png`, record both screenshots, run `observe <run-id> document-build`, and finish its evidence.
10. Continue to [account deletion](account-deletion.md). Its observer must prove the Document Build PostgreSQL graph, Agent source, R2 source/artifact/attempt/owner objects, accounting, notifications, and executable Workflow obligations are gone.

PASS requires the completed Free denial checkpoint followed by one successful Adventurer PDF build within 60 minutes; a ready owning-Agent source snapshot matching the exact snapshot in `request_json`; distinct accepted main and timer instance identities; one stable artifact Content ID across preview storage and success; accounted R2 content, attempt, and ownership objects; one launch Workflow-start, one generated-document fact, and one stable provider-cost fact for the paid build only; terminal product truth before exactly one delivered terminal notification; a successful authenticated browser download; and no second Telegram linking attempt.

## Gotchas

- Browser upload currently supports only bounded UTF-8 `text/plain`; it is a real File ingress, not a test route and not a claim of Telegram attachment support.
- Observe and finish the Free denial before the billing upgrade. The observer intentionally rejects an Adventurer User or any accepted/costly Document Build effect.
- Never reuse the Free checkpoint command for the Adventurer request. It configures one single-use denied action identity at the isolated local provider boundary without adding verifier text to the User's request.
- The local provider inbox at `/inbox` is the human-readable Telegram delivery boundary. Its message text comes from the provider's delivery ledger, and its run identity comes from the provider process environment.
- `PreviewReady` is a progress milestone for the same pending artifact. It never exposes a download, even if that notification row is later joined to a successful build.
- The terminal follow-up contains only safe lifecycle facts. It never sends document content through Telegram or WhatsApp.
- Do not seed a FileRecord or invoke Document Build directly. A direct request is qualification, not this browser proof.
