# Terraform foundation

Ticket 77 establishes the isolated Terraform state and validation boundary.
Ticket 89 adds the disposable development platform. Runtime deployment remains
owned by later tickets.

## Disposable development platform

Foundation composes the environment baseline module, which owns the retained,
development-only `us-east4` VPC, Direct VPC egress subnet, static Cloud NAT,
private services access, private DNS, firewall rules, and an optional Temporal
Cloud Private Service Connect endpoint. The `development/platform` root reads
those provider resources by their reviewed names. Foundation also retains the
six runtime service-account identities, two qualification-only identities,
the exact Cloud SQL and conditional secret-access roles, and two probe-only
`actAs` grants. Data authority owns zonal private-IP Cloud SQL PostgreSQL with
IAM database authentication, Secret Manager containers, immutable Artifact Registry tags,
and the disposable content-addressed artifact bucket. Command buffer owns the
single ordered Pub/Sub topic and StreamingPull subscription.

Foundation permanently owns the network baseline, development service APIs,
and the platform root's reviewed IAM. Cloud SQL can retain producer networking
for up to four days after instance deletion, so keeping the isolated baseline
outside the disposable root is required for reliable exact cleanup. A platform
cleanup removes every resource in its state without disabling capabilities or
blocking later recreations. The platform identity cannot delete artifact
objects. A separate foundation recovery identity removes only reviewed
content-addressed objects before the platform identity applies Terraform
destroy. The platform has read-only project network discovery and
`roles/compute.networkUser` only on the retained development subnetwork; it
cannot administer the VPC or Service Networking connection.

That retained boundary has a deliberate development-only blast radius. The VPC,
subnet, static external address, Cloud NAT, router, private DNS zone, firewall,
and private services access allocation continue to exist and may continue to
incur cost after a platform destroy. They are not shared with production and
the scheduled foundation refresh-only plan owns their drift. The disposable
root creates and destroys Cloud SQL, Pub/Sub, secret containers,
Artifact Registry, the artifact bucket, qualification jobs, and its private
database DNS record. Retaining the named runtime identities avoids tombstoned
IAM principals across repeated platform recreation while granting them no
payload access beyond the explicit disposable secret policies.

The reviewed variable set exposes database size and retention, storage names,
quota expectations, process connection pools, concurrency, fixed worker counts,
streams, and execution slots. These are development inputs and conditional
production candidates, not silently qualified production defaults. Secret
payloads and Secret Manager versions remain outside Terraform.

Qualification evidence is written by content digest to the foundation-owned,
versioned evidence bucket. That bucket has a 396-day retention policy and is
not part of development destroy. The development artifact bucket disables
`force_destroy`, so Terraform cannot remove objects as a side effect of bucket
teardown. The platform identity can create and read objects but has no
`storage.objects.delete`, so it cannot overwrite an existing object generation.
Project-level storage authority is limited to bucket creation. Bucket reads,
deletion, and object creation are conditionally scoped to the exact reviewed
artifact bucket, and the platform has no bucket-update authority with which to
install a deletion lifecycle rule.
The development platform receives create and read access only under
`roots/development/platform/` in the evidence bucket. Object-name listing is a
separate bucket-scoped permission because Cloud Storage cannot prefix-condition
`storage.objects.list`; it grants no payload, update, or delete authority.

Temporal Cloud must publish and authorize a same-region service attachment.
Foundation alone accepts its non-secret `us-east4` URI and DNS name. The
disposable root discovers the retained forwarding rule and records its exact
target, so duplicated root inputs cannot drift. When the forwarding rule is not
available, the report records Temporal PSC as `MISSING`, never `PASS`.

