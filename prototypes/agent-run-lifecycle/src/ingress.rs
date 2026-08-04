use std::time::Duration;

use anyhow::{Result, bail};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde::{Deserialize, Serialize};
use tokio_postgres::NoTls;

use crate::{
    RunId, RunState,
    reasoning_lane::{AgentDecision, DecisionClass, measured_replay_decision},
    workload::JourneyKind,
};

const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_REPLAY_EVENTS: usize = 1_000;

#[derive(Debug, Clone)]
pub struct MessageAdmission {
    pub account_id: String,
    pub thread_id: String,
    pub idempotency_key: String,
    pub request_hash: String,
    pub message_id: String,
    pub content: String,
    pub journey_kind: JourneyKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageReceipt {
    pub run_id: RunId,
    pub event_sequence: u64,
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadEvent {
    pub sequence: u64,
    pub event_id: String,
    pub event_type: String,
    pub content: String,
    pub run_id: RunId,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunEvidenceSnapshot {
    pub run_id: String,
    pub journey_kind: String,
    pub root_state: String,
    pub root_terminal_at_unix_microseconds: Option<u64>,
    pub claim_epoch: u64,
    pub wake_count: u64,
    pub total_agent_runs: u64,
    pub child_agent_runs: u64,
    pub awaited_child_agent_runs: u64,
    pub detached_child_agent_runs: u64,
    pub terminal_agent_runs: u64,
    pub interaction_records: u64,
    pub thread_events: u64,
    pub workflow_instances: u64,
    pub workflow_deliveries: u64,
    pub workflow_activities: u64,
    pub tool_calls: u64,
    pub approvals: u64,
    pub tool_attempts: u64,
    pub proactive_messages: u64,
    pub scheduled_reminders: u64,
    pub sandbox_jobs: u64,
    pub artifact_commits: u64,
    pub quick_reply: bool,
    pub decision_matches_actual: bool,
    pub stale_commit_rejections: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedMessageRun {
    pub run_id: RunId,
    pub parent_run_id: Option<RunId>,
    pub claim_epoch: u64,
    pub account_id: String,
    pub journey_kind: JourneyKind,
    pub workload_ordinal: u64,
}

#[derive(Clone)]
pub struct PostgresMessageStore {
    pool: Pool,
}

impl PostgresMessageStore {
    pub fn connect(database_url: &str, pool_size: usize) -> Result<Self> {
        if pool_size == 0 {
            bail!("message store pool size must be positive");
        }
        let mut config = database_url.parse::<tokio_postgres::Config>()?;
        config.application_name("osfo-message-ingress");
        let manager = Manager::from_config(
            config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager).max_size(pool_size).build()?;
        Ok(Self { pool })
    }

    pub async fn ensure_runtime_indexes(&self) -> Result<()> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        tx.query_one(
            "SELECT pg_advisory_xact_lock($1)",
            &[&7_120_215_360_378_162_564_i64],
        )
        .await?;
        tx.batch_execute(
            "CREATE TABLE IF NOT EXISTS agent_run_lifecycle.workflow_activities (
                 activity_id text PRIMARY KEY,
                 workflow_instance_id text NOT NULL REFERENCES agent_run_lifecycle.workflow_instances(workflow_instance_id),
                 state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'canceled')),
                 terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
             );
             CREATE TABLE IF NOT EXISTS agent_run_lifecycle.agent_decisions (
                 run_id text PRIMARY KEY REFERENCES agent_run_lifecycle.agent_runs(run_id),
                 source text NOT NULL,
                 quick_reply boolean NOT NULL,
                 child_agent_runs integer NOT NULL CHECK (child_agent_runs >= 0),
                 awaited_child_agent_runs integer NOT NULL CHECK (awaited_child_agent_runs >= 0),
                 detached_child_agent_runs integer NOT NULL CHECK (detached_child_agent_runs >= 0),
                 temporal_workflows integer NOT NULL CHECK (temporal_workflows >= 0),
                 temporal_activities integer NOT NULL CHECK (temporal_activities >= 0),
                 approvals integer NOT NULL CHECK (approvals >= 0),
                 tool_calls integer NOT NULL CHECK (tool_calls >= 0),
                 proactive_messages integer NOT NULL CHECK (proactive_messages >= 0),
                 scheduled_reminders integer NOT NULL CHECK (scheduled_reminders >= 0),
                 sandbox_jobs integer NOT NULL CHECK (sandbox_jobs >= 0),
                 artifact_commits integer NOT NULL CHECK (artifact_commits >= 0),
                 committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
             );
             CREATE TABLE IF NOT EXISTS agent_run_lifecycle.proactive_messages (
                 proactive_message_id text PRIMARY KEY,
                 run_id text NOT NULL REFERENCES agent_run_lifecycle.agent_runs(run_id),
                 state text NOT NULL CHECK (state IN ('delivered', 'failed', 'canceled')),
                 terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
             );
             CREATE TABLE IF NOT EXISTS agent_run_lifecycle.scheduled_reminders (
                 reminder_id text PRIMARY KEY,
                 run_id text NOT NULL REFERENCES agent_run_lifecycle.agent_runs(run_id),
                 workflow_instance_id text NOT NULL REFERENCES agent_run_lifecycle.workflow_instances(workflow_instance_id),
                 state text NOT NULL CHECK (state IN ('scheduled', 'delivered', 'canceled')),
                 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
             );
             CREATE TABLE IF NOT EXISTS agent_run_lifecycle.sandbox_jobs (
                 sandbox_job_id text PRIMARY KEY,
                 run_id text NOT NULL REFERENCES agent_run_lifecycle.agent_runs(run_id),
                 state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'canceled')),
                 terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
             );
             CREATE TABLE IF NOT EXISTS agent_run_lifecycle.artifact_commits (
                 artifact_id text PRIMARY KEY,
                 run_id text NOT NULL REFERENCES agent_run_lifecycle.agent_runs(run_id),
                 sandbox_job_id text REFERENCES agent_run_lifecycle.sandbox_jobs(sandbox_job_id),
                 state text NOT NULL CHECK (state IN ('committed', 'failed')),
                 checksum_verified boolean NOT NULL,
                 terminal_at timestamptz NOT NULL DEFAULT clock_timestamp()
             );
             CREATE INDEX IF NOT EXISTS agent_runs_dispatch_claimable_idx
             ON agent_run_lifecycle.agent_runs (created_at, run_id)
             WHERE workload_ordinal IS NOT NULL
               AND state IN ('pending', 'retry_ready');
             CREATE INDEX IF NOT EXISTS agent_runs_dispatch_expired_idx
             ON agent_run_lifecycle.agent_runs (lease_until, created_at, run_id)
             WHERE workload_ordinal IS NOT NULL
               AND state = 'running';
             DROP INDEX IF EXISTS agent_run_lifecycle.agent_runs_dispatch_active_idx;
             CREATE INDEX IF NOT EXISTS thread_events_run_lookup_idx
             ON agent_run_lifecycle.thread_events (run_id, event_type)
             INCLUDE (account_id, thread_id)",
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn initialize_empty_schema(&self) -> Result<()> {
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        tx.query_one(
            "SELECT pg_advisory_xact_lock($1)",
            &[&6_352_880_764_670_228_199_i64],
        )
        .await?;
        let schema_exists: bool = tx
            .query_one(
                "SELECT to_regnamespace('agent_run_lifecycle') IS NOT NULL",
                &[],
            )
            .await?
            .get(0);
        if schema_exists {
            bail!("agent_run_lifecycle schema already exists");
        }
        tx.batch_execute(include_str!("../schema.sql")).await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn admit_message(&self, admission: &MessageAdmission) -> Result<MessageReceipt> {
        validate_admission(admission)?;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        tx.execute(
            "SELECT pg_advisory_xact_lock(
                 hashtextextended($1 || ':' || $2, 0)
             )",
            &[&admission.account_id, &admission.idempotency_key],
        )
        .await?;
        if let Some(row) = tx
            .query_opt(
                "SELECT request_hash, thread_id, event_sequence, run_id
                 FROM agent_run_lifecycle.message_admission_receipts
                 WHERE account_id = $1 AND idempotency_key = $2",
                &[&admission.account_id, &admission.idempotency_key],
            )
            .await?
        {
            let request_hash: String = row.get(0);
            let thread_id: String = row.get(1);
            if request_hash != admission.request_hash || thread_id != admission.thread_id {
                bail!("idempotency key reused with a different message");
            }
            let event_sequence: i64 = row.get(2);
            let run_id: String = row.get(3);
            tx.commit().await?;
            return Ok(MessageReceipt {
                run_id: RunId::from(run_id.as_str()),
                event_sequence: event_sequence as u64,
                idempotent_replay: true,
            });
        }

        tx.execute(
            "INSERT INTO agent_run_lifecycle.threads (account_id, thread_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
            &[&admission.account_id, &admission.thread_id],
        )
        .await?;
        let event_sequence: i64 = tx
            .query_one(
                "UPDATE agent_run_lifecycle.threads
                 SET next_sequence = next_sequence + 1
                 WHERE account_id = $1 AND thread_id = $2
                 RETURNING next_sequence - 1",
                &[&admission.account_id, &admission.thread_id],
            )
            .await?
            .get(0);
        let root_sequence: i64 = tx
            .query_one("SELECT nextval('agent_run_lifecycle.root_run_id_seq')", &[])
            .await?
            .get(0);
        let run_id = if root_sequence == 1 {
            "run-parent".to_owned()
        } else {
            format!("run-root-{root_sequence}")
        };
        let journey_kind = admission.journey_kind.as_str();
        tx.execute(
            "INSERT INTO agent_run_lifecycle.agent_runs
                 (run_id, root_run_id, principal_id, journey_kind,
                  persistence_profile, workload_ordinal, state)
             VALUES ($1, $1, $2, $3, 'durable-thread-replay', $4, 'pending')",
            &[
                &run_id,
                &admission.account_id,
                &journey_kind,
                &root_sequence,
            ],
        )
        .await?;
        let semantic_config = format!(
            "SemanticConfig:v1:{}:{}:durable-thread-replay",
            admission.account_id, journey_kind
        );
        tx.execute(
            "INSERT INTO agent_run_lifecycle.interaction_records
                 (run_id, sequence, semantic_record)
             VALUES ($1, 1, 'UserMessage:v1'), ($1, 2, $2)",
            &[&run_id, &semantic_config],
        )
        .await?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.thread_events
                 (account_id, thread_id, sequence, event_id, event_type, content, run_id)
             VALUES ($1, $2, $3, $4, 'user.message.accepted', $5, $6)",
            &[
                &admission.account_id,
                &admission.thread_id,
                &event_sequence,
                &admission.message_id,
                &admission.content,
                &run_id,
            ],
        )
        .await?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.message_admission_receipts
                 (account_id, idempotency_key, request_hash, thread_id,
                  event_sequence, run_id)
             VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &admission.account_id,
                &admission.idempotency_key,
                &admission.request_hash,
                &admission.thread_id,
                &event_sequence,
                &run_id,
            ],
        )
        .await?;
        tx.execute(
            "SELECT pg_notify('osfo_thread_events', $1)",
            &[&format!("{}:{}", admission.account_id, admission.thread_id)],
        )
        .await?;
        tx.commit().await?;
        Ok(MessageReceipt {
            run_id: RunId::from(run_id.as_str()),
            event_sequence: event_sequence as u64,
            idempotent_replay: false,
        })
    }

    pub async fn replay(
        &self,
        account_id: &str,
        thread_id: &str,
        after_sequence: u64,
        limit: usize,
    ) -> Result<Vec<ThreadEvent>> {
        if account_id.trim().is_empty() || thread_id.trim().is_empty() {
            bail!("account and thread identity are required");
        }
        let limit = limit.clamp(1, MAX_REPLAY_EVENTS) as i64;
        let client = self.pool.get().await?;
        Ok(client
            .query(
                "SELECT sequence, event_id, event_type, content, run_id
                 FROM agent_run_lifecycle.thread_events
                 WHERE account_id = $1 AND thread_id = $2 AND sequence > $3
                 ORDER BY sequence
                 LIMIT $4",
                &[&account_id, &thread_id, &(after_sequence as i64), &limit],
            )
            .await?
            .into_iter()
            .map(thread_event_from_row)
            .collect())
    }

    pub async fn claim_next(
        &self,
        worker_id: &str,
        lease: Duration,
    ) -> Result<Option<ClaimedMessageRun>> {
        let mut claims = self.claim_batch(worker_id, lease, 1).await?;
        Ok(claims.pop())
    }

    pub async fn claim_batch(
        &self,
        worker_id: &str,
        lease: Duration,
        limit: usize,
    ) -> Result<Vec<ClaimedMessageRun>> {
        if worker_id.trim().is_empty() {
            bail!("worker identity is required");
        }
        if !(1..=256).contains(&limit) {
            bail!("claim batch limit must be between 1 and 256");
        }
        let lease_ms = lease.as_millis().max(1) as i64;
        let limit = limit as i64;
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let mut rows = tx
            .query(
                "WITH candidate AS (
                     SELECT run_id, state
                     FROM agent_run_lifecycle.agent_runs
                     WHERE workload_ordinal IS NOT NULL
                       AND state IN ('pending', 'retry_ready')
                     ORDER BY created_at, run_id
                     FOR UPDATE SKIP LOCKED
                     LIMIT $3
                 )
                 UPDATE agent_run_lifecycle.agent_runs a
                 SET state = 'running', claim_epoch = claim_epoch + 1, owner = $1,
                     lease_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
                 FROM candidate
                 WHERE a.run_id = candidate.run_id
                 RETURNING a.run_id, a.parent_run_id, a.claim_epoch, a.principal_id,
                           a.journey_kind, a.workload_ordinal, candidate.state",
                &[&worker_id, &lease_ms, &limit],
            )
            .await?;
        if rows.is_empty() {
            rows = tx
                .query(
                    "WITH candidate AS (
                         SELECT run_id, state
                         FROM agent_run_lifecycle.agent_runs
                         WHERE workload_ordinal IS NOT NULL
                           AND state = 'running'
                           AND lease_until < clock_timestamp()
                         ORDER BY lease_until, created_at, run_id
                         FOR UPDATE SKIP LOCKED
                         LIMIT $3
                     )
                     UPDATE agent_run_lifecycle.agent_runs a
                     SET state = 'running', claim_epoch = claim_epoch + 1, owner = $1,
                         lease_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
                     FROM candidate
                     WHERE a.run_id = candidate.run_id
                     RETURNING a.run_id, a.parent_run_id, a.claim_epoch, a.principal_id,
                               a.journey_kind, a.workload_ordinal, candidate.state",
                    &[&worker_id, &lease_ms, &limit],
                )
                .await?;
        }
        if rows.is_empty() {
            tx.commit().await?;
            return Ok(Vec::new());
        }
        let run_ids = rows
            .iter()
            .map(|row| row.get::<_, String>(0))
            .collect::<Vec<_>>();
        let claim_records = rows
            .iter()
            .map(|row| {
                let claim_epoch: i64 = row.get(2);
                let previous_state: String = row.get(6);
                if previous_state == "running" {
                    format!("AgentRunTakenOver:{claim_epoch}")
                } else {
                    format!("AgentRunClaimed:{claim_epoch}")
                }
            })
            .collect::<Vec<_>>();
        tx.execute(
            "INSERT INTO agent_run_lifecycle.interaction_records
                 (run_id, sequence, semantic_record)
             SELECT claimed.run_id, COALESCE(max(existing.sequence), 0) + 1,
                    claimed.semantic_record
             FROM unnest($1::text[], $2::text[])
                  AS claimed(run_id, semantic_record)
             LEFT JOIN agent_run_lifecycle.interaction_records existing
               ON existing.run_id = claimed.run_id
             GROUP BY claimed.run_id, claimed.semantic_record",
            &[&run_ids, &claim_records],
        )
        .await?;
        let claims = rows
            .into_iter()
            .map(|row| {
                let run_id: String = row.get(0);
                let parent_run_id: Option<String> = row.get(1);
                let claim_epoch: i64 = row.get(2);
                let account_id: String = row.get(3);
                let journey_kind: String = row.get(4);
                let workload_ordinal: i64 = row.get(5);
                Ok(ClaimedMessageRun {
                    run_id: RunId::from(run_id.as_str()),
                    parent_run_id: parent_run_id.map(|value| RunId::from(value.as_str())),
                    claim_epoch: claim_epoch as u64,
                    account_id,
                    journey_kind: JourneyKind::parse(&journey_kind)?,
                    workload_ordinal: workload_ordinal as u64,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        tx.commit().await?;
        Ok(claims)
    }

    pub async fn begin_child_fanout(
        &self,
        parent_run_id: &RunId,
        parent_claim_epoch: u64,
        child_count: usize,
    ) -> Result<Vec<RunId>> {
        if !(1..=16).contains(&child_count) {
            bail!("child fanout must contain between 1 and 16 AgentRuns");
        }
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let parent = tx
            .query_opt(
                "SELECT state, claim_epoch, root_run_id, principal_id,
                        persistence_profile, workload_ordinal
                 FROM agent_run_lifecycle.agent_runs
                 WHERE run_id = $1 FOR UPDATE",
                &[&parent_run_id.as_str()],
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("parent AgentRun is missing"))?;
        let state: String = parent.get(0);
        let current_epoch: i64 = parent.get(1);
        if state != "running" || current_epoch != parent_claim_epoch as i64 {
            bail!("stale or inactive parent AgentRunAttempt");
        }
        let root_run_id: String = parent.get(2);
        let principal_id: String = parent.get(3);
        let persistence_profile: String = parent.get(4);
        let workload_ordinal: i64 = parent.get(5);
        let join_id = format!("join:{}", parent_run_id.as_str());
        tx.execute(
            "INSERT INTO agent_run_lifecycle.child_joins
                 (join_id, parent_run_id, mode)
             VALUES ($1, $2, 'all_terminal')",
            &[&join_id, &parent_run_id.as_str()],
        )
        .await?;

        let mut child_run_ids = Vec::with_capacity(child_count);
        for stable_order in 0..child_count {
            let child_run_id = format!("{}-child-{}", parent_run_id.as_str(), stable_order + 1);
            tx.execute(
                "INSERT INTO agent_run_lifecycle.agent_runs
                     (run_id, parent_run_id, root_run_id, principal_id,
                      journey_kind, persistence_profile, workload_ordinal, state)
                 VALUES ($1, $2, $3, $4, 'basic-agent-run', $5, $6, 'pending')",
                &[
                    &child_run_id,
                    &parent_run_id.as_str(),
                    &root_run_id,
                    &principal_id,
                    &persistence_profile,
                    &workload_ordinal,
                ],
            )
            .await?;
            tx.execute(
                "INSERT INTO agent_run_lifecycle.interaction_records
                     (run_id, sequence, semantic_record)
                 VALUES ($1, 1, 'ChildAgentRunAdmitted:v1')",
                &[&child_run_id],
            )
            .await?;
            tx.execute(
                "INSERT INTO agent_run_lifecycle.child_join_members
                     (join_id, child_run_id, stable_order)
                 VALUES ($1, $2, $3)",
                &[&join_id, &child_run_id, &(stable_order as i32)],
            )
            .await?;
            child_run_ids.push(RunId::from(child_run_id.as_str()));
        }
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'waiting', owner = NULL, lease_until = NULL
             WHERE run_id = $1",
            &[&parent_run_id.as_str()],
        )
        .await?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.interaction_records
                 (run_id, sequence, semantic_record)
             SELECT $1, COALESCE(max(sequence), 0) + 1, $2
             FROM agent_run_lifecycle.interaction_records
             WHERE run_id = $1",
            &[
                &parent_run_id.as_str(),
                &format!("ChildJoinOpened:{join_id}"),
            ],
        )
        .await?;
        tx.commit().await?;
        Ok(child_run_ids)
    }

    pub async fn child_fanout_started(&self, parent_run_id: &RunId) -> Result<bool> {
        let client = self.pool.get().await?;
        let started: bool = client
            .query_one(
                "SELECT EXISTS (
                     SELECT 1 FROM agent_run_lifecycle.child_joins
                     WHERE parent_run_id = $1
                 )",
                &[&parent_run_id.as_str()],
            )
            .await?
            .get(0);
        Ok(started)
    }

    pub async fn detached_children_started(&self, parent_run_id: &RunId) -> Result<bool> {
        let client = self.pool.get().await?;
        let started: bool = client
            .query_one(
                "SELECT EXISTS (
                     SELECT 1 FROM agent_run_lifecycle.agent_runs child
                     WHERE child.parent_run_id = $1
                       AND child.run_id LIKE $1 || '-detached-child-%'
                 )",
                &[&parent_run_id.as_str()],
            )
            .await?
            .get(0);
        Ok(started)
    }

    pub async fn begin_detached_children(
        &self,
        parent_run_id: &RunId,
        parent_claim_epoch: u64,
        child_count: usize,
    ) -> Result<Vec<RunId>> {
        if !(1..=16).contains(&child_count) {
            bail!("detached child fanout must contain between 1 and 16 AgentRuns");
        }
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let parent = tx
            .query_opt(
                "SELECT state, claim_epoch, root_run_id, principal_id,
                        persistence_profile, workload_ordinal
                 FROM agent_run_lifecycle.agent_runs
                 WHERE run_id = $1 FOR UPDATE",
                &[&parent_run_id.as_str()],
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("parent AgentRun is missing"))?;
        let state: String = parent.get(0);
        let current_epoch: i64 = parent.get(1);
        if state != "running" || current_epoch != parent_claim_epoch as i64 {
            bail!("stale or inactive parent AgentRunAttempt");
        }
        let root_run_id: String = parent.get(2);
        let principal_id: String = parent.get(3);
        let persistence_profile: String = parent.get(4);
        let workload_ordinal: i64 = parent.get(5);
        let mut child_run_ids = Vec::with_capacity(child_count);
        for stable_order in 0..child_count {
            let child_run_id = format!(
                "{}-detached-child-{}",
                parent_run_id.as_str(),
                stable_order + 1
            );
            tx.execute(
                "INSERT INTO agent_run_lifecycle.agent_runs
                     (run_id, parent_run_id, root_run_id, principal_id,
                      journey_kind, persistence_profile, workload_ordinal, state)
                 VALUES ($1, $2, $3, $4, 'basic-agent-run', $5, $6, 'pending')",
                &[
                    &child_run_id,
                    &parent_run_id.as_str(),
                    &root_run_id,
                    &principal_id,
                    &persistence_profile,
                    &workload_ordinal,
                ],
            )
            .await?;
            tx.execute(
                "INSERT INTO agent_run_lifecycle.interaction_records
                     (run_id, sequence, semantic_record)
                 VALUES ($1, 1, 'DetachedChildAgentRunAdmitted:v1')",
                &[&child_run_id],
            )
            .await?;
            child_run_ids.push(RunId::from(child_run_id.as_str()));
        }
        append_interaction_record(
            &tx,
            parent_run_id,
            &format!("DetachedChildrenAdmitted:{child_count}"),
        )
        .await?;
        tx.commit().await?;
        Ok(child_run_ids)
    }

    pub async fn complete_child(
        &self,
        child_run_id: &RunId,
        child_claim_epoch: u64,
        outcome: &str,
    ) -> Result<()> {
        if outcome != "succeeded" {
            bail!("the deterministic child lane currently supports only succeeded outcomes");
        }
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let child = tx
            .query_opt(
                "SELECT state, claim_epoch, parent_run_id
                 FROM agent_run_lifecycle.agent_runs
                 WHERE run_id = $1 FOR UPDATE",
                &[&child_run_id.as_str()],
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("child AgentRun is missing"))?;
        let state: String = child.get(0);
        let current_epoch: i64 = child.get(1);
        let parent_run_id: Option<String> = child.get(2);
        let parent_run_id =
            parent_run_id.ok_or_else(|| anyhow::anyhow!("AgentRun is not a child"))?;
        if state != "running" || current_epoch != child_claim_epoch as i64 {
            tx.execute(
                "INSERT INTO agent_run_lifecycle.stale_commit_rejections
                     (run_id, attempted_epoch, current_epoch)
                 VALUES ($1, $2, $3)",
                &[
                    &child_run_id.as_str(),
                    &(child_claim_epoch as i64),
                    &current_epoch,
                ],
            )
            .await?;
            tx.commit().await?;
            bail!("stale or inactive child AgentRunAttempt");
        }
        let member = tx
            .query_opt(
                "SELECT join_id, terminal
                 FROM agent_run_lifecycle.child_join_members
                 WHERE child_run_id = $1 FOR UPDATE",
                &[&child_run_id.as_str()],
            )
            .await?;
        if member.is_none() {
            tx.execute(
                "UPDATE agent_run_lifecycle.agent_runs
                 SET state = 'succeeded', owner = NULL, lease_until = NULL,
                     terminal_at = clock_timestamp()
                 WHERE run_id = $1",
                &[&child_run_id.as_str()],
            )
            .await?;
            append_interaction_record(&tx, child_run_id, "DetachedAgentRunTerminal:succeeded")
                .await?;
            tx.commit().await?;
            return Ok(());
        }
        let member = member.expect("detached child returned early");
        let join_id: String = member.get(0);
        let already_terminal: bool = member.get(1);
        if already_terminal {
            tx.commit().await?;
            return Ok(());
        }
        let join = tx
            .query_one(
                "SELECT settled FROM agent_run_lifecycle.child_joins
                 WHERE join_id = $1 FOR UPDATE",
                &[&join_id],
            )
            .await?;
        let settled: bool = join.get(0);
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'succeeded', owner = NULL, lease_until = NULL,
                 terminal_at = clock_timestamp()
             WHERE run_id = $1",
            &[&child_run_id.as_str()],
        )
        .await?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.interaction_records
                 (run_id, sequence, semantic_record)
             SELECT $1, COALESCE(max(sequence), 0) + 1, 'AgentRunTerminal:succeeded'
             FROM agent_run_lifecycle.interaction_records
             WHERE run_id = $1",
            &[&child_run_id.as_str()],
        )
        .await?;
        tx.execute(
            "UPDATE agent_run_lifecycle.child_join_members
             SET terminal = true, outcome = $2
             WHERE join_id = $1 AND child_run_id = $3",
            &[&join_id, &outcome, &child_run_id.as_str()],
        )
        .await?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.interaction_records
                 (run_id, sequence, semantic_record)
             SELECT $1, COALESCE(max(sequence), 0) + 1, $2
             FROM agent_run_lifecycle.interaction_records
             WHERE run_id = $1",
            &[
                &parent_run_id,
                &format!("ChildOutcome:{}:{outcome}", child_run_id.as_str()),
            ],
        )
        .await?;
        let remaining: i64 = tx
            .query_one(
                "SELECT count(*) FROM agent_run_lifecycle.child_join_members
                 WHERE join_id = $1 AND terminal = false",
                &[&join_id],
            )
            .await?
            .get(0);
        if remaining == 0 && !settled {
            tx.execute(
                "UPDATE agent_run_lifecycle.child_joins
                 SET settled = true, settled_at = clock_timestamp()
                 WHERE join_id = $1",
                &[&join_id],
            )
            .await?;
            let woke = tx
                .execute(
                    "UPDATE agent_run_lifecycle.agent_runs
                     SET state = 'pending', wake_count = wake_count + 1
                     WHERE run_id = $1 AND state = 'waiting'",
                    &[&parent_run_id],
                )
                .await?;
            if woke != 1 {
                bail!("settled ChildJoin parent was not waiting");
            }
            tx.execute(
                "INSERT INTO agent_run_lifecycle.interaction_records
                     (run_id, sequence, semantic_record)
                 SELECT $1, COALESCE(max(sequence), 0) + 1, $2
                 FROM agent_run_lifecycle.interaction_records
                 WHERE run_id = $1",
                &[&parent_run_id, &format!("ChildJoinSettled:{join_id}")],
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn commit_assistant_output(
        &self,
        run_id: &RunId,
        claim_epoch: u64,
        content: &str,
    ) -> Result<ThreadEvent> {
        if content.trim().is_empty() || content.len() > MAX_MESSAGE_BYTES {
            bail!("assistant output must be between 1 byte and 64 KiB");
        }
        let mut client = self.pool.get().await?;
        let tx = client.transaction().await?;
        let row = tx
            .query_opt(
                "SELECT state, claim_epoch, journey_kind, workload_ordinal
                 FROM agent_run_lifecycle.agent_runs
                 WHERE run_id = $1 FOR UPDATE",
                &[&run_id.as_str()],
            )
            .await?;
        let row = row.ok_or_else(|| anyhow::anyhow!("AgentRun is missing"))?;
        let state: String = row.get(0);
        let current_epoch: i64 = row.get(1);
        let journey_kind: String = row.get(2);
        let workload_ordinal: i64 = row.get(3);
        if state != "running" || current_epoch != claim_epoch as i64 {
            tx.execute(
                "INSERT INTO agent_run_lifecycle.stale_commit_rejections
                     (run_id, attempted_epoch, current_epoch)
                 VALUES ($1, $2, $3)",
                &[&run_id.as_str(), &(claim_epoch as i64), &current_epoch],
            )
            .await?;
            tx.commit().await?;
            bail!("stale or inactive AgentRunAttempt");
        }
        record_deterministic_dependency_outcomes(
            &tx,
            run_id,
            &journey_kind,
            workload_ordinal as u64,
        )
        .await?;
        let event_id = format!("assistant:{}", run_id.as_str());
        let committed = tx
            .query_opt(
                "WITH location AS (
                     SELECT account_id, thread_id
                     FROM agent_run_lifecycle.thread_events
                     WHERE run_id = $1 AND event_type = 'user.message.accepted'
                 ), advanced AS (
                     UPDATE agent_run_lifecycle.threads thread
                     SET next_sequence = thread.next_sequence + 1
                     FROM location
                     WHERE thread.account_id = location.account_id
                       AND thread.thread_id = location.thread_id
                     RETURNING thread.account_id, thread.thread_id,
                               thread.next_sequence - 1 AS sequence
                 ), inserted_event AS (
                     INSERT INTO agent_run_lifecycle.thread_events
                         (account_id, thread_id, sequence, event_id, event_type,
                          content, run_id)
                     SELECT account_id, thread_id, sequence, $3,
                            'assistant.message.completed', $4, $1
                     FROM advanced
                     RETURNING account_id, thread_id, sequence, event_id
                 ), interaction AS (
                     INSERT INTO agent_run_lifecycle.interaction_records
                         (run_id, sequence, record_id, semantic_record)
                     SELECT $1, COALESCE(max(sequence), 0) + 1, $3,
                            'AssistantOutputFragment:v1:terminal'
                     FROM agent_run_lifecycle.interaction_records
                     WHERE run_id = $1
                     RETURNING run_id
                 ), terminal AS (
                     UPDATE agent_run_lifecycle.agent_runs
                     SET state = 'succeeded', owner = NULL, lease_until = NULL,
                         terminal_at = clock_timestamp()
                     WHERE run_id = $1 AND state = 'running' AND claim_epoch = $2
                       AND EXISTS (SELECT 1 FROM interaction)
                     RETURNING run_id
                 ), notified AS (
                     SELECT pg_notify(
                         'osfo_thread_events',
                         inserted_event.account_id || ':' || inserted_event.thread_id
                     )
                     FROM inserted_event, terminal
                 )
                 SELECT inserted_event.account_id, inserted_event.thread_id,
                        inserted_event.sequence, inserted_event.event_id
                 FROM inserted_event, terminal, notified",
                &[&run_id.as_str(), &(claim_epoch as i64), &event_id, &content],
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("AgentRun terminal commit lost its fence"))?;
        let event_sequence: i64 = committed.get(2);
        tx.commit().await?;
        Ok(ThreadEvent {
            sequence: event_sequence as u64,
            event_id,
            event_type: "assistant.message.completed".into(),
            content: content.into(),
            run_id: run_id.clone(),
        })
    }

    pub async fn run_state(&self, run_id: &RunId) -> Result<RunState> {
        let client = self.pool.get().await?;
        let state: String = client
            .query_one(
                "SELECT state FROM agent_run_lifecycle.agent_runs WHERE run_id = $1",
                &[&run_id.as_str()],
            )
            .await?
            .get(0);
        parse_state(&state)
    }

    pub async fn ping(&self) -> Result<()> {
        let client = self.pool.get().await?;
        client.query_one("SELECT 1", &[]).await?;
        Ok(())
    }

    pub async fn run_evidence(
        &self,
        account_id: &str,
        run_id: &str,
    ) -> Result<Option<RunEvidenceSnapshot>> {
        let client = self.pool.get().await?;
        let row = client
            .query_opt(
                "SELECT root.run_id, root.journey_kind, root.state,
                        CASE WHEN root.terminal_at IS NULL THEN NULL
                             ELSE (extract(epoch FROM root.terminal_at) * 1000000)::bigint
                        END,
                        root.claim_epoch, root.wake_count,
                        (SELECT count(*) FROM agent_run_lifecycle.agent_runs a
                         WHERE a.root_run_id = root.root_run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.agent_runs a
                         WHERE a.root_run_id = root.root_run_id
                           AND a.parent_run_id IS NOT NULL),
                        (SELECT count(*) FROM agent_run_lifecycle.agent_runs a
                         JOIN agent_run_lifecycle.child_join_members member
                           ON member.child_run_id = a.run_id
                         WHERE a.root_run_id = root.root_run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.agent_runs a
                         WHERE a.root_run_id = root.root_run_id
                           AND a.parent_run_id IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1 FROM agent_run_lifecycle.child_join_members member
                               WHERE member.child_run_id = a.run_id
                           )),
                        (SELECT count(*) FROM agent_run_lifecycle.agent_runs a
                         WHERE a.root_run_id = root.root_run_id
                           AND a.state IN ('succeeded', 'failed', 'canceled')),
                        (SELECT count(*) FROM agent_run_lifecycle.interaction_records r
                         JOIN agent_run_lifecycle.agent_runs a ON a.run_id = r.run_id
                         WHERE a.root_run_id = root.root_run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.thread_events e
                         WHERE e.account_id = $1 AND e.run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.workflow_instances w
                         WHERE w.parent_run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.workflow_deliveries d
                         JOIN agent_run_lifecycle.workflow_instances w
                           ON w.workflow_instance_id = d.workflow_instance_id
                         WHERE w.parent_run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.workflow_activities activity
                         JOIN agent_run_lifecycle.workflow_instances w
                           ON w.workflow_instance_id = activity.workflow_instance_id
                         WHERE w.parent_run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.tool_calls t
                         WHERE t.run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.approvals approval
                         JOIN agent_run_lifecycle.tool_calls t
                           ON t.tool_call_id = approval.tool_call_id
                         WHERE t.run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.tool_attempts attempt
                         JOIN agent_run_lifecycle.tool_calls t
                           ON t.tool_call_id = attempt.tool_call_id
                         WHERE t.run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.proactive_messages message
                         WHERE message.run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.scheduled_reminders reminder
                         WHERE reminder.run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.sandbox_jobs job
                         WHERE job.run_id = root.run_id),
                        (SELECT count(*) FROM agent_run_lifecycle.artifact_commits artifact
                         WHERE artifact.run_id = root.run_id),
                        COALESCE((
                            SELECT decision.quick_reply
                            FROM agent_run_lifecycle.agent_decisions decision
                            WHERE decision.run_id = root.run_id
                        ), false),
                        COALESCE((
                            SELECT
                                decision.child_agent_runs = (
                                    SELECT count(*) FROM agent_run_lifecycle.agent_runs child
                                    WHERE child.root_run_id = root.root_run_id
                                      AND child.parent_run_id IS NOT NULL
                                )
                                AND decision.awaited_child_agent_runs = (
                                    SELECT count(*) FROM agent_run_lifecycle.agent_runs child
                                    JOIN agent_run_lifecycle.child_join_members member
                                      ON member.child_run_id = child.run_id
                                    WHERE child.root_run_id = root.root_run_id
                                )
                                AND decision.detached_child_agent_runs = (
                                    SELECT count(*) FROM agent_run_lifecycle.agent_runs child
                                    WHERE child.root_run_id = root.root_run_id
                                      AND child.parent_run_id IS NOT NULL
                                      AND NOT EXISTS (
                                          SELECT 1 FROM agent_run_lifecycle.child_join_members member
                                          WHERE member.child_run_id = child.run_id
                                      )
                                )
                                AND decision.temporal_workflows = (
                                    SELECT count(*) FROM agent_run_lifecycle.workflow_instances workflow
                                    WHERE workflow.parent_run_id = root.run_id
                                )
                                AND decision.temporal_activities = (
                                    SELECT count(*) FROM agent_run_lifecycle.workflow_activities activity
                                    JOIN agent_run_lifecycle.workflow_instances workflow
                                      ON workflow.workflow_instance_id = activity.workflow_instance_id
                                    WHERE workflow.parent_run_id = root.run_id
                                )
                                AND decision.approvals = (
                                    SELECT count(*) FROM agent_run_lifecycle.approvals approval
                                    JOIN agent_run_lifecycle.tool_calls tool
                                      ON tool.tool_call_id = approval.tool_call_id
                                    WHERE tool.run_id = root.run_id
                                )
                                AND decision.tool_calls = (
                                    SELECT count(*) FROM agent_run_lifecycle.tool_calls tool
                                    WHERE tool.run_id = root.run_id
                                )
                                AND decision.proactive_messages = (
                                    SELECT count(*) FROM agent_run_lifecycle.proactive_messages message
                                    WHERE message.run_id = root.run_id
                                )
                                AND decision.scheduled_reminders = (
                                    SELECT count(*) FROM agent_run_lifecycle.scheduled_reminders reminder
                                    WHERE reminder.run_id = root.run_id
                                )
                                AND decision.sandbox_jobs = (
                                    SELECT count(*) FROM agent_run_lifecycle.sandbox_jobs job
                                    WHERE job.run_id = root.run_id
                                )
                                AND decision.artifact_commits = (
                                    SELECT count(*) FROM agent_run_lifecycle.artifact_commits artifact
                                    WHERE artifact.run_id = root.run_id
                                )
                            FROM agent_run_lifecycle.agent_decisions decision
                            WHERE decision.run_id = root.run_id
                        ), false),
                        (SELECT count(*) FROM agent_run_lifecycle.stale_commit_rejections rejection
                         JOIN agent_run_lifecycle.agent_runs a ON a.run_id = rejection.run_id
                         WHERE a.root_run_id = root.root_run_id)
                 FROM agent_run_lifecycle.agent_runs root
                 WHERE root.run_id = $2 AND root.principal_id = $1
                   AND root.parent_run_id IS NULL",
                &[&account_id, &run_id],
            )
            .await?;
        Ok(row.map(|row| RunEvidenceSnapshot {
            run_id: row.get(0),
            journey_kind: row.get(1),
            root_state: row.get(2),
            root_terminal_at_unix_microseconds: row
                .get::<_, Option<i64>>(3)
                .map(|value| value as u64),
            claim_epoch: row.get::<_, i64>(4) as u64,
            wake_count: row.get::<_, i64>(5) as u64,
            total_agent_runs: row.get::<_, i64>(6) as u64,
            child_agent_runs: row.get::<_, i64>(7) as u64,
            awaited_child_agent_runs: row.get::<_, i64>(8) as u64,
            detached_child_agent_runs: row.get::<_, i64>(9) as u64,
            terminal_agent_runs: row.get::<_, i64>(10) as u64,
            interaction_records: row.get::<_, i64>(11) as u64,
            thread_events: row.get::<_, i64>(12) as u64,
            workflow_instances: row.get::<_, i64>(13) as u64,
            workflow_deliveries: row.get::<_, i64>(14) as u64,
            workflow_activities: row.get::<_, i64>(15) as u64,
            tool_calls: row.get::<_, i64>(16) as u64,
            approvals: row.get::<_, i64>(17) as u64,
            tool_attempts: row.get::<_, i64>(18) as u64,
            proactive_messages: row.get::<_, i64>(19) as u64,
            scheduled_reminders: row.get::<_, i64>(20) as u64,
            sandbox_jobs: row.get::<_, i64>(21) as u64,
            artifact_commits: row.get::<_, i64>(22) as u64,
            quick_reply: row.get(23),
            decision_matches_actual: row.get(24),
            stale_commit_rejections: row.get::<_, i64>(25) as u64,
        }))
    }

    pub async fn count_root_runs(&self) -> Result<u64> {
        let client = self.pool.get().await?;
        let count: i64 = client
            .query_one(
                "SELECT count(*) FROM agent_run_lifecycle.agent_runs
                 WHERE parent_run_id IS NULL",
                &[],
            )
            .await?
            .get(0);
        Ok(count as u64)
    }

    pub async fn count_child_runs(&self) -> Result<u64> {
        let client = self.pool.get().await?;
        let count: i64 = client
            .query_one(
                "SELECT count(*) FROM agent_run_lifecycle.agent_runs
                 WHERE parent_run_id IS NOT NULL",
                &[],
            )
            .await?
            .get(0);
        Ok(count as u64)
    }

    pub async fn count_events(&self) -> Result<u64> {
        let client = self.pool.get().await?;
        let count: i64 = client
            .query_one(
                "SELECT count(*) FROM agent_run_lifecycle.thread_events",
                &[],
            )
            .await?
            .get(0);
        Ok(count as u64)
    }
}

