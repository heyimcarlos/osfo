# Hosted browser qualification

This fixed check uses the installed `agents/browser` API through a remote Cloudflare Browser Run binding. It creates two isolated sessions, writes synthetic cookies and DOM content without contacting a website, reconnects to the first session, and deletes both. Deletion must return an inaccessible session with HTTP 404 or 410. It does not prove long approval waits, persisted authentication after browser expiry, or the product's authorization rules.

The qualification check accepts only an authenticated `POST /qualify`. It accepts no CDP commands, URLs, session identifiers, or fixture content from callers. A random local token protects the check. The runner first verifies that an unauthenticated call fails. Qualification evidence contains counts and check results; no browser access URLs or credentials are returned.

Public `GET /fixture` serves a synthetic page with a reference input and a button that updates the visible receipt and a browser cookie. It performs no external action. A deployed instance provides an HTTPS fixture for testing the product's browser adapter.

Authenticated `POST /adapter-qualify` uses the actual application `HostedBrowserProvider.make(BROWSER)` against this Worker's HTTPS fixture. It creates a session, opens the page, reads its accessibility tree, fills the synthetic reference, observes again, clicks the receipt button, verifies the visible result, rejects an action using the original stale page, and closes the session with provider absence confirmation. The qualification-only module alias points directly to the application's current provider source; no duplicate adapter implementation is bundled. Existing prepared configurations need the two new aliases from `prepare.mjs` before running this check.

Prepare a new directory from the repository root:

```sh
node tools/verification/hosted-browser/prepare.mjs /tmp/hosted-browser-qualification-UNIQUE
```

Run the isolated Worker in another terminal. Replace `/absolute/repository` and the temporary directory. The existing Wrangler login needs access to Browser Run. Clearing token variables prevents an unrelated API token from overriding that login. Keep the current directory under `/tmp` so application environment files are not loaded.

```sh
cd /tmp/hosted-browser-qualification-UNIQUE
env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_API_KEY -u CLOUDFLARE_EMAIL /absolute/repository/apps/worker/node_modules/.bin/wrangler dev --config ./wrangler.jsonc --ip 127.0.0.1 --port 8798
```

The local Worker uses `browser.remote: true`; its browsers run on Cloudflare. This command does not deploy a public Worker. Then run from the repository:

```sh
node tools/verification/hosted-browser/run.mjs /tmp/hosted-browser-qualification-UNIQUE
```

Successful evidence reports four passed checks and two confirmed deletions. The runner writes `evidence-<timestamp>.json` privately in the temporary directory. A failed cleanup is reported as failure and must be investigated before the runtime is stopped. Browser sessions also have a ten-minute inactivity timeout. Stop Wrangler after the check.

Static validation:

```sh
bunx tsc --project tools/verification/hosted-browser/tsconfig.json
```

## Human handoff probe

The same Worker has three fixed authenticated POST routes. Use the qualification bearer for all three. This probe requires a deployed HTTPS fixture because a remote browser cannot reach the local development server. Deployment and setting the `QUALIFICATION_TOKEN` Worker secret are separate operator actions; the private `.dev.vars` file only configures local development.

- `/handoff/start` creates one session on this Worker's `/fixture`, requests a ten-minute native handoff, and returns `handle`, `liveUrl`, `started`, and `state`. Store this response privately. The live URL grants browser access.
- Open `liveUrl`, enter an invented reference, click Record test receipt, then click the provider's Done control.
- `/handoff/status` returns the native handoff state and the fixed receipt observation after reconnecting. Supply the returned `handle` in the `X-Qualification-Handle` header. Compare state before and after Done rather than assuming provider completion fields.
- `/handoff/close` deletes the session and checks that the provider reports 404 or 410. Supply the same handle. Require `deleted: true`.

Handles are HMAC-signed with the qualification secret. The routes cannot address caller-chosen sessions or execute caller-provided commands. The Worker does not keep sessions in process globals. The browser's ten-minute inactivity timeout bounds abandoned probes, but callers should close them explicitly.
