# Send a scheduled email

Scheduled Email retains one exact Gmail message and send time behind one Approval, sleeps durably, rechecks live authority, sends once, accounts for the admitted Workflow and Gmail effect, and delivers one safe terminal follow-up.

This drive proves the local Gmail provider boundary, not live Gmail OAuth. The loopback provider is enabled only by the run-owned development configuration and exercises the production Integration boundary deterministically.

## Driving it with Chrome

1. Complete [registration](registration.md), upgrade to Adventurer through [billing](billing.md), and complete [channel linking](channel-linking.md) in the same Chrome tab.
2. Open `/settings/integrations` and reuse the run's **Connected** Gmail card. If Gmail is not connected, choose **Connect Gmail**, complete the run-owned provider form in Chrome, and return to a visible **Connected** Gmail card.
3. If this run also includes [Immediate Gmail](immediate-gmail-send.md), complete its browser Approval, result recording, and successful `observe` first. Then start Scheduled Email evidence, which resets the shared Integration provider ledger. The helper rejects this start when Immediate Gmail action/result evidence exists without `observation-passed.txt`. Run `control-osfo scheduled-email-request <run-id>` once; this sends the strict run-owned request through the linked Agent rather than calling the service directly.
4. Refresh the Scheduled Emails section. Require one card showing the exact recipient, subject, message body, primary Gmail mailbox, and ISO send time. Capture `action.png` with the **Approve exact Scheduled Email** action visible, then choose it once.
5. After the scheduled time, refresh until the terminal card says **Scheduled Email sent**. Capture `result.png` with its Workflow ID, record both screenshots, run `observe scheduled-email`, and finish evidence.
6. Continue to [account deletion](account-deletion.md) so run-owned Integration and Workflow state is removed. If the run includes Immediate Gmail, use [retained account-deletion replay](account-deletion-replay.md), then finish the deferred Immediate Gmail evidence with its deletion receipt.

PASS requires one exact Approval presentation, one retained Workflow row and completed Workflow host, an applied provider log/resource identity, ordered timestamps within the 60-second due-to-send, 2-minute send-to-terminal, and 60-second terminal-to-follow-up objectives, one accepted terminal follow-up, one Workflow-start fact, one observed Gmail-send fact, and exactly one matching local provider send with no duplicate.

## Gotchas

- The provider connect form is a real Chrome action across the configured Integration boundary. It does not claim live Gmail OAuth coverage.
- Refreshing the approval or status lists is safe. Approve only the exact run-owned presentation once.
- If the exact send time has passed before Approval, discard the run and begin a fresh one.