async fn record_deterministic_dependency_outcomes(
    tx: &tokio_postgres::Transaction<'_>,
    run_id: &RunId,
    journey_kind: &str,
    workload_ordinal: u64,
) -> Result<()> {
    let journey_kind = JourneyKind::parse(journey_kind)?;
    let decision = deterministic_decision(journey_kind, workload_ordinal.saturating_sub(1));
    decision.validate()?;
    let source = if journey_kind == JourneyKind::MeasuredAgentDecision {
        "openai/gpt-5.6-luna:osfo-agent-decision-v1:deterministic-replay"
    } else {
        "issue13-deterministic-adapter"
    };
    tx.execute(
        "INSERT INTO agent_run_lifecycle.agent_decisions
             (run_id, source, quick_reply, child_agent_runs,
              awaited_child_agent_runs, detached_child_agent_runs,
              temporal_workflows, temporal_activities, approvals, tool_calls,
              proactive_messages, scheduled_reminders, sandbox_jobs,
              artifact_commits)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
        &[
            &run_id.as_str(),
            &source,
            &decision.quick_reply,
            &i32::from(decision.child_agent_runs),
            &i32::from(decision.awaited_child_agent_runs),
            &i32::from(decision.detached_child_agent_runs),
            &i32::from(decision.temporal_workflows),
            &i32::from(decision.temporal_activities),
            &i32::from(decision.approvals),
            &i32::from(decision.tool_calls),
            &i32::from(decision.proactive_messages),
            &i32::from(decision.scheduled_reminders),
            &i32::from(decision.sandbox_jobs),
            &i32::from(decision.artifact_commits),
        ],
    )
    .await?;

    let mut workflow_ids = Vec::with_capacity(usize::from(decision.temporal_workflows));
    for ordinal in 0..decision.temporal_workflows {
        let workflow_instance_id = format!("workflow:{}:{ordinal}", run_id.as_str());
        let workflow_tool_call_id = format!("workflow-tool:{}:{ordinal}", run_id.as_str());
        let delivery_id = format!("workflow-delivery:{}:{ordinal}", run_id.as_str());
        tx.execute(
            "INSERT INTO agent_run_lifecycle.workflow_instances
                 (workflow_instance_id, parent_run_id, tool_call_id, mode, state,
                  outcome, terminal_at)
             VALUES ($1, $2, $3, $4, 'succeeded',
                     'deterministic-adapter:succeeded', clock_timestamp())",
            &[
                &workflow_instance_id,
                &run_id.as_str(),
                &workflow_tool_call_id,
                &"awaited",
            ],
        )
        .await?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.workflow_deliveries
                 (delivery_id, workflow_instance_id)
             VALUES ($1, $2)",
            &[&delivery_id, &workflow_instance_id],
        )
        .await?;
        append_interaction_record(
            tx,
            run_id,
            "WorkflowOutcome:deterministic-adapter:succeeded",
        )
        .await?;
        workflow_ids.push(workflow_instance_id);
    }

    for ordinal in 0..decision.temporal_activities {
        let workflow_instance_id = &workflow_ids[usize::from(ordinal) % workflow_ids.len()];
        tx.execute(
            "INSERT INTO agent_run_lifecycle.workflow_activities
                 (activity_id, workflow_instance_id, state)
             VALUES ($1, $2, 'succeeded')",
            &[
                &format!("activity:{}:{ordinal}", run_id.as_str()),
                workflow_instance_id,
            ],
        )
        .await?;
    }

    for ordinal in 0..decision.tool_calls {
        let tool_call_id = format!("smtp-tool:{}:{ordinal}", run_id.as_str());
        tx.execute(
            "INSERT INTO agent_run_lifecycle.tool_calls
                 (tool_call_id, run_id, kind, state, attempt_count,
                  terminal_outcome, terminal_at)
             VALUES ($1, $2, 'send_email', 'succeeded', 1,
                     'deterministic-adapter:mailpit-accepted', clock_timestamp())",
            &[&tool_call_id, &run_id.as_str()],
        )
        .await?;
        if ordinal < decision.approvals {
            let approval_id = format!("approval:{}:{ordinal}", run_id.as_str());
            let decision_id = format!("approval-decision:{}:{ordinal}", run_id.as_str());
            tx.execute(
                "INSERT INTO agent_run_lifecycle.approvals
                     (approval_id, tool_call_id, state, decision_id, decided_at)
                 VALUES ($1, $2, 'approved', $3, clock_timestamp())",
                &[&approval_id, &tool_call_id, &decision_id],
            )
            .await?;
        }
        let attempt_id = format!("smtp-attempt:{}:{ordinal}", run_id.as_str());
        tx.execute(
            "INSERT INTO agent_run_lifecycle.tool_attempts
                 (attempt_id, tool_call_id, claim_epoch, state, outcome, completed_at)
             VALUES ($1, $2, $3, 'succeeded',
                     'deterministic-adapter:mailpit-accepted', clock_timestamp())",
            &[&attempt_id, &tool_call_id, &(1_i64)],
        )
        .await?;
    }

    for ordinal in 0..decision.proactive_messages {
        tx.execute(
            "INSERT INTO agent_run_lifecycle.proactive_messages
                 (proactive_message_id, run_id, state)
             VALUES ($1, $2, 'delivered')",
            &[
                &format!("proactive:{}:{ordinal}", run_id.as_str()),
                &run_id.as_str(),
            ],
        )
        .await?;
    }
    for ordinal in 0..decision.scheduled_reminders {
        tx.execute(
            "INSERT INTO agent_run_lifecycle.scheduled_reminders
                 (reminder_id, run_id, workflow_instance_id, state)
             VALUES ($1, $2, $3, 'scheduled')",
            &[
                &format!("reminder:{}:{ordinal}", run_id.as_str()),
                &run_id.as_str(),
                &workflow_ids[usize::from(ordinal) % workflow_ids.len()],
            ],
        )
        .await?;
    }
    let mut sandbox_ids = Vec::with_capacity(usize::from(decision.sandbox_jobs));
    for ordinal in 0..decision.sandbox_jobs {
        let sandbox_job_id = format!("sandbox:{}:{ordinal}", run_id.as_str());
        tx.execute(
            "INSERT INTO agent_run_lifecycle.sandbox_jobs
                 (sandbox_job_id, run_id, state)
             VALUES ($1, $2, 'succeeded')",
            &[&sandbox_job_id, &run_id.as_str()],
        )
        .await?;
        sandbox_ids.push(sandbox_job_id);
    }
    for ordinal in 0..decision.artifact_commits {
        let sandbox_job_id = sandbox_ids
            .get(usize::from(ordinal) % sandbox_ids.len().max(1))
            .map(String::as_str);
        tx.execute(
            "INSERT INTO agent_run_lifecycle.artifact_commits
                 (artifact_id, run_id, sandbox_job_id, state, checksum_verified)
             VALUES ($1, $2, $3, 'committed', true)",
            &[
                &format!("artifact:{}:{ordinal}", run_id.as_str()),
                &run_id.as_str(),
                &sandbox_job_id,
            ],
        )
        .await?;
    }
    Ok(())
}

