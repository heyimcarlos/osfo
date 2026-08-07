# Terraform breakglass

Routine automation rejects `force-unlock`, state writes, `console`, `-target`,
`-refresh=false`, and `-lock=false`. Production destroy, delete actions, and
replacement actions are prohibited.

Breakglass requires an active incident, an identified incident commander, a
second approver, and a written justification linked to the exact root. Before
any mutation:

1. Stop the root's GitHub workflow and confirm no Terraform process still owns
   the lock.
2. Export the current state to approved encrypted evidence storage, record its
   lineage and serial, and record a SHA-256 checksum without printing state.
3. Preserve the relevant GCS object generations and Cloud Audit Logs.
4. Record the proposed command, expected state transition, rollback path, and
   both approvals.

`force-unlock` is permitted only for a lock created by the failed operation and
only after proving that writer has stopped. `state push` is a last-resort repair
after ordinary import, moved blocks, or provider recovery cannot work. Never
use `-force` to bypass a lineage or serial conflict without separately proving
the destination root and preserving both states.

After mutation, run a locked refresh-only plan, then a normal saved plan. Both
must reconcile to the intended authority. Attach commands, checksums, state
lineage and serial, plan binding, GCS generations, and audit-log pointers to the
incident. Console changes remain prohibited even during breakglass because they
have no reproducible configuration path.
