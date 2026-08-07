# Development runtime demo disposition

Issue #90 implements a deployable development-only slice. It does not qualify
the six-worker candidate for production.

| Gate | Status | Evidence boundary |
| --- | :---: | --- |
| Browser bearer excluded from repository, image build args, Vite assets, and Terraform | PASS | The reference client accepts the bearer interactively and keeps it in per-tab session storage. Static contract and web tests enforce the boundary. |
| Digest-pinned build and Cloud SQL proxy inputs | PASS | Both `Containerfile` bases and the Cloud SQL Auth Proxy are pinned by manifest digest. The application image workflow returns an immutable Artifact Registry digest. |
| Published application image | MISSING | `image-digests.json` deliberately contains `null` until a protected-main build publishes the exact application image and a reviewed follow-up pins it. |
| Required runtime secret versions | MISSING | Cursor signing and model-adapter secret containers exist, but no reviewed version inputs or payloads have been supplied. Database administration and demo seed values remain ignored local operator inputs. |
| Protected cloud lifecycle authority | MISSING | The #89 protected lifecycle must complete before #90 can apply or mutate development runtime resources. |
| Operator database deployment contract | PASS | Terraform contains no database Cloud Run jobs. Focused operator scripts own one-time IAM grants, the explicit demo seed, migration readiness, and qualification reconciliation. A real PostgreSQL test proves bootstrap-before-migrate grants runtime access. |
| Database privilege bootstrap, migration, and explicit demo seed execution | MISSING | An operator must establish the approved private proxy, bootstrap access, apply reviewed generated SQL with `bun run db:migrate`, seed the demo authority, and pass the version-readiness check. |
| Private Cloud SQL connectivity | MISSING | Static checks prove the runtime definitions use the private-IP, auto-IAM Cloud SQL Auth Proxy sidecar. No live runtime has connected. |
| Fixed-one relay and four-publisher deployment | MISSING | Static checks prove the configuration pins one worker, four publishers, a 128-record window, one-second safety drain, and DB pool eight. No live relay has run. |
| Ordered six-worker StreamingPull candidate deployment | MISSING | Static checks prove six manual workers, four streams, 32 slots, DB pool eight, and one ordered subscription. No live candidate has run. |
| Authenticated transport and UI implementation | PASS | API routes require a bearer, the UI supplies it only at runtime, and the scoped web checks below passed. |
| Authenticated deployed transport and UI | MISSING | No public development runtime exists to exercise. |
| Public HTTPS load balancer and Cloud Armor | MISSING | The optional edge is fully defined, but no public hostname or DNS authority has been supplied. The serving stage reserves a stable global IP without granting public invocation or creating the HTTPS edge. |
| Three independent resumable cursors, deterministic conformance | PASS | The real PostgreSQL and Chrome suite proves independent tab cursors in the local deterministic profile. |
| Three independent resumable cursors, deployed reproduction | MISSING | No deployed three-tab reproduction exists. |
| Duplicate delivery and process replacement recovery, deterministic fallback conformance | PASS | The separately named deterministic qualification fallback proves process loss and duplicate delivery locally. It is not the deployed Oz profile. |
| Duplicate delivery and process replacement recovery, deployed reproduction | MISSING | The protected duplicate-delivery probe is defined. Replacement-before-provider-contact needs an explicit qualification seam before it can be run honestly with OpenRouter. |
| AgentRun lease recovery and cancellation, static contract | PASS | The runtime carries the merged lease renewal, cancellation polling, worker-thread cleanup, and termination deadline contract from issue #62. |
| AgentRun lease recovery and cancellation, deployed reproduction | MISSING | No deployed cancellation and worker-loss reproduction exists. |
| Immutable OpenRouter MiniMax M3 execution profile integration | PASS | Admission and AgentRun execution pin `oz.openrouter.minimax.minimax-m3.chat-completions.v1`; the worker resolves binding `openrouter.chat-completions.minimax.minimax-m3.v1` from the immutable profile. No deployed free-form binding or model override remains. |
| OpenRouter MiniMax M3 deployed qualification | MISSING | The model-adapter secret version is null and no deployed Oz AgentRun has produced sanitized provider evidence. |
| Rollout, drain, rollback, logs, dashboard, teardown | MISSING | Runtime resources, dashboard, and exact absence probe are defined. No exact-head protected lifecycle has run. |
| Deterministic qualification fallback | PASS | `oz.deterministic.v1` remains available only inside the worker as an explicitly separate local qualification fallback. Terraform cannot select it for deployed Oz. |
| Production qualification | MISSING | The development slice has not completed production qualification. |
| Final `us-east4` A/B/C/D admission matrix | FAIL | The admission matrix failed. This development demo cannot override it. |