The platform smoke uses a digest-pinned base image for disposable Cloud Run
Jobs with Direct VPC egress. It proves private-only Cloud SQL connectivity with
an IAM database login, private DNS resolution, and observed public egress
through the retained static NAT address. No qualification identity has secret
access, and runtime identities are never impersonable by the platform identity.
The denied probe requires a nonzero secret-version access result with an empty
payload, independently of human-readable `gcloud` errors. A foundation preflight
validates the exact live denied identity, requires project-only ancestry, and
resolves project roles for exact, public, and aggregate principals that could
include that identity. It fails closed for any parent hierarchy or unresolved
aggregate authority that could grant secret payload access. After apply, the
existing platform read authority performs the matching structural check against
the exact live target-secret policy before the runtime probe. The source
contract also rejects secret-level IAM resources in the disposable platform
definition. The platform may create versions and manage containers, but it
cannot change secret IAM, access version payloads, or mint runtime credentials.
Authorized secret-version access therefore remains `MISSING` in this preparatory PR.
Package installation inside the pinned base image is still mutable, so full
probe toolchain determinism is also `MISSING`.
The retained private zone owns two narrow platform bindings. The conditional
record role uses Cloud DNS's numeric project and managed-zone identifiers to
match the full `database.temporal.internal.` A resource name exactly. A
separate unconditional role on that same zone supplies only the change,
zone-read, and record-list prerequisites required by Cloud DNS. Neither role
can create, update, or delete a managed zone, and the platform cannot change
zone IAM. Foundation owns the two durable
zone bindings through a custom role containing only managed-zone IAM policy
get and set. Cloud DNS does not expose ManagedZone resource attributes to IAM
conditions, so this foundation bootstrap role is unconditionally scoped to the
development project rather than making an unsupported exact-zone claim. The
foundation root creates only the one retained private zone in that project.
Before any disposable platform apply, the platform identity must create, read,
update, and delete a documentation-range A value at the exact reviewed record;
it refuses to replace an existing record and its failure path cleans up only
that probe target. Automatic and scheduled recovery also recognize a canceled
permission probe and remove only a matching `192.0.2.89` or `192.0.2.90` probe
record before the independently scheduled Terraform destroy. A DNS residue
cleanup failure cannot skip destroy, but the job still reports either failure.
The DNS policy preflight verifies exactly two zone bindings and rejects stale
project-level platform DNS grants. It is separate from the artifact recovery
preflight so DNS qualification cannot suppress cleanup.

The ordered Pub/Sub proof first validates the Terraform-managed subscription's
topic, ordering, retention, and acknowledgement configuration. Its behavioral
round trip then uses an isolated disposable subscription and the `us-east4`
regional API endpoint, so qualification cannot lease or acknowledge runtime
messages. The topic also restricts allowed persistence to `us-east4`; the
regional endpoint alone is not treated as storage-topology evidence.
The artifact proof creates one content-addressed object, rejects a second
generation from an unconditional overwrite, requires the exact missing
`storage.objects.delete` permission, and verifies that only one generation
exists. This is IAM-enforced create-only immutability, not a caller-precondition
claim.

After foundation has applied the evidence bucket and platform IAM additions,
initialize the development backend and run the destructive, disposable proof:

```sh
terraform -chdir=infra/roots/development/platform init -input=false \
  -backend-config="bucket=$GCP_DEVELOPMENT_STATE_BUCKET" \
  -backend-config="prefix=roots/development/platform"
export DEVELOPMENT_LIFECYCLE_RUN_ID=manual-20260807-01
export PLATFORM_SERVICE_ACCOUNT="$GCP_DEVELOPMENT_PLATFORM_TERRAFORM_SERVICE_ACCOUNT"
SAVED_PLAN_BUCKET="$GCP_SAVED_PLAN_BUCKET" \
  infra/tests/development-platform-live.sh
```

The proof refuses a dirty tree and binds evidence to the exact commit, reviewed
variable and image files, and create and no-change plan manifests. It runs
quota preflight, verifies that the exact foundation artifact-recovery role and
binding are already applied, performs an exact saved-plan apply, produces an
empty second plan, and runs stage-labelled managed-service smoke checks. Before
cleanup it stores an immutable lifecycle envelope keyed by
the workflow run and content digest. Cleanup evidence links that envelope, or
records the link as `MISSING` when cancellation happened before it was stored.
The proof always reports the current acceptance result as partial while any
required gate is `MISSING`. For a manual run, choose a new
`DEVELOPMENT_LIFECYCLE_RUN_ID` for every attempt and reuse that exact value for
its cleanup invocation.

