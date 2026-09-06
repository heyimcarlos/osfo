# Private browser host

This opt-in development host connects authenticated Osfo turns to one provisioned
Chrome extension through Executor and Codex computer use. Inventory returns the
matched browser's name, ID, and tab count. Browser tasks create their own tabs at
explicitly provisioned origins, retain observations, and use existing Osfo Action
approval for every click, fill, or selection.

The model supplies no JavaScript, owner identity, extension ID, or arbitrary tab
ID. Opening requires the exact URL in the current User request. The Worker retains
the original request and latest evidence across Sessions. It checks current turn
authority and the live incident control before new browser dispatch. Each read is
an admission point; already-dispatched effects may finish. Outcome inspection and
committed cleanup remain available during an incident pause.

## Provisioning

The supported connection is a local development Worker calling
`http://127.0.0.1:39270/inventory` and `/browser`. The Node listener binds only
`127.0.0.1:39270` and is excluded from ordinary development startup. Preview Worker configuration disables the host. Production defaults to disabled
until all five Worker variables below are explicitly configured. Production requires
a canonical HTTPS `/inventory` endpoint without credentials, query, fragment, or
custom port; a nonblank owner and extension identity; a 32 to 512 character bearer
without whitespace; and one to eight exact HTTPS allowed origins. Partial or invalid
production configuration fails deployment and Worker configuration loading.

A production Worker cannot reach desktop loopback. Provision authenticated TLS
transport to the same host for both `/inventory` and `/browser`, preserving the
bearer header and refusing redirects. Keep the Node listener on loopback. Match the
owner, observed extension instance, bearer and origins on both sides. Store the
bearer in private deployment configuration; Alchemy retains it as a redacted secret
binding. This configuration change provisions no network access. Verify the actual
transport and owned task lifecycle before enabling the capability for its owner.

Use one explicitly provisioned owner and Chrome extension. A developer profile is
not a shared browser runtime. Tab ownership does not isolate cookies or sessions
within that profile. Codex CLI authentication alone does not provision the desktop
browser broker. The installed app-server must already have the `cua_repl` plugin
and connected Chrome extension. The session ID is its observed
`metadata.extensionInstanceId`, never a caller-invented thread or focused tab.

| Node host variable                  | Worker variable                | Value                                                                                                                        |
| ----------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `OSFO_BROWSER_HOST_ENABLED`         | none                           | Explicit `true`                                                                                                              |
| `OSFO_BROWSER_HOST_OWNER_USER_ID`   | `BROWSER_HOST_OWNER_USER_ID`   | One authenticated Osfo User                                                                                                  |
| `OSFO_BROWSER_HOST_SESSION_ID`      | `BROWSER_HOST_SESSION_ID`      | Provisioned Chrome extension instance                                                                                        |
| `OSFO_BROWSER_HOST_TOKEN`           | `BROWSER_HOST_TOKEN`           | Same private bearer, 32 to 512 characters                                                                                    |
| `OSFO_BROWSER_HOST_ALLOWED_ORIGINS` | `BROWSER_HOST_ALLOWED_ORIGINS` | JSON array of at most eight exact HTTPS origins, or loopback HTTP origins for verification; defaults to `[]`, inventory only |
| none                                | `BROWSER_HOST_ENDPOINT`        | Exact loopback inventory URL for local use; canonical HTTPS `/inventory` endpoint for production                             |
| `OSFO_BROWSER_HOST_DATABASE_PATH`   | none                           | Absolute private SQLite path outside the checkout                                                                            |
| `OSFO_BROWSER_HOST_CODEX_COMMAND`   | none                           | Absolute installed Codex binary path                                                                                         |
| `OSFO_BROWSER_HOST_CODEX_HOME`      | none                           | Existing provisioned Codex configuration directory                                                                           |

Run `bun run --cwd apps/browser-host start` only with the intended owner's binding.
Without explicit enablement it exits without a listener or child process. Node 24
provides SQLite. The database cannot be reassigned to another owner or extension.
No account credential, browser cookie, or profile storage API is exposed.

## Execution and retained outcomes

The host authenticates before reading request bodies. One active HTTP request is
admitted; concurrent requests are refused immediately without queueing. Request
bodies, response sizes, execution time, active tasks, and ledger size are bounded.
The Worker rejects HTTP redirects. Missing state, ambiguous extension selection,
and storage failures fail closed.

