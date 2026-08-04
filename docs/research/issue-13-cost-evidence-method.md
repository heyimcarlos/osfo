# Issue 13 cost evidence method

Research checked on 2026-08-03. All prices are public on-demand list prices in USD. They are not invoice totals and do not include negotiated prices, credits, taxes, late-reported usage, or discounts.

## Decision summary

The defensible cost record has three layers:

1. **Measured usage:** resource shapes and state-change timestamps from the issue 13 evidence bundle, GCP resource descriptions, GCP operation history, and frozen Temporal OpenMetrics.
2. **Catalog estimate:** measured quantities multiplied by first-party public list prices that were effective during the run.
3. **Authoritative billed cost:** Google Cloud Billing cost data and Temporal Cloud Billing API reports after provider processing and credits.

Using the measured operational windows and public catalog prices, the gross GCP list-cost estimate through the 2026-08-03 21:15 UTC teardown capture is **about $24.15**. This is deliberately an upper-bound-style engineering estimate, not the amount charged to a payment method. The exact GCP net cost is not yet inferable without billing data.

The four final frozen Temporal load runs integrate to approximately **217,996 non-background Actions** from the sampled `temporal_cloud_v1_total_action_count` rate. Temporal explicitly says metrics are suitable for detailed estimates but Usage and Billing data are more complete, so this integral is not an invoice quantity. The account's monthly usage, storage, plan proration, remaining trial credit, and any activity outside those four windows are not present in the evidence bundle.

## Measured GCP resource usage

These values come from read-only resource descriptions, Compute Engine operation history, Cloud SQL operation history, and Cloud Audit Logs. The issue 13 teardown record is at [`prototypes/agent-run-lifecycle/evidence/issue-13-temporal-cloud-confirmation-20260803T214500Z/teardown.json`](../../prototypes/agent-run-lifecycle/evidence/issue-13-temporal-cloud-confirmation-20260803T214500Z/teardown.json).

| Resource | Measured shape | Operational window used for estimate | Hours |
|---|---|---:|---:|
| Runner, first shape | `n2-standard-32`, 32 vCPU, 128 GiB | instance insert completed 14:41:07.194 to stop began 19:03:38.443 | 4.375347 |
| Runner, final shape | `n2-highcpu-32`, 32 vCPU, 32 GiB | `lastStartTimestamp` 19:06:38.256 to stop began 21:12:51.878 | 2.103784 |
| Runner boot disk | 250 GiB zonal `pd-ssd` | disk creation completed 14:41:07.194 to teardown capture 21:15:00 | 6.564668 and continuing |
| Runner public address | ephemeral external IPv4 while running | sum of the two VM running windows | 6.479131 |
| Cloud SQL, first shape | PostgreSQL 17 Enterprise, zonal, `db-custom-16-61440`, 16 vCPU, 60 GiB | create completed 14:37:55.241 to 64-vCPU resize completed 18:49:13.326 | 4.188357 |
| Cloud SQL, final shape | PostgreSQL 17 Enterprise, zonal, `db-custom-64-61440`, 64 vCPU, 60 GiB | resize completed 18:49:13.326 to stop completed 21:13:24.364 | 2.403066 |
| Cloud SQL storage | 250 GiB SSD | create completed 14:37:55.241 to teardown capture 21:15:00 | 6.617989 and continuing |
| Cloud SQL public address | zonal IPv4 reservation | same conservative window as the instance | 6.617989 and continuing |