Cleanup is a separate two-authority workflow. Its foundation job removes only
reviewed content-addressed artifact objects and treats a confirmed existing,
empty bucket as successful preparation. Its platform job is scheduled with
`always()` after that attempt, even when preparation fails, so a permission
failure cannot skip Terraform destroy. The failed artifact job still makes the
workflow fail. With `force_destroy` disabled, a nonempty bucket cannot be
deleted before the reviewed foundation object cleanup succeeds. The platform
job stores and applies a bound destroy plan, fails closed on state reads,
performs negative provider lookups, and queries retained audit history when it
removed Terraform-owned resources. A default-branch `workflow_run` recovery starts
after every completed protected lifecycle dispatch, including cancellation of
the original run. A scheduled default-branch janitor uses the same serialized
cleanup path only when GitHub run history contains an abandoned protected
lifecycle without a successful keyed recovery. It also requires a successful
static job at its exact current-main source before OIDC, so canceling a recovery
run cannot silently strand resources or turn an ordinary scheduled run into a
destructive one. A successful recovery records the original Terraform run ID and
run attempt in its cleanup job name. Later schedules consult only successful,
attempt-specific cleanup jobs across every GitHub rerun attempt, so completed
cleanup clears the exact marker without combining or hiding rerun results. The
daily scan is bounded to main-branch runs from the last 14 days, which provides
14 retry opportunities against a 24-hour cleanup SLA. It fails before OIDC when
the retained window exceeds 100 runs, 20 attempts for one run, 100 jobs for one
attempt, or 400 total attempt-job reads. Runs outside that retained horizon need
the audited break-glass procedure and are never represented as automatic cleanup
`PASS` evidence. API, parse, page-count, branch, event, SHA, run, and attempt
mismatches all fail before OIDC. The GCP workload identity provider also rejects every ref except
`refs/heads/main`, outside branch-controlled workflow logic. Lifecycle,
cleanup, recovery, drift, and root plan/apply runs that can touch development
platform state share the global `terraform-development-platform` concurrency
group. Cancellation recovery remains an unevidenced `MISSING` gate until a
post-merge cancellation run proves it.

Cleanup reports the verified retained VPC, NAT, DNS zone, firewall, and private
services connection separately from Temporal PSC. The Temporal retained-baseline
check remains `MISSING` until its address, accepted forwarding-rule target, and
DNS record are configured and verified.

Both scheduled drift jobs are read-only. One refreshes the retained foundation
baseline, while the other refreshes the empty disposable state and performs the
same provider absence checks. Neither job applies. Missing protected workflow
configuration fails with an explicit `MISSING` message instead of silently
skipping a green job.

## Fixed toolchain

Terraform is exactly `1.15.8`, the Google provider is exactly `7.43.0`, and the
provider selections and checksums are committed in
`roots/foundation/.terraform.lock.hcl`. CI executes every Terraform command
through `scripts/terraform-ci.sh` in the official Terraform image by immutable
digest. `toolchain.json` records the CLI archive checksum, image digest, and
exact gcloud version. There are no external modules in this slice.

Install the exact CLI and verify the archive against `toolchain.json`, or use a
version manager that honors the repository `.terraform-version`. Do not use a
compatible range.

## Root and state boundary

```text
foundation
  -> development/platform -> development/runtime
  -> production/platform  -> production/runtime
```

Foundation creates three projects, three state buckets, and five root-specific
keyless service accounts. Development and production platform and runtime roots
share their environment bucket but use distinct prefixes and IAM conditions.
Each backend identity receives bucket-scoped object-name listing plus
prefix-conditioned object access. Listing is separate because GCS does not
support prefix conditions on `storage.objects.list`. It does not grant state
payload access outside the root prefix.
GCS object versioning, a locked 30-day retention policy, 30-day soft delete,
and 90-day noncurrent cleanup preserve recoverability. GCS native locking and
GitHub concurrency serialize writers. Terraform workspaces and
`terraform_remote_state` are rejected.

The root outputs publish only non-secret project IDs, bucket names, service
account emails, the Workload Identity Provider name, and the selected region.
Downstream roots use those reviewed identifiers or provider data sources. They
never read upstream state.

## Foundation bootstrap