The adapter uses captured CUA APIs to select the exact Chrome extension, create
owned tabs, and compile fixed navigation, accessibility observation, interaction,
and close programs. URL checks precede page reads. Only the task-owned tab is
operated. A fresh accessibility observation must match the approved page and
visible target before interaction. Page text is untrusted evidence. A click or
selected slot is not confirmation of a reservation.

Each operation is claimed in SQLite before browser I/O, without a transaction
across that I/O. The same identity and payload returns its retained result or
`Unknown`; changed payloads conflict. An ambiguous effect cannot be retried under
a new operation after merely refreshing the page. Outcome inspection reads the
prior ledger entry without another browser effect. The ledger is capped at 1,024
operations per binding and four active tasks, with one-hour task admission expiry.

Broker elicitation is canceled and returned as a human-required outcome. It does
not grant Osfo approval. Every DOM interaction requires its own immutable Action
presentation containing destination, observation, visible target, exact value,
and consequence. Login, CAPTCHA, and unsupported browser controls require human
handoff. A host restart does not reattach to unknown existing tab handles; retained
results can still be inspected, but live continuation may require operator help.

A timed-out CUA Promise may still be running. The runtime refuses subsequent
interactions after that ambiguity and attempts cleanup only once the Promise has
settled. Account deletion first revokes host admission, then closes owned tabs and
erases task results. If cleanup cannot be proven, deletion retains its pending
state for reconciliation. A process crash can require operator cleanup of an
orphaned browser tab; it must not be treated as successful profile erasure.

## Runtime and verification

Executor 1.6.8 uses its app-server transport with the pinned caller-correlation
patch, a real ephemeral thread, and an allowlist restricted to the fixed `js`
adapter. Effect beta.59 stays inside this Node host; Worker/API use the workspace
version. Only JSON and synchronous wire codecs cross that boundary.

Tests exercise real SQLite replay, changed payload refusal, auth-before-body,
immediate concurrent refusal, revocation cleanup, and the installed Executor
connector against a synthetic CUA fixture. Worker tests cover durable task intent,
unknown effects across Sessions, current authority, and exact Action presentation.
These tests do not establish authenticated live browser qualification. That proof
requires a separately coordinated synthetic portal journey through an actual Osfo
turn and Action approval. This slice does not claim OCR, arbitrary navigation,
profile isolation, production reachability, or completion of a real booking.

## Reconcile an unresolved tab creation

An Open refusal reported as `Unavailable` proves no create was dispatched. Its
empty task row is removed while its original operation outcome stays retained.
An `Unknown` Open may have created a tab. Its NULL tab ID is a cleanup obligation,
not proof that no tab exists. Revocation stays pending even if a restarted runtime
reports an empty owned-handle map.

An operator can resolve that obligation only with positive evidence linking the
original operation to one exact tab in the bound Chrome extension:

1. Keep the account deletion pending and the host revoked. Stop the host before
   repairing its private database. Retain the `browser_operations` entry and the
   unresolved `browser_tasks.identity`; do not delete either as a workaround.
2. Use the original creation receipt or captured broker evidence to establish the
   exact tab ID, extension, and operation identity. A matching URL, title, or an
   empty current handle map is insufficient. If that correlation is unavailable,
   leave cleanup pending for further investigation.
3. Close only the proven tab through the provisioned browser's supported operator
   control. Retain a private receipt of that exact close and its identity. Do not
   inspect unrelated tabs, clear a shared profile, or infer deletion of cookies.
4. With the host stopped, bind that proven ID to the unresolved row using a
   parameterized statement:
   `UPDATE browser_tasks SET tab_id = ? WHERE identity = ? AND tab_id IS NULL`.
   Require exactly one changed row. Keep the original operation entry unchanged.
5. Restart the same owner/extension/database binding and retry account deletion.
   Revocation remains persisted. The host verifies that this recorded tab is
   absent before erasing retained task results. If it is still present or the
   binding cannot be verified, cleanup remains pending.

Store the correlation evidence, close receipt, database repair result, and final
revocation result in the private incident record. Never publish credentials or
page content from the provisioned profile.