## Evidence cockpit snapshot

[`evidence/catalog/development-runtime.json`](evidence/catalog/development-runtime.json)
is the sanitized current development snapshot used by the cockpit. It records
the exact immutable execution profile and binding, scoped provider and runtime
facts, two failed prior reconciliation attempts, limitations, and production
qualification `MISSING`. Its smoke digest matches the public issue #90
disposition, but it is still development evidence, not a production seal.

[`evidence/catalog/development-cloud-metadata.json`](evidence/catalog/development-cloud-metadata.json)
contains only whitelisted read-only metadata. Empty monitoring windows remain
`MISSING`, never zero. Resource identities, service accounts, secret
references, private network details, database connection material, raw
provider responses, and model content are excluded. Both snapshots are sealed
by the packet catalog snapshot manifest for reproducible presentation.

## Scoped web evidence

The user-visible authority screen was verified before publication with:

```text
PASS  bun run --cwd apps/web test
PASS  bun run build --filter=@osfo/web
PASS  OSFO_TEST_DATABASE_URL=<local digest-pinned PostgreSQL URL> bun run --cwd apps/web test:postgres
PASS  browser development inspection at http://127.0.0.1:5173
```

The browser showed the thread identifier and password fields, masked the bearer
input, and reported no console errors. The Chrome PostgreSQL journey opened three
tabs with separate injected session-storage authority and proved independent
resumable cursors. These checks are local deterministic evidence. Deployed browser
qualification remains `MISSING`.

Deployment order is strict:

```text
foundation IAM apply
  -> disposable platform apply
  -> protected application image build
  -> out-of-band cursor and OpenRouter secret version insertion
  -> runtime infrastructure apply (serving disabled)
  -> approved private operator database connection
  -> one-time access bootstrap
  -> bun run db:migrate
  -> explicit demo seed
  -> migration version readiness check
  -> runtime serving apply
  -> authenticated three-cursor smoke
  -> separate qualification reconciliation and duplicate-delivery proof
  -> evidence seal
  -> exact runtime destroy and provider absence
```

The cursor and model-adapter secret version numbers, plus the application image
digest, are non-secret reviewed inputs. Secret payloads never enter Terraform
state or the repository.
Only the AgentRun worker receives the model-adapter payload as
`OPENROUTER_API_KEY`; the immutable profile pins the model and provider. The
database administrator URL and demo bearer stay in the operator's ignored local
environment. Operator scripts accept only loopback database URLs from an
already-running approved private Cloud SQL Auth Proxy. The same administrator
connection owns bootstrap and `bun run db:migrate`, so default privileges apply
to every reviewed migration. The scripts do not store either credential.
Serving processes retain IAM database authentication.

## Protected lifecycle commands

All cloud mutation happens from protected `main` through the existing bound
Terraform plan and apply workflow. A reviewed bootstrap change pins the
published application digest, the cursor and model-adapter secret versions, and
`platform_ready = true` while leaving `serving_enabled = false`. Establish the
approved private proxy, load the ignored operator environment, then run:

```bash
export OSFO_DATABASE_ADMIN_URL='postgresql://<admin>@127.0.0.1:5432/osfo'
export OSFO_DATABASE_URL="$OSFO_DATABASE_ADMIN_URL"
export OSFO_DATABASE_RUNTIME_ROLES='<transport-role>,<relay-role>,<agentrun-role>'
export OSFO_REFERENCE_AUTHENTICATION_TOKEN="$REFERENCE_TOKEN"
export OSFO_REFERENCE_THREAD_ID=6ef239bd-3f04-4c77-8976-1171e75ea0ab
infra/tests/development-runtime-database.sh
```