Prerequisites are a Google Cloud billing account, an administrator with project
creation and billing attachment authority, and five GitHub environments named
`foundation`, `development-platform`,
`development-runtime`, `production-platform`, and `production-runtime`.
Production environments require protected approval.

1. Obtain immutable GitHub IDs with `gh api repos/OWNER/REPOSITORY --jq
'[.id, .owner.id]'`.
2. Copy `roots/foundation/foundation.tfvars.example.json` to
   `roots/foundation/foundation.tfvars.json` and replace every placeholder.
   The real file is ignored. It contains identifiers only, never credentials.
3. Authenticate `gcloud` and user Application Default Credentials. The
   bootstrap administrator needs project creation, billing attachment, project
   policy, IAM, and state bucket object authority. Set `organization_id` to a
   numeric ID when an organization owns the projects, otherwise leave it null.
   Organization policy administration can only be granted at organization
   scope. When `organization_id` is null, the root omits organization policy
   resources and their IAM grant. Record key-policy enforcement as MISSING for
   that environment. Never create a service-account key.
4. Record the following command session and its result in approved audit
   evidence. Replace the values first. If an organization owns the project, add
   `--organization=ORGANIZATION_ID` to `gcloud projects create` and use the same
   ID in the variable set.

   ```sh
   export FOUNDATION_PROJECT_ID=osfo-foundation-unique
   export BILLING_ACCOUNT=000000-000000-000000
   export FOUNDATION_STATE_BUCKET=osfo-foundation-tfstate-unique
   export DEVELOPMENT_STATE_BUCKET=osfo-development-tfstate-unique
   export PRODUCTION_STATE_BUCKET=osfo-production-tfstate-unique

   gcloud projects create "$FOUNDATION_PROJECT_ID" \
     --name=osfo-foundation \
     --labels=environment=foundation,managed_by=terraform,system=osfo
   gcloud billing projects link "$FOUNDATION_PROJECT_ID" \
     --billing-account="$BILLING_ACCOUNT"
   gcloud services enable storage.googleapis.com serviceusage.googleapis.com \
     --project="$FOUNDATION_PROJECT_ID"

   gcloud storage buckets create "gs://$FOUNDATION_STATE_BUCKET" \
     "gs://$DEVELOPMENT_STATE_BUCKET" \
     "gs://$PRODUCTION_STATE_BUCKET" \
     --project="$FOUNDATION_PROJECT_ID" \
     --location=US \
     --default-storage-class=STANDARD \
     --uniform-bucket-level-access \
     --public-access-prevention \
     --retention-period=30d \
     --soft-delete-duration=30d \
     --lifecycle-file=infra/bootstrap/state-bucket-lifecycle.json

   gcloud storage buckets update "gs://$FOUNDATION_STATE_BUCKET" \
     --versioning \
     --update-labels=environment=foundation,managed_by=terraform,purpose=terraform-state,system=osfo
   gcloud storage buckets update "gs://$DEVELOPMENT_STATE_BUCKET" \
     --versioning \
     --update-labels=environment=development,managed_by=terraform,purpose=terraform-state,system=osfo
   gcloud storage buckets update "gs://$PRODUCTION_STATE_BUCKET" \
     --versioning \
     --update-labels=environment=production,managed_by=terraform,purpose=terraform-state,system=osfo

   printf 'y\n' | gcloud storage buckets update \
     "gs://$FOUNDATION_STATE_BUCKET" --lock-retention-period
   printf 'y\n' | gcloud storage buckets update \
     "gs://$DEVELOPMENT_STATE_BUCKET" --lock-retention-period
   printf 'y\n' | gcloud storage buckets update \
     "gs://$PRODUCTION_STATE_BUCKET" --lock-retention-period
   ```

   Admin Activity audit logs record the project, billing, service, bucket, and
   retention mutations. Preserve the local command transcript beside those log
   references. The locked retention operation is irreversible.

