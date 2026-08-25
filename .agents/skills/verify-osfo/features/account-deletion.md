# Delete an account

Account deletion permanently removes the authenticated User's account and User-scoped data after one exact destructive confirmation.

## Sub-features

- self-service deletion authority and exact Approval;
- immediate account fencing and signed-out completion;
- User-scoped Supermemory container deletion;
- whole Agent registry and SQLite facet deletion, observed through the current initialization record and registry entry;
- R2 deletion of a run-owned trusted-evidence object under the User prefix;
- PostgreSQL deletion of the User, session, Agent route, Channel Link, billing, allowance, and pending Deletion Case;
- survival of unrelated provider and R2 sentinels.

## How to get to it (user POV)

After registration and Telegram channel linking, open `/settings/privacy`, choose `Delete My Data`, read the permanent-deletion warning, and choose `Confirm account deletion`.

## Driving it with Chrome

1. Complete [registration](registration.md) and [channel linking](channel-linking.md) in the same Chrome tab.
2. Run `control-osfo seed-account-deletion <run-id>`. The helper records the run-owned User, Agent, and Channel Link; confirms the Agent registry and SQLite initialization; and seeds target plus unrelated Supermemory and R2 evidence.
3. Start account-deletion evidence, open `/settings/privacy`, and choose `Delete My Data`.
4. Wait for the server-presented warning `Permanently delete this account and all of its data.` and the enabled `Confirm account deletion` button. Capture this state as `action.png` and record the action.
5. Stop immediately before choosing `Confirm account deletion`. Obtain action-time confirmation that names the run-owned account, local Osfo destination, and permanent PostgreSQL, Agent SQLite, R2, provider-memory, session, and Channel Link effects. Keep the tab at this exact confirmation.
6. After confirmation, choose `Confirm account deletion` once. Wait for navigation to `/`, then require the signed-out `Sign in` and `Get started` links. Capture `result.png` and record the result.
7. Run `observe account-deletion` and finish the evidence.

PASS requires the signed-out home result; no run-owned PostgreSQL User graph, active session, Agent registry entry, or Agent initialization database; no target R2 object or target Supermemory container; exactly one target container deletion; and both unrelated sentinels still present. The before-state Agent observation must show one registry entry and one initialized Agent database.

## Gotchas

- The first `Delete My Data` button fetches and renders the server-owned immutable Action Presentation. The irreversible action consumes the exact Approval at `Confirm account deletion`; pause at that boundary.
- Use a fresh run after any deletion attempt. There is no restore or rejected-deletion receipt path.
- The current Agent schema has no personal Skill, Skill Version, Skill index, or learning-obligation tables to seed directly. This drive proves deletion of the whole Agent SQLite facet and a User-owned R2 trusted-evidence object. It must not be reported as direct row-level Skill lifecycle evidence until those tables exist and the observer seeds them.
- An HTTP response, empty browser session, or missing PostgreSQL User alone is incomplete. Require every observer assertion and the visible signed-out result.
- The unrelated provider and R2 objects are run-owned controls. Their survival proves User-scoped deletion; cleanup removes their local run storage afterward.
