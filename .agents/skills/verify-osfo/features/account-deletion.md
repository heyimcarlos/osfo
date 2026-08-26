# Delete an account

Account deletion permanently removes the authenticated User's account and User-scoped data after one exact destructive confirmation.

## Sub-features

- self-service deletion authority and exact Approval;
- immediate account fencing and signed-out completion;
- User-scoped Supermemory container deletion;
- whole Agent registry and facet deletion, observed through the production Directory RPC;
- R2 deletion of a run-owned trusted-evidence object under the User prefix;
- PostgreSQL deletion of the User, session, Agent route, Channel Link, billing, allowance, and pending Deletion Case;
- survival of unrelated provider and R2 sentinels.

## How to get to it (user POV)

After registration and Telegram channel linking, open `/settings/privacy`, choose `Delete Account`, read the permanent-deletion warning, and choose `Confirm account deletion`.

## Driving it with Chrome

1. Complete [registration](registration.md) and [channel linking](channel-linking.md) in the same Chrome tab.
2. Run `control-osfo seed-account-deletion <run-id>`. The helper records the run-owned User, Agent, and Channel Link; confirms the exact Agent through the production Directory RPC; and seeds target plus unrelated Supermemory and R2 evidence.
3. Start account-deletion evidence and open `/settings/privacy`. Before presentation, require the generic copy `Permanent account removal requires confirmation.`, one enabled `Delete Account` button, no permanent-deletion consequence, and no confirmation button. Choose `Delete Account` once.
4. Wait for exactly one server-presented consequence `Permanently delete this account and all of its data.` and the enabled `Confirm account deletion` button. Capture this state as `action.png`. Record the generic prefetch and exactly one server-owned consequence using those exact sentences.
5. Stop immediately before choosing `Confirm account deletion`. Obtain action-time confirmation that names the run-owned account, local Osfo destination, and permanent PostgreSQL, Agent SQLite, R2, provider-memory, session, and Channel Link effects. Keep the tab at this exact confirmation.
6. After confirmation, choose `Confirm account deletion` once. Wait for navigation to `/`, then require the signed-out `Sign in` and `Get started` links. Capture `result.png` and record that `Sign in and Get started` are visible.
7. Run `observe account-deletion` and finish the evidence.

PASS requires the generic prefetch state followed by exactly one canonical server consequence; exactly one total and one successful `GET /v1/account/deletion-action`, plus exactly one total and one successful `DELETE /v1/account`, in the actual Worker log; the signed-out home result; no run-owned PostgreSQL User graph, active session, or exact Agent in the production Directory registry/runtime; no target R2 object or target Supermemory container; exactly one target container deletion; and both unrelated sentinels still present. This is explicitly the one-click happy-path proof; use [account-deletion replay](account-deletion-replay.md) for accepted lost-response recovery. The before-state Agent observation must show the exact Agent registered and inspectable through the same RPC.

## Gotchas

- The first `Delete Account` button fetches and renders the server-owned immutable Action Presentation. The irreversible action consumes the exact Approval at `Confirm account deletion`; pause at that boundary.
- Use a fresh run after any deletion attempt. There is no restore or rejected-deletion receipt path.
- The current Agent schema has no personal Skill, Skill Version, Skill index, or learning-obligation tables to seed directly. This drive proves deletion of the whole Agent SQLite facet and a User-owned R2 trusted-evidence object. It must not be reported as direct row-level Skill lifecycle evidence until those tables exist and the observer seeds them.
- An HTTP response, empty browser session, or missing PostgreSQL User alone is incomplete. Require every observer assertion and the visible signed-out result.
- The unrelated provider and R2 objects are run-owned controls. Their survival proves User-scoped deletion; cleanup removes their local run storage afterward.