5. Copy `backends/foundation.hcl.example` outside the repository, replace its
   bucket placeholder, and initialize the empty protected backend. The import
   blocks inventory the foundation project and all three state buckets created
   above. They do not import or expose any state from another root.

   ```sh
   terraform -chdir=infra/roots/foundation init -input=false \
     -backend-config=/approved/local/path/foundation.hcl
   terraform -chdir=infra/roots/foundation validate

   export TF_VARSET_FILE="$PWD/infra/roots/foundation/foundation.tfvars.json"
   export TF_IMAGE_DIGESTS_FILE="$PWD/infra/roots/foundation/image-digests.json"
   infra/scripts/create-plan.sh foundation infra/roots/foundation \
     .plans/foundation-import.tfplan
   infra/scripts/apply-plan.sh foundation infra/roots/foundation \
     .plans/foundation-import.tfplan
   ```

   This one-time bootstrap plan is retained locally because its protected plan
   bucket does not exist yet. The exact saved plan imports the four bootstrap
   resources, then creates the remaining two projects, the protected saved-plan
   bucket, WIF provider, root identities, IAM, project security policies, and
   audit configuration. Project security policies are created only when the
   variable set supplies an organization ID. Run a post-import no-change gate.
   Exit 2 is a failure that must be reconciled before bootstrap is complete.

   ```sh
   infra/scripts/create-plan.sh foundation infra/roots/foundation \
     .plans/foundation-post-import.tfplan -detailed-exitcode
   ```

6. Set repository variables from the foundation outputs:
   `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SAVED_PLAN_BUCKET`, the three
   `GCP_*_STATE_BUCKET` values, and all five
   `GCP_*_TERRAFORM_SERVICE_ACCOUNT` values. Set
   `GCP_FOUNDATION_VARSET_JSON` to the non-secret foundation variable object.
   Configure the five protected GitHub environments listed above.

Cloud Audit Logs enable Admin Read, Data Read, and Data Write for every service
in each project. WIF validates immutable numeric repository and owner IDs, and
each service account trusts only its mapped GitHub environment attribute. The
provider-level immutable repository gate applies before any environment can
impersonate a root identity.

## Plan, apply, drift, and destroy

`create-plan.sh` always writes a saved plan and a 24-hour manifest bound by
SHA-256 to the root, commit, image-digest set, variable set, exact Terraform and
provider versions, provider lock file, state lineage and serial, and plan
bytes. `apply-plan.sh` revalidates every binding, including the production
environment argument, and applies only that exact plan.

After bootstrap, `store-plan.sh` writes the plan and manifest to their root's
conditioned prefix in the private foundation saved-plan bucket. It uses exact
GCS object inserts with a zero-generation precondition, so routine identities
need object creation permission but no bucket-wide listing permission. GCS
encrypts the objects with Google-managed encryption. Current and noncurrent
objects have a one-day lifecycle, and the manifest makes every plan unusable
after exactly 24 hours even if asynchronous GCS cleanup has not run yet. Plans
are never uploaded as ordinary GitHub artifacts.

The manual `root-plan` and `root-apply` tasks cover all five roots under a
root-specific GitHub concurrency group, with development platform operations
also held by the global state concurrency group. Production uses its protected GitHub
environment and the same deletion-policy checks used before any production
resource exists. `root-apply` accepts only a binding checksum, fetches its exact
plan and manifest, rechecks the current commit, inputs, state, expiry, and
environment, then applies that saved plan. The equivalent audited local flow is:

```sh
infra/scripts/fetch-plan.sh "$GCP_SAVED_PLAN_BUCKET" \
  production/platform BINDING_SHA256
infra/scripts/apply-plan.sh production infra/roots/production/platform \
  .plans/production/platform/BINDING_SHA256.tfplan
```

The manual development workflow creates the full disposable development
platform and the two qualification jobs, exercises live managed services,
then hands teardown to the foundation artifact-cleanup and platform destroy
jobs. It does not destroy the retained foundation network baseline. Its remote
state remains versioned and recoverable. A remaining acceptance gap, including
unavailable Temporal PSC, is reported as `MISSING` and the lifecycle command
exits nonzero.

Terraform may create Secret Manager containers, IAM, replication, and rotation
policy in later roots. Secret versions and payloads are prohibited from source,
variables, state, plans, artifacts, repository content, and logs.

See `BREAKGLASS.md` for the audited state recovery and force-unlock procedure.
