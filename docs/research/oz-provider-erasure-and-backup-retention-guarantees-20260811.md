# Oz provider erasure and backup-retention guarantees

Research date: 2026-08-11

Source policy: current first-party Cloudflare and Supermemory documentation,
API references, privacy terms, and data-processing terms

Access date for every external source: 2026-08-11

## Question and local contract

This note qualifies the deletion contract in
[Define the Oz Memory System and Supermemory contract](https://github.com/heyimcarlos/osfo/issues/155)
and the earlier
[Oz end-to-end memory lifecycle options](./oz-end-to-end-memory-lifecycle-options-20260808.md).
It asks what Oz can prove after Message Redaction, source deletion, Thread Reset,
and account deletion.

Four states must stay separate:

1. **Removed from live reads**: the active service cannot return the data.
2. **Retained for provider recovery**: an authorized restore can still recover an
   earlier copy.
3. **Permanently deleted**: the provider states that recovery is no longer
   possible.
4. **Retained in organization or provider backups**: a backup, replica, log, or
   legal hold can still contain the data even when the live API cannot return it.

## Executive answer

The public evidence is not sufficient to certify permanent erasure across the
complete Oz provider set.

- Cloudflare Durable Object SQLite and D1 have documented point-in-time
  recovery. A live delete can therefore coexist with a recoverable historical
  state. Durable Object SQLite has a 30-day recovery window. D1 has a 30-day
  window on Workers Paid and a 7-day window on Workers Free.
- R2 deletion is immediately visible through the Worker and S3 APIs, and
  Cloudflare calls object deletion irreversible. Public R2 documents do not
  state when deleted bytes, replicas, or provider backups are physically
  removed.
- Supermemory calls document deletion permanent with no recovery. Its memory
  `forget` operation is explicitly a soft delete. Its container-delete API says
  that it deletes all documents and memories, but the same API response defines
  `deletedMemoriesCount` as memories "marked as forgotten." Public documents do
  not resolve this conflict or state backup-retention periods.
- Cloudflare's current DPA gives a general delete-or-return obligation at
  service completion and a general retention criterion. It does not define a
  product-level backup purge time for Durable Objects, D1, or R2. Supermemory's
  public security page says to request its DPA and legal pack.

Oz can certify **live-service erasure** after it completes provider-specific
absence checks and disables all paths that could recreate the data. Oz must not
call this **permanent provider erasure** until the recovery period has expired
and the missing provider guarantees are confirmed in contract or in a written
provider response.

## Provider findings

### Cloudflare Durable Object SQLite

`deleteAll()` atomically removes the complete private SQLite database for one
Durable Object, including SQL and key-value data. With compatibility date
`2026-02-24` or later, it also deletes the active alarm. Earlier compatibility
dates need a separate alarm delete or compatibility flag.
[Cloudflare SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#deleteall)

This is a live-store operation, not proof that the prior state is no longer
recoverable. The same storage API can restore the entire SQLite database to any
point in the past 30 days. Cloudflare states that production keeps a durable log
of data changes for this feature.
[Cloudflare Durable Object PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)

Cloudflare also has a class-level deletion operation. It permanently removes a
Durable Object namespace and has no Trash. That operation deletes the complete
class namespace, not one User's Durable Object. It is therefore not a usable
per-account erasure primitive for Oz's shared Agent class.
[Cloudflare Durable Object class deletion](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#delete-a-durable-object-class)

Public status:

| Guarantee                                                                   | Public evidence                   |
| --------------------------------------------------------------------------- | --------------------------------- |
| Data is absent from one live Agent database after `deleteAll()`             | Documented, atomic for SQLite     |
| Deleted Agent data is recoverable                                           | Documented PITR for up to 30 days |
| Exact PITR-log expiry and physical purge after 30 days                      | MISSING                           |
| Per-Agent operation that disables PITR or destroys one instance permanently | MISSING                           |
| Deletion certificate or auditable provider purge receipt                    | MISSING                           |

### Cloudflare D1 and Time Travel

D1 Time Travel is always on for the production storage subsystem. It can
restore a database to a state before a mistaken `DELETE` or `UPDATE`. The
documented window is 30 days on Workers Paid and 7 days on Workers Free.
Bookmarks older than 30 days are invalid, and a restore does not delete older
bookmarks.
[Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

The D1 API can delete rows and can delete a complete database. The delete
database API only reports that the database was deleted. It does not state
whether historical or provider-held copies are immediately destroyed.
[Cloudflare D1 delete database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/delete/)

This creates an important design constraint. D1 Time Travel restores a complete
database in place. If mutable User directory rows and Erasure Receipts are in
the same D1 database, a restore to a time before the erasure can remove the
newer receipt. The erasure ledger must be outside every restore target. A
separate D1 database is sufficient only if the restore procedure never restores
that receipt database and the receipt database has its own independent recovery
policy.

Public status:

| Guarantee                                                              | Public evidence                             |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| Deleted rows are absent from current D1 reads                          | SQLite behavior and API result support this |
| Deleted rows remain recoverable                                        | Explicitly documented through Time Travel   |
| Recovery window                                                        | 30 days on Paid, 7 days on Free             |
| Physical purge after the recovery window                               | MISSING                                     |
| Effect of deleting a complete D1 database on retained Time Travel data | MISSING                                     |
| Per-row permanent deletion before the recovery window ends             | MISSING                                     |

### Cloudflare R2

R2 object deletion is strongly consistent through the Worker and S3 APIs. After
the delete completes, direct reads return that the object does not exist.
[Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/#operations-and-consistency)
Cloudflare also calls object deletion irreversible at the customer control
plane.
[Cloudflare R2 object deletion](https://developers.cloudflare.com/r2/objects/delete-objects/)

There are two important exceptions:

- A custom-domain cache can continue to serve a deleted object until its cache
  entry expires or is purged. The cache does not affect Worker binding or S3
  reads. Private Oz source bytes should not use a cached public R2 custom domain.
  If they do, deletion must also purge that cache.
  [Cloudflare R2 caching](https://developers.cloudflare.com/r2/reference/consistency/#caching)
- R2 bucket locks prevent deletion and overwriting for a fixed period or
  indefinitely. The strictest matching lock wins over lifecycle deletion. User
  content that must support erasure must not be stored under a locked prefix.
  [Cloudflare R2 bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)

R2's public documents do not expose a customer restore or object-versioning
path for a deleted ordinary object. They also do not state the provider's
replica, backup, or physical deletion period. "Irreversible" proves that Oz
cannot restore the object through the documented customer API. It does not, by
itself, prove physical destruction across provider recovery systems.

### Cloudflare contract boundary

Cloudflare's current DPA says that it will delete or return Personal Data,
including copies, at service completion or termination, subject to applicable
law and the Customer's choice. Its data-transfer annex states that Personal
Data is retained until the earlier of service termination or the time when
processing is no longer necessary to perform the agreement.
[Cloudflare Customer DPA v6.4](https://cf-assets.www.cloudflare.com/slt3lc6tev37/1TTgT35GoUNlKZYGuKWBFy/4e7dfc8cf402419a9b1cf624291fc69f/cloudflare_customer_dpa-v6.4_april_3_2026.pdf)

This is useful organization-level protection, but it does not answer the
per-User question while Oz continues to use Cloudflare. It also does not state
an exact purge time for product recovery logs, replicas, or backups. Product
documentation and a written Cloudflare answer must define the operational
disclosure.

### Supermemory documents, memories, containers, keys, and backups

Supermemory exposes different deletion behaviors:

| Surface                                                 | Documented behavior                                                                                                | Erasure meaning                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Document delete, including bulk delete by container tag | "Permanent" with "no recovery"                                                                                     | Strong live and customer-recovery claim for documents |
| Memory forget                                           | Excluded from search but preserved in the database with `isForgotten=true`                                         | Soft delete only                                      |
| Memory update                                           | Creates a new version and preserves the prior version with `isLatest=false`                                        | Not deletion                                          |
| Container-tag delete                                    | Says it deletes all documents and memories, but response says the memory count is the number "marked as forgotten" | Contradictory, not sufficient for erasure             |
| Scoped-key revoke                                       | Later requests receive `401`; memories and container tags remain                                                   | Access revocation only                                |
| Organization reset                                      | Removes organization content but preserves organization, members, and billing                                      | Organization-wide live reset, not per-User erasure    |

Sources:

- [Supermemory document operations](https://supermemory.ai/docs/ingestion/document-operations#delete-documents)
- [Supermemory memory operations](https://supermemory.ai/docs/recall/memory-operations#forget-memory)
- [Supermemory container-tag delete API](https://supermemory.ai/docs/api-reference/container-tags/delete-container-tag)
- [Supermemory scoped keys](https://supermemory.ai/docs/authentication#scoped-api-keys)
- [Supermemory organization reset API](https://supermemory.ai/docs/api-reference/settings/reset-organization-data)

The Supermemory security guide tells app builders to delete the User's
container content and revoke scoped keys. It says that the DPA, subprocessors,
and contractual training policies are available from Supermemory support.
[Supermemory security and compliance](https://supermemory.ai/docs/overview/security)
The public privacy policy permits complete account and data deletion requests,
but qualifies them with legal retention requirements and unspecified technical
processing timeframes.
[Supermemory privacy policy](https://supermemory.ai/privacy/)

No public source found in the current documentation states:

- the backup, replica, transaction-log, or disaster-recovery retention period;
- when a permanent document delete is removed from those systems;
- whether container deletion permanently removes extracted memories, memory
  history, chunks, embeddings, graph edges, profiles, files, metadata, and
  processing artifacts;
- whether organization reset revokes master or scoped API keys;
- what happens when deletion races with queued ingestion or extraction;
- what audit evidence or deletion certificate is available.

The shared Supermemory organization cannot use organization reset for one User.
Oz needs a unique opaque container tag for each Knowledge Space, direct
document deletion for each known source, a confirmed permanent memory deletion
operation, container deletion, and scoped-key revocation. Until Supermemory
confirms that combination and its backup policy, Supermemory account-level
erasure is MISSING as a launch guarantee.

## Evidence Oz must retain and produce

An API `200` response is operation evidence. It is not complete erasure
evidence. Oz needs a deletion manifest with opaque identifiers, completion
responses, and independent absence checks. It must contain no deleted content.

### Message Redaction

Required live evidence:

1. The Think message retains only the permitted opaque structural tombstone.
2. No readable message bytes remain in Think Session rows, compaction overlays,
   summaries, local full-text indexes, Memory Claims, Core Profile, outbox
   payloads, retry records, or queued extraction work.
3. Every mapped R2 object returns not found through the binding or S3 API. Any
   enabled custom-domain cache is purged and checked separately.
4. Every mapped Supermemory document receives permanent document deletion.
   Search, profile, document-list, chunk, memory-history, and processing-queue
   checks return no readable content or active relationship.
5. A content-free Erasure Receipt records the message ID, affected opaque source
   and provider IDs, operation results, deletion time, and verification time.

### Source deletion

Required live evidence:

1. The Knowledge Source and every claim supported only by it are absent. Shared
   claims keep only provenance that does not disclose the deleted source.
2. Its R2 objects, temporary exports, cached projections, outbox payloads, and
   processing artifacts are absent.
3. The Supermemory source document and every derived memory or profile fact are
   absent. A document delete alone is not enough until Supermemory confirms the
   fate of extracted memory rows.
4. The Erasure Receipt records opaque source and provider identities and the
   completed checks.

### Thread Reset

Required live evidence:

1. The canonical Thread identity remains, but all Thread messages, tool content,
   compactions, summaries, local indexes, pending runs, and queued extraction
   work in the reset scope are absent.
2. Every Knowledge Source and provider record that the reset contract says was
   derived only from that Thread is absent. Independent User sources remain.
3. All Thread-scoped R2 objects and Supermemory records are absent.
4. The Erasure Receipt stores the opaque Thread ID, reset cutoff, affected
   generations, and verification results.

### Account deletion

Required live evidence:

1. Ingress, active sessions, Channel Bindings, and User access are revoked
   before storage deletion starts.
2. The Agent SQLite database passes `deleteAll()` and an empty-store check. Any
   alarm is also absent.
3. Listing the Knowledge Space R2 prefix returns no objects. Cache entries and
   bucket-lock conflicts are checked.
4. All Supermemory documents, memories, container tags, connections, and scoped
   keys for the Knowledge Space are absent. Provider counts reconcile with the
   canonical deletion manifest.
5. Personal D1 rows are absent. The content-free account Erasure Receipt remains
   in the independent receipt ledger.
6. All retry and ingestion paths are closed so they cannot recreate deleted
   provider data.

This proves removal from the live Oz service. The receipt must separately mark
provider recovery expiry or permanent-erasure confirmation. It must not claim
that those later states are complete when they are not.

## Content-free Erasure Receipt and restore replay

The receipt can retain opaque operational facts without retaining private
content:

- random receipt ID and operation type;
- opaque User, Agent, Thread, Message, Knowledge Source, Knowledge Space, and
  provider object IDs as applicable;
- deletion cutoff and canonical generation;
- provider operation IDs, status codes, counts, and verification timestamps;
- recovery-expiry date where the provider has a documented recovery window;
- replay count, last replay time, and final state.

It must not retain message text, source text, file names supplied by the User,
semantic labels, embeddings, summaries, or content hashes that permit a small
or predictable value to be guessed.

The restore gate must use this order:

```text
select restore point
        |
        v
quiesce Agent and block ingress
        |
        v
load receipts from independent, non-restored ledger
        |
        v
restore Agent or control-plane state
        |
        v
replay every receipt newer than, or applicable to, the restore point
        |
        v
delete revived local content and reissue idempotent R2/Supermemory deletes
        |
        v
verify live absence and disable recreating work
        |
        v
open Agent only if no account-deletion receipt applies
```

The Agent must check the D1 deletion gate before it serves every first request
after construction or restart. It cannot rely only on a flag inside its own
SQLite database because PITR can roll that flag back. A D1 operational restore
has the same problem. The Erasure Receipt database must not be part of the D1
restore target, or a separate monotonic copy must be reconciled before the
restored D1 database can serve traffic.

Replay must be idempotent. A missing R2 object, missing Supermemory document, or
already redacted SQLite row is success only after the full absence check passes.
If a provider is unavailable, the Agent remains closed or restricted. It does
not serve potentially revived private content.

## User disclosure required for v1

The privacy notice and deletion confirmation should state, in simple terms:

- what each operation removes and what identity or structural tombstone it
  preserves;
- that live access stops after Oz completes its checks;
- that Cloudflare Durable Object history can remain recoverable for up to 30
  days, and D1 history for up to 30 days on the production Paid plan;
- that restored data is not served until Oz reapplies all later deletion
  receipts;
- the confirmed R2 and Supermemory backup-retention periods, once obtained;
- any legal-hold exception and its scope;
- that Supermemory's `forget` operation is not permanent deletion;
- whether account deletion completion means live-service completion or final
  provider-recovery expiry.

Oz should give two dates when they differ: **live deletion completed** and
**provider recovery expiry expected**. It should not promise immediate physical
destruction.

## Direct provider confirmations required before launch

### Questions for Cloudflare

1. After SQLite `deleteAll()`, is the prior Durable Object content recoverable
   through PITR for the full 30-day window? At what exact time is it no longer
   present in PITR logs, replicas, and backups?
2. Can PITR be disabled or irreversibly truncated for one Durable Object
   instance without deleting the shared class namespace?
3. After D1 row deletion, when are the row values removed from Time Travel,
   replicas, logs, and backups? Does deleting the complete D1 database make its
   Time Travel history inaccessible and permanently delete it, and on what
   schedule?
4. After an ordinary R2 object delete, when are object bytes and metadata removed
   from replicas, repair data, and backups? Are any provider restore paths
   available after the customer-facing delete?
5. Do legal holds or abuse, security, billing, or audit logs retain User content
   or only operational metadata? What are their exact retention periods?
6. Can Cloudflare provide contractual product schedules or audit evidence for
   per-User erasure while the organization account remains active?

### Questions for Supermemory

1. Does permanent document deletion remove the raw document or file, chunks,
   embeddings, graph edges, extracted memories, profile facts, metadata,
   `customId`, and all prior versions? If not, which additional calls are
   required?
2. Does container-tag deletion permanently delete memories, or only mark them
   forgotten? The current endpoint text and response field description conflict.
3. Is there a permanent-delete endpoint for one extracted memory and all of its
   versions? `forget` is not sufficient.
4. What are the exact retention periods for database backups, replicas, write
   logs, object storage, search indexes, model-processing artifacts, and support
   logs after document, container, organization, and account deletion?
5. Can deleted content be restored by Supermemory staff or disaster recovery?
   If yes, how does Supermemory reapply later erasures before restored data
   becomes searchable?
6. What happens when deletion races with queued ingestion, extraction,
   connector synchronization, or retry work? Is there a deletion fence that
   prevents recreation?
7. Does container deletion revoke every scoped key for that container? Does
   organization reset or account deletion revoke both master and scoped keys?
8. What API response, audit log, or certificate proves final deletion, not only
   removal from live search?
9. Provide the current DPA, subprocessor list, legal-retention exceptions, data
   residency terms, training terms, and deletion service-level objective.

## Qualification result

| Requirement                                             | Result                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Message Redaction from live Oz reads                    | Achievable with the evidence procedure                         |
| Source deletion from live Oz reads                      | Achievable, subject to Supermemory derived-memory confirmation |
| Thread Reset from live Oz reads                         | Achievable with scope manifest and replay gate                 |
| Account deletion from live Oz reads                     | Achievable with multi-store verification                       |
| Cloudflare recovery-window disclosure                   | Documented for Durable Objects and D1                          |
| R2 physical and backup purge guarantee                  | MISSING                                                        |
| Supermemory permanent memory and container erasure      | MISSING                                                        |
| Supermemory backup and organization-retention guarantee | MISSING                                                        |
| Permanent-erasure certification across all providers    | MISSING                                                        |

The structural decision from issue 155 remains valid. The launch contract must
use a two-stage deletion state, keep Erasure Receipts outside restore targets,
and treat the missing Cloudflare and Supermemory answers as provider acceptance
requirements.