fn deterministic_decision(journey_kind: JourneyKind, workload_ordinal: u64) -> AgentDecision {
    if journey_kind == JourneyKind::MeasuredAgentDecision {
        return measured_replay_decision(workload_ordinal);
    }
    let mut decision = AgentDecision {
        decision_class: DecisionClass::DirectReply,
        quick_reply: journey_kind == JourneyKind::BasicAgentRun,
        child_agent_runs: 0,
        awaited_child_agent_runs: 0,
        detached_child_agent_runs: 0,
        temporal_workflows: 0,
        temporal_activities: 0,
        approvals: 0,
        tool_calls: 0,
        proactive_messages: 0,
        scheduled_reminders: 0,
        sandbox_jobs: 0,
        artifact_commits: 0,
    };
    if matches!(
        journey_kind,
        JourneyKind::ChildFanout | JourneyKind::FullReferenceJourney
    ) {
        decision.decision_class = DecisionClass::Research;
        decision.child_agent_runs = 2;
        decision.awaited_child_agent_runs = 2;
    }
    if matches!(
        journey_kind,
        JourneyKind::AwaitedWorkflow
            | JourneyKind::DetachedWorkflow
            | JourneyKind::FullReferenceJourney
    ) {
        decision.decision_class = DecisionClass::DurableWorkflow;
        decision.temporal_workflows = 1;
    }
    if matches!(
        journey_kind,
        JourneyKind::ApprovalSmtp | JourneyKind::FullReferenceJourney
    ) {
        decision.decision_class = DecisionClass::ExternalEffect;
        decision.approvals = 1;
        decision.tool_calls = 1;
    }
    if matches!(
        journey_kind,
        JourneyKind::SandboxArtifact | JourneyKind::FullReferenceJourney
    ) {
        decision.decision_class = DecisionClass::SandboxWork;
        decision.sandbox_jobs = 1;
        decision.artifact_commits = 1;
    }
    decision
}

