# Read chat attachments and fill an interactive PDF

This drive covers the document portion of #340. Use only the supplied synthetic
fixtures. Appointment booking, official eligibility advice, encrypted forms,
scanned-form overlays and external provider acceptance need separate proof.

The preparation commands below retain `draft` evidence. They do not create an
`observation-passed.txt` marker or enable `evidence finish`. Complete this drive on
an exact integrated build with the connected messenger attachment hook, a model
boundary that selects tools from actual returned File evidence, and the ordinary
generated-document download affordance. A canned reply or HTTP 200 does not
complete any of those steps.

## Prepare

1. Complete [registration](registration.md) and [channel linking](channel-linking.md)
   in the run's authenticated Chrome profile. Keep the same User and Channel Link.
   Run `doctor` at the exact launch commit.
2. Run `control-osfo chat-pdf-form-prepare <run-id>`. It creates a synthetic facts
   PDF, rasterizes its first page to a JPEG, and creates an interactive template.
   It registers those JPEG/PDF bytes only with the existing loopback provider.
   It does not upload a File or seed an Agent record. Registration enables the
   bounded local model fixture for these two exact requests. It selects tools
   from actual ready File references and uses returned quotes, field outcomes,
   template exports and download URLs. Missing evidence stops the fixture.
   Inspect the fixture render and save it with the run evidence before delivery.

Telegram photo envelopes normalize to `image/jpeg` in the installed adapter.
The helper therefore sends actual `evidence.jpg` bytes and records that file's
digest and MIME type. The emulator rejects a mismatched fixture during preparation;
File MIME validation remains unchanged.

The fixture manifest retains source digests and expected edits. The source says
`Applicant name: Example Applicant` and `Document date: 03/04/2026`. Date order
is unspecified; expiry date is absent. The User's later instruction selects
`Renewal` and permits contact. Neither choice is inferred from the document.
The editable controls are above a separate office-only section. Each radio
widget has its own visible label and matching canonical export (`New` or
`Renewal`). Numeric exports with a separate `/Opt` label mapping are not covered;
stop if inspection does not expose the requested canonical export. This fixture
does not qualify arbitrary government forms.

Before an integrated drive, run
`bash .agents/skills/verify-osfo/helpers/chat-pdf-form-container.test.sh <built-document-sandbox-image>`.
This uses the supplied image's production Python inspector and fill engine,
checks protected fields and exact exports, and reopens the filled bytes through
the verifier. It does not build an image or establish browser/OCR proof.

## Drive the conversation

1. Save `chat-pdf-form/action.png` with the linked User and synthetic image ready.
   Run `control-osfo chat-pdf-form-send <run-id> image` once. This sends a real
   authenticated Telegram photo envelope through the production webhook and
   retains its exact bytes and HTTP result. Open the printed local inbox in Chrome.
2. Wait for the actual Agent reply. Require the server-owned ready File ID,
   `readFile` output with page 1 OCR provenance, and `validateFileFields` evidence
   supporting the literal name and date. The reply must preserve `03/04/2026`,
   explain that its date order needs confirmation, and report the expiry date as
   unknown. Save the visible reply and actual tool results. A literal occurrence
   proves neither date meaning nor eligibility. Stop on a guessed interpretation.
3. Check the User's current document entitlement. The launch Free plan permits
   File reading but has no document generation allowance. If needed, complete
   the [test Stripe browser upgrade](billing.md) and observe the active
   paid plan before sending the template. Do not seed a plan or change limits.
4. Run `control-osfo chat-pdf-form-send <run-id> template` once. Its retained
   caption supplies the contact and service choices and tells the Agent to leave
   unknown, signature and office-only fields untouched. Require `inspectPdfForm`
   to read the current owned ready PDF and its actual digest and export values.
   Require `generateDocument` to use that exact template reference, page count and
   selected edits through the ordinary document lifecycle.
5. Wait for the actual terminal reply and User-visible document link. Follow that
   link in the authenticated Chrome profile and save the resulting download.
   Require the exact server-returned `downloadUrl` in the channel reply. Its
   `/documents/download?contentId=...` page must retain the same Content ID and
   link to the authenticated `/documents/export?contentId=...` response. Verify
   sign-in resumes this exact document path when needed. Manually constructing
   an export URL qualifies transport only; it does not prove the chat presented
   a usable link. A Document Build card belongs to a different feature and cannot substitute for this ordinary result.
6. Save `chat-pdf-form/result.png` showing the completed result and download link.
   Run `control-osfo chat-pdf-form-capture <run-id>`. It saves the actual model
   and Telegram ledgers, requires one exact `generateDocument` result and its
   URL in a delivered message, then writes `generated-result.json`. Retain its
   original `content` and `downloadUrl`, including Content ID, byte length and
   raw 64-digit SHA-256 digest; do not reconstruct the reference.
   Run `control-osfo chat-pdf-form-inspect <run-id> <download-path> <generated-result-path>`.
   This checks the returned URL's run origin and Content ID, compares the
   downloaded bytes against the retained digest/length, reads
   canonical text and widget states with pdf-lib, and renders the downloaded PDF.
   Inspect `downloaded-page.png` and save a visible-facts note. The command still
   records `draft`; byte correctness alone does not establish this User journey.

The resulting form must visibly contain `Example Applicant`, the unchanged date
literal, contact export `Agreed`, and service `Renewal`. `UnknownDate` and the
signature stay blank; `OfficeUseOnly=Reserved` and read-only
`LockedReference=Retained` stay unchanged. Check both canonical values and the
visible checkbox/radio appearances. A missing/uncertain fact remains unfilled.

## Observe authority, replay and deletion

Wait for the actual normal reply before starting an Agent runtime observer. That
observer temporarily restarts Wrangler against the same storage and can interrupt
an unfinished reply. Use the existing observer and PostgreSQL helpers on the
run-owned state; preserve source and artifact evidence before account deletion.

Retain the two original File identities, owner and Session, source byte digests,
normalization state and page evidence. Match `provenance.sourceSha256` to the
retained source and fixture bytes. Match the form template digest in the committed
generation request to the owned PDF. Match the final Content ID, accounted artifact
metadata and downloaded bytes. A text reply containing fixture values is insufficient.

Replay the exact retained provider envelope and the original typed Action through
the supported recovery boundary. A newly phrased request is a new Action. Require
the same File/Content identities and no second generation or Usage Event. Preserve
the original owner, period and action identity in accounting. PDF generation follows
its normal policy; if an operation requires Approval, replay its exact retained
approved Action rather than constructing an authorization context in the verifier.

Prove another User cannot read the original Files or download the artifact. Revoke
the original Channel Link and prove a new request cannot use its former authority.
Run [account deletion](account-deletion.md) last and retain evidence that source,
normalization, artifact and executable obligations are removed while unrelated
sentinels survive. Save actual denials and committed state; a written assertion
that access is scoped is not evidence.

This feature becomes PASS only after the integrated Chrome drive, downloaded-byte
inspection, source/provenance matching, exact replay/accounting checks and deletion
observations all agree at one clean commit. Until a dedicated committed-state
observer covers those checks, report the completed preparation or qualification
steps as `draft` and name the remaining proof. Direct provider qualification is
recorded separately from this local emulator journey.
