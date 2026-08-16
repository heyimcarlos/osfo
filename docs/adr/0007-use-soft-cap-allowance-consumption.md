# ADR 0007: Use soft-cap allowance consumption for Osfo v1

Date: 2026-08-16

Status: Accepted

Osfo v1 records immutable Allowance Consumption against one common Plan period
for each User. Each record reuses an existing product or effect identity and is
idempotent for its allowance kind. Known-at-start use can be checked and
recorded during admission. Actual category use and vendor cost are recorded
after the owning effect provides trusted evidence. Work admitted while recorded
use is below its limit may finish and can cause bounded period overshoot. Later
ordinary work is denied. Per-operation cost limits and concurrency limits bound
this exposure, and Osfo never charges the User an overage.

V1 does not add allowance reservations, settlement states, a generic work
identity, or a separate versioned price-book module. Feature modules normalize
their own evidence into allowance quantities and an observed or conservative
basis. The Plan policy owns limits. Existing product identities make retries
safe. Osfo can add reservation accounting later if observed concurrency, cost,
or recovery failures show that soft caps are not sufficient.
