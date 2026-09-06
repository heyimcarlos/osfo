# Incident controls

The PostgreSQL `incident_controls` singleton holds two independent controls. Its
migration initializes both to `false`. Missing or unreadable state refuses guarded
new work. The existing Hyperdrive binding disables query caching; every admission
reads current state without retaining it in an Agent or Workflow snapshot.

- `newIngress` stops new registration, channel linking and conversation admission.
  Both HTTP ingress and managed Agent message admission are checked, including
  messages arriving over an existing connection.
- `newCostlyWork` stops new model, search, integration, artifact, document, file,
  memory and proactive WhatsApp provider dispatch at their admission points.

Health, account deletion, cancellation, previously dispatched provider evidence
reconciliation, accounting and committed cleanup remain reachable. Existing
registered users can still request authentication SMS to reach account deletion.
Unregistered-number SMS is suppressed while either control is paused, with the
same accepted response to avoid revealing registration status. Normal authentication
rate limits and OTP verification remain in place.

A guard read is the admission point. Work already admitted before a pause can
finish; no database transaction is held across provider I/O. Completed provider
work can be recovered and accounted during a pause. A control change does not
cancel in-flight requests or undo their effects.

## Inspect or change a control

Use the trusted local operator CLI with `INCIDENT_DATABASE_URL` set by the
operator's credential mechanism to the intended database. The CLI does not load a
production environment file or expose a public administration endpoint.

```sh
bun apps/worker/scripts/incident-controls.ts inspect
bun apps/worker/scripts/incident-controls.ts set newIngress paused operator-id 'Incident reference'
bun apps/worker/scripts/incident-controls.ts set newCostlyWork paused operator-id 'Incident reference'
bun apps/worker/scripts/incident-controls.ts set newCostlyWork active operator-id 'Recovery reference'
bun apps/worker/scripts/incident-controls.ts set newIngress active operator-id 'Recovery reference'
```

Each change updates only the selected control and retains its operator, reason
and database timestamp on the singleton. The CLI reads both current controls after
the write. Repeating the desired setting converges on the same behavior. Record
the incident and the observed readback in the operational record.

## Rollout boundary

Deploy and verify the guard-bearing code before relying on these controls. A
Workflow started on code without a guard cannot acquire one merely because the
control row changes. Inventory older instances and drain or terminate them through
the reviewed Workflow procedure while preserving provider reconciliation. Never
report that deploying an environment variable alone stopped existing Workflows.

Cloudflare exposes a version identity per Workflow instance and selects version
metadata during instance creation. Its current documentation does not provide a
guarantee that a later binding-only deployment refreshes every running instance.
The shared PostgreSQL read avoids depending on that behavior for guard-bearing
instances. See [Workflows architecture](https://blog.cloudflare.com/workflows-v2/)
and [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