Only a successful migration, seed, and readiness run permits a new reviewed plan with
`serving_enabled = true`. The serving apply with `public_hostname = null`
reserves the stable global IP reported as `runtime.edge_ip_address`, but creates
no NEG, backend, certificate, URL map, HTTPS proxy, forwarding rule, or public
invoker. The public edge and public browser evidence therefore remain `MISSING`.
An operator can use that stable address to select the temporary IP-derived demo
hostname. A reviewed follow-up then pins that hostname, and the edge apply
creates the HTTPS path.

A read-only prerequisite check found one managed zone in the development
project: private zone `osfo-dev-private` for `temporal.internal.`. No controlled
public zone exists, so project-owned public DNS, the hostname, and external edge
evidence remain `MISSING`. The temporary IP-derived hostname path does not claim
project-owned DNS authority.

The bearer is inserted out of band and supplied only to the smoke process:

```bash
GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
OSFO_RUNTIME_ORIGIN=https://reviewed-origin.example \
OSFO_DATABASE_URL='postgresql://<admin>@127.0.0.1:5432/osfo' \
OSFO_REFERENCE_AUTHENTICATION_TOKEN="$REFERENCE_TOKEN" \
OSFO_REFERENCE_THREAD_ID=6ef239bd-3f04-4c77-8976-1171e75ea0ab \
  infra/tests/development-runtime-smoke.sh
```

The smoke requires `OSFO_DATABASE_URL` to point at the approved private proxy.
Each output wait reads canonical history from the accepted receipt position and
requires `AssistantOutputCompleted` plus `AgentRunSucceeded` for that exact
AgentRun. Unrelated work on the shared seeded Thread cannot satisfy the gate,
and an exact `AgentRunFailed` or `AgentRunCanceled` terminal event fails it. The
smoke runs `scripts/qualification/reconcile-agent-run.ts` outside Cloud Run,
binds reconciliation to the accepted AgentRun identifier, and records
only sanitized counts and immutable profile/binding names. It requires one
confirmed provider request identity, one terminal output, reported usage, and
positive reasoning usage without recording model content, provider payloads, or
the provider request identifier. The protected recovery stage republishes that
terminal ordered delivery, requires an `alreadyTerminal` settlement, and
compares the complete sanitized durable identity graph before and after:

```bash
GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
OSFO_DATABASE_URL='postgresql://<admin>@127.0.0.1:5432/osfo' \
  infra/tests/development-runtime-recovery.sh
```

This duplicate-delivery proof is not process-replacement qualification.
Replacement-before-provider-contact and lease takeover remain `MISSING` until a
separate pre-provider qualification seam exists. Record the current service and
worker-pool templates, apply a fresh exact-image revision, run the smoke and
safe duplicate-delivery script, then apply the saved prior-image plan and rerun
the smoke. Capture Cloud Run, Pub/Sub, Cloud SQL, application logs, and the
runtime dashboard for each source SHA. Finally apply a reviewed plan with
`serving_enabled = false`, followed by an exact runtime plan with
`platform_ready = false` and the application, cursor, and model-adapter inputs
returned to `null`. Only after that plan applies, run:

```bash
GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
  infra/tests/development-runtime-absent.sh
```

This sequence supplies rollout, duplicate-delivery, rollback, drain, and runtime
teardown evidence. Process replacement and lease takeover remain `MISSING` until
an explicit pre-provider qualification seam exists. Destroy of the disposable
platform remains the separate issue #89 lifecycle. Any unexecuted stage is
`MISSING`, not `PASS`.

## Removal plan safety

This change removes the migration and reconciliation Cloud Run jobs, project
roles, secret access, `actAs` bindings, Cloud SQL IAM users, and the obsolete
database-administrator and reference-bearer secret containers from Terraform.
Their established service-account records remain in the foundation state as
disabled, `prevent_destroy` protected dormant identities. They retain the
original service-account description because Google Cloud rejects description
edits after disablement, and they are excluded from every platform and runtime
output. A reviewed foundation plan must not destroy them. Review and bind each
foundation and development-platform plan exactly before applying it. Do not
interrupt either root while its shared state is locked. Database schema and
product rows remain owned by Cloud SQL and are not destroyed by this runtime
cleanup.
