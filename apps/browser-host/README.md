# Private browser inventory host

This is the first connection between Osfo's governed capabilities and an existing
Codex browser host. It supports inventory only. It cannot select, open, navigate,
read, or operate a tab, and cannot complete a booking.

The Agent registers `inspectBrowserInventory` under `browser-inventory` and admits
`browser.inspect` using its authenticated active User and turn. The model supplies
neither JavaScript nor ownership information. The Worker checks the configured
owner before sending an exact owner/session/turn/operation identity to this host.

## Connection and provisioning

The supported initial connection is a **local development Worker** calling
`http://127.0.0.1:39270/inventory` on the same provisioned machine. The Node host
always binds `127.0.0.1:39270`; it has no public listener or deployment command.
It is excluded from ordinary `dev` startup. Preview and production Worker
configuration always disable this capability.

A remote Cloudflare Worker cannot use that loopback address to reach a desktop.
No private remote transport is provisioned by this change. Remote operation still
requires an authenticated private connection to the specific provisioned host.
Do not expose this listener publicly or treat a developer's browser profile as a
shared runtime.

An operator must already have a supported, authenticated Codex app-server and the
enabled `cua_repl` plugin with a connected browser extension. CLI authentication
alone does not provision the desktop browser broker. A host binds to exactly one
Osfo User and one browser extension instance. `HOST_SESSION_ID` below is the
extension's observed `metadata.extensionInstanceId`, not a caller-invented Codex
thread ID. No binding is inferred from the currently focused browser.

Supply these values through existing private configuration. This change creates
no credentials and stores no Codex cookies or access tokens:

| Node host variable                | Worker variable              | Value                                                         |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| `OSFO_BROWSER_HOST_ENABLED`       | none                         | Explicit `true` to start the host                             |
| `OSFO_BROWSER_HOST_OWNER_USER_ID` | `BROWSER_HOST_OWNER_USER_ID` | The single authenticated Osfo owner                           |
| `OSFO_BROWSER_HOST_SESSION_ID`    | `BROWSER_HOST_SESSION_ID`    | The provisioned extension instance ID                         |
| `OSFO_BROWSER_HOST_TOKEN`         | `BROWSER_HOST_TOKEN`         | The same existing private transport secret, 32–512 characters |
| none                              | `BROWSER_HOST_ENDPOINT`      | Exact loopback URL above                                      |
| `OSFO_BROWSER_HOST_DATABASE_PATH` | none                         | Absolute private SQLite file path outside the checkout        |
| `OSFO_BROWSER_HOST_CODEX_COMMAND` | none                         | Absolute path to the installed Codex binary                   |
| `OSFO_BROWSER_HOST_CODEX_HOME`    | none                         | The existing provisioned Codex configuration directory        |

Run `bun run --cwd apps/browser-host start` only after those bindings are explicitly
provisioned for the intended owner. With no configuration, the command exits
without a listener or child process. The runtime uses Node 24's SQLite API.

## Dispatch and outcomes

Executor 1.6.8 runs the supported app-server transport. A small pinned dependency
patch adds the same caller correlation metadata that upstream already supplies
for its projected browser transport, using the real `thread/start` result and a
fresh correlation UUID. Threads are ephemeral. The raw `cua_repl` transport
allowlist contains only `js` and `js_reset`. Executor policy blocks every tool
except `js`, and this adapter supplies only `await cua.getState();`. Reset is
neither exposed nor called.

The response contains only the matched browser's ID, name, and tab count. Tab
titles, URLs, content, unrelated browsers, and broker diagnostics are discarded.
An absent or ambiguous extension match returns `Unavailable`.

The host claims each request in SQLite before dispatch and does not retry it.
Concurrent requests receive `Unavailable`. A repeated claimed identity returns
its retained result or `Unknown`; a disconnect, interruption, or restart never
causes a second dispatch. Result bodies expire on the next request after one
minute, while identity tombstones remain. Storage is capped at 1,024 distinct
operations per binding, then fails closed. A persisted database cannot be
reassigned to another owner or extension instance.

Broker elicitation is canceled and reported as `ApprovalRequired`. It does not
grant an Osfo Action approval. Protected browser effects remain unsupported until
they are connected to the existing exact Action approval and outcome owners.

Executor pins Effect `4.0.0-beta.59`; this private runtime retains that version and
its matching Node adapter. The Worker and API retain the workspace Effect version.
Only plain JSON data and synchronous API codecs cross that version boundary.

## Verification

- Worker tests cover owner admission, exact response identity, Tool selection,
  metadata-derived operation identity, and approval-required outcomes.
- Real SQLite tests cover incorrect owners/sessions, malformed operation input,
  ambiguous dispatch across restart and expiry, and persisted binding ownership.
- A standalone fake app-server exercises the installed Executor connector and
  the pinned patch, proving one fixed `js` dispatch, the returned thread identity,
  ephemeral startup, and removal of other browsers and private tab fields.

These tests do not provision or operate a real browser. Real inventory evidence
must use the explicitly selected owner's provisioned host; a browser mismatch
must be resolved before enabling the binding or testing later tab operations.
