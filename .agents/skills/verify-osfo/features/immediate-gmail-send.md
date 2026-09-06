# Send an immediate Gmail message

Immediate Gmail send retains one exact primary-mailbox message behind an authenticated Approval, rechecks current authority immediately before the provider effect, reconciles the final outcome, and accounts for the effect once.

This drive proves the local Gmail provider boundary, not live Gmail OAuth. The loopback provider is enabled only by the run-owned development configuration and exercises the production Integration boundary deterministically.

## Driving it with Chrome

1. Complete [registration](registration.md), upgrade to Adventurer through [billing](billing.md), and complete [channel linking](channel-linking.md) in the same Chrome tab.
2. Open `/settings/integrations`, choose **Connect Gmail**, complete the run-owned provider form in Chrome, and return to a visible **Connected** Gmail card.
3. Start Immediate Gmail evidence. Run `control-osfo gmail-send-request <run-id>` once; this sends the strict run-owned request through the linked Agent rather than calling the service directly.
4. Refresh **Immediate Gmail Sends**. Require one card showing the exact recipient, subject, body, primary Gmail mailbox, Gmail manifest, and external-communication consequence. Capture `action.png` with **Approve exact Gmail send** visible. Before choosing it, record the exact visible Approval as structured evidence. Replace the three run-owned values in this JSON, then choose the button once:

   ```sh
   control-osfo record <run-id> immediate-gmail-send action '{"control":"Approve exact Gmail send","decision":"approve","visibleConsequence":"Send this exact message to the listed external recipients.","visibleFields":{"body":"<run-owned body>","gmailResource":"primary","manifestVersion":"gmail-v1","recipients":["<run-owned recipient>"],"subject":"<run-owned subject>"},"visibleTitle":"Send Gmail message"}'
   ```

5. Refresh until **Immediate Gmail send approved.** and **Gmail message sent** are visible. Refresh **Immediate Gmail Sends** once more. Require zero pending Approvals and one applied outcome card, capture `result.png`, then record the exact result:

   ```sh
   control-osfo record <run-id> immediate-gmail-send result '{"approvedNotice":"Immediate Gmail send approved.","outcome":"Gmail message sent","replayView":{"pendingApprovalCount":0,"terminalCardCount":1,"terminalStatus":"applied"}}'
   ```

6. Run `control-osfo observe <run-id> immediate-gmail-send` and require `observation-passed.txt`. This proves the live one-POST path and runs the same-commit composed replay qualification. Complete this step before starting [Scheduled Email evidence](scheduled-email.md), whose start resets the shared Integration provider ledger. Defer only Immediate Gmail `evidence finish`.
7. Complete any remaining feature drives, then continue through [retained account-deletion replay](account-deletion-replay.md), including its observer and evidence finish. Use the same disposable User. The deletion observer writes the captured Action's deletion receipt back to this feature.
8. Finish Immediate Gmail evidence. The helper requires exactly one provider revocation and deletion for the captured Connection, its direct absence, the unrelated Connection's unchanged ID, owner, and `ACTIVE` status, and an unchanged provider-send ledger before it writes `result=PASS`.

The locally qualified evidence requires one exact authenticated Approval presentation and decision, one applied local provider request/log/resource identity retained under the same terminal Action, one observed Gmail-send fact whose source is that exact Action, and one matching provider send. The live browser proof allows one Approval POST. The named same-commit composed journey separately submits that presentation a second time, requires rejection, and proves unchanged provider and accounting ledgers. The later retained-request deletion replay proves the User and Agent are absent from PostgreSQL and the Directory. A named same-commit store test separately proves that deletion erases every Immediate Gmail-owned key while preserving unrelated Agent storage.

The retained deletion receipt binds the provider Connection to the approved Action through its hashed Connection identity. It reads the loopback provider registry and authority-operation ledger directly after deletion. The receipt requires the target's exact revoke-then-delete pair, direct target absence, byte-for-byte equality of the unrelated Connection's ID, owner, and `ACTIVE` status, and an unchanged provider-send ledger.

## Gotchas

- Refreshing the Approval or status projection is safe. Approve only the exact run-owned presentation once in Chrome. The committed replay journey owns the deliberate second POST.
- The provider connect form is a real Chrome action across the configured Integration boundary. It does not claim live Gmail OAuth coverage.
- Immediate Gmail `observe` preserves the locally qualified proof. Finish retained account-deletion replay first, then return to `evidence <run-id> immediate-gmail-send finish` for the provider-deletion receipt.