The Cloud SQL compute intervals use operation completion boundaries. This is conservative because the database was unavailable during portions of create, flag update, and resize operations. Only provider billing data can resolve those transition seconds exactly. Compute Engine states that CPU charges stop when an instance enters `STOPPING`, which is why the VM estimate uses the start of each stop operation. Attached disks continue to incur charges while the VM is stopped. See [stopping a Compute Engine instance](https://docs.cloud.google.com/compute/docs/instances/suspend-stop-reset-instances-overview) and [disk cost considerations](https://docs.cloud.google.com/compute/docs/disks).

Cloud SQL documents that stopping an instance suspends instance charges while storage and IP-address charges continue. See [start, stop, and restart Cloud SQL for PostgreSQL](https://docs.cloud.google.com/sql/docs/postgres/start-stop-restart-instance).

## Google Cloud catalog prices

The rates below were retrieved from Google's Cloud Billing Catalog API on 2026-08-03. The API says an unbounded query returns the latest public SKU prices, at most 12 hours old, and exposes region, usage unit, effective time, and tier rates. See [`services.skus.list`](https://docs.cloud.google.com/billing/docs/reference/rest/v1/services.skus/list) and the [Catalog API guide](https://docs.cloud.google.com/billing/v1/how-tos/catalog-api).

All listed SKUs had `usageType=OnDemand`, included `northamerica-northeast1` where applicable, and returned an effective time of `2026-08-03T07:00:00Z`.

### Compute Engine

Service ID: `6F81-5844-456A`.

| SKU ID | Catalog description | Public rate |
|---|---|---:|
| `CBC9-2071-267A` | N2 Instance Core running in Montreal | $0.034802 per vCPU-hour |
| `45C7-42BE-4253` | N2 Instance RAM running in Montreal | $0.004664 per GiB-hour |
| `BA5B-E860-74C4` | SSD backed PD Capacity in Montreal | $0.187 per GiB-month |
| `C054-7F72-A02E` | External IP Charge on a Standard VM | $0.005 per hour |

Google's machine reference confirms that `n2-highcpu-32` has 32 vCPUs and 32 GiB of memory. See [N2 high-CPU machine types](https://docs.cloud.google.com/compute/docs/general-purpose-machines#n2_machines).

Derived VM rates:

```text
n2-standard-32 = 32 × $0.034802 + 128 GiB × $0.004664
               = $1.710656/hour

n2-highcpu-32  = 32 × $0.034802 + 32 GiB × $0.004664
               = $1.262912/hour
```

The public pricing page explains that VM vCPU and memory are billed separately and have a one-minute minimum. See [Compute Engine VM pricing](https://cloud.google.com/products/compute/pricing).

### Cloud SQL for PostgreSQL Enterprise

Service ID: `9662-B51E-5089`.

| SKU ID | Catalog description | Public rate |
|---|---|---:|
| `BA3C-810D-DB74` | Cloud SQL for PostgreSQL: Zonal - vCPU in Montreal | $0.0454 per vCPU-hour |
| `C18F-F8AE-B7CA` | Cloud SQL for PostgreSQL: Zonal - RAM in Montreal | $0.0077 per GiB-hour |
| `5449-6AD5-8815` | Cloud SQL for PostgreSQL: Zonal - Standard storage in Montreal | $0.187 per GiB-month |
| `73C6-24F3-7975` | Cloud SQL for PostgreSQL: Zonal - IP address reservation in Montreal | $0.011 per hour |

Derived database rates:

```text
db-custom-16-61440 = 16 × $0.0454 + 60 GiB × $0.0077
                   = $1.1884/hour

db-custom-64-61440 = 64 × $0.0454 + 60 GiB × $0.0077
                   = $3.3676/hour
```

Google documents that dedicated-core Cloud SQL instances are charged by vCPU and memory, storage is separately provisioned, billing is granular to seconds, and same-region traffic to Compute Engine is free. See [Cloud SQL pricing](https://cloud.google.com/sql/pricing).

## Worked GCP list-cost estimate

For both August storage SKUs, the Catalog API returned a `baseUnitConversionFactor` equivalent to 2,678,400 seconds, or 744 hours, per GiB-month. The estimate uses that provider-supplied August conversion rather than a generic 730-hour approximation. Google bills disk resources with per-second proration and charges for provisioned space whether used or unused. See [Compute Engine disk and image pricing](https://cloud.google.com/compute/disks-image-pricing).

| Component | Calculation | Gross list estimate |
|---|---|---:|
| Initial runner compute | 4.375347 h × $1.710656/h | $7.4847 |
| Final runner compute | 2.103784 h × $1.262912/h | $2.6569 |
| Runner boot SSD through capture | 6.564668 h × 250 GiB × $0.187/GiB-month ÷ 744 h/month | $0.4125 |
| Runner ephemeral IPv4 | 6.479131 h × $0.005/h | $0.0324 |
| Initial Cloud SQL compute | 4.188357 h × $1.1884/h | $4.9774 |
| Final Cloud SQL compute | 2.403066 h × $3.3676/h | $8.0926 |
| Cloud SQL SSD through capture | 6.617989 h × 250 GiB × $0.187/GiB-month ÷ 744 h/month | $0.4158 |
| Cloud SQL IPv4 through capture | 6.617989 h × $0.011/h | $0.0728 |
| **Total through teardown capture** | sum above | **$24.1452** |

This total excludes variable Compute Engine internet data transfer, artifact storage, Cloud Logging or Monitoring chargeable volume, taxes, and other project activity because the frozen bundle does not contain billing-attributed quantities for those SKUs. Cloud SQL traffic to the runner was same-region and therefore has a published $0 data-transfer rate. Traffic from Montreal to Temporal Cloud's public GCP Northern Virginia endpoint cannot be assumed free without the actual billing record.

### Continuing stopped-resource cost

Stopping the two compute services did not delete their storage. At these list rates, the remaining runner SSD, Cloud SQL SSD, and Cloud SQL IPv4 reservation continue at approximately:

```text
two 250 GiB SSD allocations = 2 × 250 × $0.187 = $93.50/month
Cloud SQL IPv4 reservation  = 744 × $0.011       = $8.184/August
total retained resources                            $101.684/August
                                                    $3.28/day during a 31-day month
```

The Compute Engine ephemeral address is released while the VM is stopped. These continuing values stop or change only when the resources are deleted or reconfigured. The exact monthly amount is prorated by actual retention time.

## Temporal Cloud On-Demand pricing

The executed namespace used On-Demand capacity in Temporal Cloud GCP `us-east4`. Temporal identifies `gcp-us-east4` as Northern Virginia and publishes the regional endpoint, but does not publish a region-specific single-region pricing multiplier. See [Temporal Cloud service regions](https://docs.temporal.io/cloud/regions#gcp-service-regions).

Temporal bills Actions, Active Storage, Retained Storage, and the account plan. Actions are the billing unit. APS, RPS, and OPS are capacity and service-protection measures, not three separate published Pay-As-You-Go charges. See [Temporal Cloud Actions](https://docs.temporal.io/cloud/actions), [capacity modes](https://docs.temporal.io/cloud/capacity-modes), and [Temporal Cloud pricing](https://docs.temporal.io/cloud/pricing).

For the Essentials plan:

| Item | Included allocation or price |
|---|---:|
| Monthly plan | greater of $100/month or 5% of consumption spend, partial first month prorated by day |
| Included Actions | 1 million per calendar month |
| Included Active Storage | 1 GB, converted to 744 GB-hours |
| Included Retained Storage | 40 GB, converted to 29,760 GB-hours |
| First 5 million excess Actions | $50 per million |
| Next 5 million excess Actions | $45 per million |
| Next 10 million excess Actions | $40 per million |
| Next 30 million excess Actions | $35 per million |
| Next 50 million excess Actions | $30 per million |
| Next 100 million excess Actions | $25 per million |
| Excess Active Storage | $0.042 per GB-hour |
| Excess Retained Storage | $0.00105 per GB-hour |

Allocations reset each calendar month. The namespace used the first On-Demand capacity unit, so there is no Provisioned Capacity minimum. If later testing switches to Provisioned Capacity, every TRU after the first has a 360,000 Actions-per-hour minimum. Temporal's pricing page documents this minimum and says the highest configured TRU count within an hour governs that hour.

No HA replica was part of this run. If HA is later enabled, Temporal instructs customers to apply a 2x multiplier to Actions and Storage while the replica is active.

### What the frozen Temporal metrics prove

The four final load bundles preserve one-second query results from a 30-second Temporal Cloud scrape. A left-rectangle integral of `sum(temporal_cloud_v1_total_action_count{is_background="false"})` gives:

| Frozen run | Approximate Actions in captured window |
|---|---:|
| 700/s for 10 minutes | 132,596 |
| 1,400/s calibration | 25,185 |
| 2,083/s calibration | 35,222 |
| 4,167/s calibration | 24,994 |
| **Total** | **217,996** |

At the first published overage tier, 217,996 Actions would have a standalone unit value of about $10.90. That is **not an incremental charge claim** because Essentials includes 1 million Actions per calendar month, the account plan is charged separately, and the metric windows do not capture all account usage. Temporal also states that Usage and Billing contain the most complete Action data while Event History and metrics are estimates.

### Trial-credit posture

Temporal advertises a new-account trial with $1,000 in credits for the first 90 days. See [Temporal Get Cloud](https://temporal.io/get-cloud). The user's account was created under that offer, but the remaining balance, exact expiration time, and credit application are not in repository evidence and must not be guessed. The Billing Center shows current balance, credit usage, and balance due. See [Temporal Billing Center](https://docs.temporal.io/cloud/billing).

Therefore:

- gross Temporal consumption can be estimated from Actions and storage;
- the final four runs appear comfortably below the Essentials Action allocation by themselves;
- the account plan charge and all other August usage must be included before deciding whether there is an overage;
- net cash cost is only known after checking the Billing Center or Billing API and applying trial credits.

## Authoritative closeout procedure

### Google Cloud

Use one of these provider records after usage has posted:

1. Filter Cloud Billing Reports by the benchmark project, usage date, services, locations, and relevant SKU IDs.
2. Prefer detailed Cloud Billing export to BigQuery for resource-level attribution when enabled.
3. After the invoice month closes, reconcile the Cost table's unrounded costs and credits to the statement total.

Google states that billing data can lag by a day or more, that detailed export includes resource-level information, and that invoice-level credits can be pooled across eligible usage. See [Cloud Billing reports](https://docs.cloud.google.com/billing/docs/how-to/reports), [Cloud Billing export](https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery), and [invoice Cost table](https://docs.cloud.google.com/billing/docs/how-to/cost-table).

The closeout artifact should include only sanitized rows with:

- usage start and end;
- service and SKU description;
- location;
- usage amount and unit;
- list cost;
- negotiated or usage-based discounts;
- credits;
- net cost;
- currency.

Do not publish billing account identifiers, payment data, API keys, or unrelated project charges.

### Temporal Cloud

Use the [Temporal Cloud Billing API](https://docs.temporal.io/cloud/billing-api) to generate an hourly CSV report for the current billing month, then filter `ResourceID` to the issue 13 namespace and `ChargePeriodStart`/`ChargePeriodEnd` to the experiment windows.

The Billing API is part of the Cloud Ops API at `https://saas-api.tmprl.cloud`. It requires a Temporal Cloud API key owned by a user or Service Account whose role permits the billing operation. Account Owner and Finance Admin have full billing and usage access. Do not assume that an OpenMetrics account key also authorizes Cloud Ops billing calls, and do not reuse or expose either key in evidence. See [Cloud Ops API prerequisites](https://docs.temporal.io/ops#prerequisites) and [Temporal roles and permissions](https://docs.temporal.io/cloud/manage-access/roles-and-permissions#account-level-roles).

The Billing API is authoritative for namespace-level attribution and exposes pricing quantity, pricing unit, contracted unit price, and contracted cost. Current-month data is provisional, includes usage only through roughly 24 hours before report generation, and becomes final only after the billing month closes. Preserve:

- one provisional hourly report after the 24-hour lag;
- one final report after month close;
- Action, Active Storage, Retained Storage, and plan rows;
- credit usage and balance due from Billing Center, with account identifiers removed.

## What cannot be inferred today

- Exact GCP invoice cost, because posted usage, discounts, credits, taxes, and variable SKUs were not read from a billing report.
- Whether any Google Cloud promotional credit applies to this project.
- Exact Temporal Action and storage quantities for the whole issue 13 session, because the frozen metric integration covers only four final load windows.
- Temporal plan proration, total August account usage, remaining trial balance, and final balance due.
- Cost attribution for E2B, OpenAI, artifact storage, image registry transfer, Cloud Logging, Cloud Monitoring, and internet data transfer.
- Transition-second billing during Cloud SQL create, resize, and stop operations.

The **$24.15 GCP figure is a reproducible gross list-cost estimate**. It should be replaced, not merely supplemented, by provider billing exports when those records become available.
