# Resume account deletion after a lost response

This drive proves the narrow recovery path for an exact retained account-deletion request after normal session access has been fenced. It is separate from the one-click happy-path proof.

## How to get to it (user POV)

After the first confirmed deletion request loses its browser response, refresh or revisit Osfo. The signed-out browser opens `/account-deletion/recovery` and displays only the exact saved server presentation. Choose `Retry Account Deletion` to recover the durable pending result.

## Driving it with Chrome

1. Complete [registration](registration.md) and [channel linking](channel-linking.md) in the same Chrome tab.
2. Run `control-osfo seed-account-deletion <run-id>` and start `account-deletion-replay` evidence.
3. Open `/settings/privacy`, choose `Delete Account`, and require the exact server-owned title and consequence from the [happy-path drive](account-deletion.md).
4. Choose `Confirm account deletion` once, then navigate the tab immediately to `/account-deletion/recovery` before the first response can update browser state. This deliberately loses only the browser response; it does not change the request.
5. Refresh the recovery route. Require the exact retained title and consequence, no editable approval fields, and one enabled `Retry Account Deletion` button. Capture this state as `action.png` and record `exact retained request after refresh`.
6. Choose `Retry Account Deletion` once. Require navigation to `/` with the signed-out `Sign in` and `Get started` links. Capture `result.png` and record that `Sign in and Get started` are visible.
7. Run `control-osfo reconcile-account-deletion <run-id>`. This invokes the same production scheduled entry point that owns irreversible deletion after both the initial request and its retained retry.
8. Run `observe account-deletion-replay` and finish the evidence.

When the same run already observed Immediate Gmail, this observer also records the captured Action
identity, exact Directory and User absence, and the same-commit Immediate Gmail owned-key deletion
qualification. It writes that receipt back to the Immediate Gmail evidence directory. Provider
Connection revocation is outside this drive and remains owned by #187. The receipt preserves the
local deletion proof, but it cannot qualify Immediate Gmail for release. That feature finishes as
`MISSING` until #187 supplies direct provider deletion evidence.

PASS requires one successful presentation request, two successful account DELETE requests, exactly one target provider-container deletion, the same complete target-absence and unrelated-survival assertions as the happy path, the exact retained presentation after refresh, and the signed-out result. A 503 retry or an edited/stale browser record is not this proof.