async fn append_interaction_record(
    tx: &tokio_postgres::Transaction<'_>,
    run_id: &RunId,
    semantic_record: &str,
) -> Result<()> {
    tx.execute(
        "INSERT INTO agent_run_lifecycle.interaction_records
             (run_id, sequence, semantic_record)
         SELECT $1, COALESCE(max(sequence), 0) + 1, $2
         FROM agent_run_lifecycle.interaction_records
         WHERE run_id = $1",
        &[&run_id.as_str(), &semantic_record],
    )
    .await?;
    Ok(())
}

fn thread_event_from_row(row: tokio_postgres::Row) -> ThreadEvent {
    let sequence: i64 = row.get(0);
    let run_id: String = row.get(4);
    ThreadEvent {
        sequence: sequence as u64,
        event_id: row.get(1),
        event_type: row.get(2),
        content: row.get(3),
        run_id: RunId::from(run_id.as_str()),
    }
}

fn validate_admission(admission: &MessageAdmission) -> Result<()> {
    if admission.account_id.trim().is_empty()
        || admission.thread_id.trim().is_empty()
        || admission.idempotency_key.trim().is_empty()
        || admission.request_hash.trim().is_empty()
        || admission.message_id.trim().is_empty()
        || admission.content.trim().is_empty()
    {
        bail!("message admission identity and content are required");
    }
    if admission.content.len() > MAX_MESSAGE_BYTES {
        bail!("message content exceeds 64 KiB");
    }
    Ok(())
}

fn parse_state(state: &str) -> Result<RunState> {
    Ok(match state {
        "pending" => RunState::Pending,
        "running" => RunState::Running,
        "waiting" => RunState::Waiting,
        "retry_ready" => RunState::RetryReady,
        "succeeded" => RunState::Succeeded,
        "failed" => RunState::Failed,
        "canceled" => RunState::Canceled,
        _ => bail!("unknown AgentRun state {state}"),
    })
}
