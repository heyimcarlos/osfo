# Development runtime demo disposition

Issue #90 implements a deployable development-only slice. It does not qualify
the six-worker candidate for production.

| Gate | Status | Evidence boundary |
| --- | :---: | --- |
| Browser bearer excluded from repository, image build args, Vite assets, and Terraform | PASS | The reference client accepts the bearer interactively and keeps it in per-tab session storage. Static contract and web tests enforce the boundary. |
| Digest-pinned build and Cloud SQL proxy inputs | PASS | Both `Containerfile` bases and the Cloud SQL Auth Proxy are pinned by manifest digest. The application image workflow returns an immutable Artifact Registry digest. |
| Published application image | MISSING | `image-digests.json` deliberately contains `null` until a protected-main build publishes the exact application image and a reviewed follow-up pins it. |
| Required secret versions | MISSING | Cursor signing, database administrator URL, reference bearer, and model-adapter secret containers exist, but no reviewed version inputs or payloads have been supplied. |
| Protected cloud lifecycle authority | MISSING | The #89 protected lifecycle must complete before #90 can apply or mutate development runtime resources. |
| Database job static contract | PASS | Terraform defines separate one-task, zero-retry bootstrap, migration, seed, and reconciliation jobs. A real PostgreSQL test proves the privilege bootstrap is idempotent. |
| Database privilege bootstrap, migration, and idempotent reference seed execution | MISSING | The bootstrap must use the out-of-band administrator URL first, then migration and seed must prove private Cloud SQL IAM connectivity. |
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
  -> out-of-band secret version insertion
  -> runtime bootstrap apply (serving disabled)
  -> migration job
  -> seed job
  -> runtime serving apply
  -> authenticated three-cursor smoke
  -> duplicate-delivery recovery proof
  -> evidence seal
  -> exact runtime destroy and provider absence
```

The cursor, database administrator URL, reference bearer, and model-adapter
secret version numbers, plus the application image digest, are non-secret
reviewed inputs. Secret payloads never enter Terraform state or the repository.
Only the AgentRun worker receives the model-adapter payload as
`OPENROUTER_API_KEY`; the immutable profile pins the model and provider. The
database administrator URL must be inserted out of band after setting the
built-in `postgres` password interactively. It is used only by the privilege
bootstrap job. Serving processes and the migration and seed jobs retain IAM
database authentication.

## Protected lifecycle commands

All mutation happens from protected `main` through the existing bound
`development-runtime` root plan and apply workflow. A reviewed bootstrap change
pins the published application digest, all four secret version numbers, and
`platform_ready = true` while leaving `serving_enabled = false`. After that
bound plan applies, run:

```bash
GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
  infra/tests/development-runtime-jobs.sh
```

Only a successful migration and seed run permits a new reviewed plan with
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
OSFO_REFERENCE_AUTHENTICATION_TOKEN="$REFERENCE_TOKEN" \
OSFO_REFERENCE_THREAD_ID=6ef239bd-3f04-4c77-8976-1171e75ea0ab \
  infra/tests/development-runtime-smoke.sh
```

The smoke binds reconciliation to the accepted AgentRun identifier and records
only sanitized counts and immutable profile/binding names. It requires one
confirmed provider request identity, one terminal output, reported usage, and
positive reasoning usage without recording model content, provider payloads, or
the provider request identifier. The protected recovery stage republishes that
terminal ordered delivery, requires an `alreadyTerminal` settlement, and
compares the complete sanitized durable identity graph before and after:

```bash
GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
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
`platform_ready = false` and all application and secret version inputs returned
to `null`. Only after that plan applies, run:

```bash
GCP_DEVELOPMENT_PROJECT_ID=osfo-development-318708913 \
  infra/tests/development-runtime-absent.sh
```

This sequence supplies rollout, duplicate-delivery, rollback, drain, and runtime
teardown evidence. Process replacement and lease takeover remain `MISSING` until
an explicit pre-provider qualification seam exists. Destroy of the disposable
platform remains the separate issue #89 lifecycle. Any unexecuted stage is
`MISSING`, not `PASS`.
