# Terraform foundation

Ticket 77 establishes the isolated Terraform state and validation boundary.
Ticket 89 adds the disposable development platform. Runtime deployment remains
owned by later tickets.

## Disposable development platform

Foundation composes the environment baseline module, which owns the retained,
development-only `us-east4` VPC, Direct VPC egress subnet, static Cloud NAT,
private services access, private DNS, firewall rules, and an optional Temporal
Cloud Private Service Connect endpoint. The `development/platform` root reads
those provider resources by their reviewed names. Data authority owns zonal private-IP
Cloud SQL PostgreSQL with IAM database authentication, runtime identities,
Secret Manager containers and per-secret IAM, immutable Artifact Registry tags,
and the disposable content-addressed artifact bucket. Command buffer owns the
single ordered Pub/Sub topic and StreamingPull subscription.

Foundation permanently owns the network baseline, development service APIs,
and the platform root's reviewed IAM. Cloud SQL can retain producer networking
for up to four days after instance deletion, so keeping the isolated baseline
outside the disposable root is required for reliable exact cleanup. A platform
destroy removes every resource in its state without disabling capabilities or
blocking later recreations.

That retained boundary has a deliberate development-only blast radius. The VPC,
subnet, static external address, Cloud NAT, router, private DNS zone, firewall,
and private services access allocation continue to exist and may continue to
incur cost after a platform destroy. They are not shared with production and
the scheduled foundation refresh-only plan owns their drift. The disposable
root creates and destroys Cloud SQL, Pub/Sub, runtime service accounts, secret
containers and policy, Artifact Registry, the artifact bucket, qualification
jobs, and its private database DNS record.

The reviewed variable set exposes database size and retention, storage names,
quota expectations, process connection pools, concurrency, fixed worker counts,
streams, and execution slots. These are development inputs and conditional
production candidates, not silently qualified production defaults. Secret
payloads and Secret Manager versions remain outside Terraform.

Qualification evidence is written by content digest to the foundation-owned,
versioned evidence bucket. That bucket has a 396-day retention policy and is
not part of development destroy. The development artifact bucket uses
`force_destroy` because its smoke artifact is already represented in retained
evidence before teardown.

Temporal Cloud must publish and authorize a same-region service attachment.
Foundation alone accepts its non-secret `us-east4` URI and DNS name. The
disposable root discovers the retained forwarding rule and records its exact
target, so duplicated root inputs cannot drift. When the forwarding rule is not
available, the report records Temporal PSC as `MISSING`, never `PASS`.

The platform smoke uses digest-pinned disposable Cloud Run Jobs with Direct VPC
egress. It proves private-only Cloud SQL connectivity with an IAM database
login, private DNS resolution, and observed public egress through the retained
static NAT address. It also uses the intended AgentRun and Temporal identities
to read known non-secret qualification versions and proves the reconciliation
identity cannot read them. The platform identity may create versions and manage
containers and policy, but its custom role cannot access version payloads or
mint runtime identity tokens. Its narrowly scoped `actAs` bindings exist only
to configure the three reviewed qualification jobs.

The ordered Pub/Sub round trip uses an isolated disposable subscription and the
`us-east4` regional API endpoint, so it cannot acknowledge runtime messages.
The artifact proof creates one content-addressed object, rejects a second
generation with a zero-generation precondition, and verifies that only one
generation exists.

After foundation has applied the evidence bucket and platform IAM additions,
initialize the development backend and run the destructive, disposable proof:

```sh
terraform -chdir=infra/roots/development/platform init -input=false \
  -backend-config="bucket=$GCP_DEVELOPMENT_STATE_BUCKET" \
  -backend-config="prefix=roots/development/platform"
SAVED_PLAN_BUCKET="$GCP_SAVED_PLAN_BUCKET" \
  infra/tests/development-platform-live.sh
```

The proof refuses a dirty tree and binds evidence to the exact commit, reviewed
variable and image files, and create, no-change, and destroy plan manifests. It
runs quota preflight, exact saved-plan apply, an empty second plan,
managed-service smoke checks, immutable evidence upload, and exact destroy. The
post-destroy gate fails closed if Terraform state cannot be read, then performs
negative provider lookups for every disposable service and queries retained
Cloud Audit Logs for lifecycle deletion history. Separate content-addressed
reports preserve managed checks, absence checks, audit events, and the final
lifecycle binding.

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

The manual `root-plan` and `root-apply` tasks cover all five roots under one
root-specific GitHub concurrency group. Production uses its protected GitHub
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
platform and the three qualification jobs, exercises live managed services,
then destroys that complete disposable set. It does not destroy the retained
foundation network baseline. Its remote state remains versioned and
recoverable. A remaining acceptance gap, including unavailable Temporal PSC,
is reported as `MISSING` and the lifecycle command exits nonzero.

Terraform may create Secret Manager containers, IAM, replication, and rotation
policy in later roots. Secret versions and payloads are prohibited from source,
variables, state, plans, artifacts, repository content, and logs.

See `BREAKGLASS.md` for the audited state recovery and force-unlock procedure.
