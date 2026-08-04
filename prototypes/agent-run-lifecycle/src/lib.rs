use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::{Component, Path},
    process::{Command as ProcessCommand, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use postgres::{Client, NoTls, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub mod confirmation;
pub mod evidence;
pub mod ingress;
pub mod ingress_http;
pub mod latency;
pub mod load;
pub mod metrics;
#[cfg(feature = "lifecycle-evidence")]
pub mod production_lane;
pub mod reasoning_lane;
#[cfg(feature = "lifecycle-evidence")]
pub mod rig_lane;
#[cfg(feature = "temporal-cloud")]
pub mod temporal_lane;
pub mod workload;

pub fn load_local_environment() {
    let _ = dotenvy::dotenv();
}

const MAX_ACTIVE_RUNS_PER_ROOT: i64 = 64;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RunId(String);

impl From<&str> for RunId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl RunId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunState {
    Pending,
    Running,
    Waiting,
    RetryReady,
    Succeeded,
    Failed,
    Canceled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChildJoinMode {
    AllTerminal,
    FirstSuccessful,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunView {
    pub run_id: RunId,
    pub state: RunState,
    pub claim_epoch: u64,
    pub wake_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandOutcome {
    RunAdmitted(RunId),
    Applied,
    IdempotentReplay,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    AdmitUserMessage {
        idempotency_key: String,
        request_hash: String,
    },
    Claim {
        run_id: RunId,
        worker_id: String,
    },
    AdmitChildren {
        parent_run_id: RunId,
        parent_claim_epoch: u64,
        join_id: String,
        mode: ChildJoinMode,
        child_run_ids: Vec<RunId>,
    },
    CompleteChild {
        child_run_id: RunId,
        outcome: String,
    },
    StartAwaitedWorkflow {
        parent_run_id: RunId,
        parent_claim_epoch: u64,
        tool_call_id: String,
        workflow_instance_id: String,
    },
    DeliverWorkflowOutcome {
        workflow_instance_id: String,
        delivery_id: String,
        outcome: String,
    },
}

#[derive(Debug, Clone)]
struct RunRecord {
    view: RunView,
    semantic_records: Vec<String>,
}

#[derive(Debug, Clone)]
struct AdmissionReceipt {
    request_hash: String,
    run_id: RunId,
}

#[derive(Debug, Clone)]
struct ChildJoin {
    parent_run_id: RunId,
    mode: ChildJoinMode,
    children: Vec<RunId>,
    outcomes: HashMap<RunId, String>,
    settled: bool,
}

#[derive(Debug, Clone)]
struct AwaitedWorkflow {
    parent_run_id: RunId,
    workflow_instance_id: String,
    settled: bool,
}

#[derive(Debug, Default)]
pub struct MemoryLedger {
    runs: HashMap<RunId, RunRecord>,
    admissions: HashMap<String, AdmissionReceipt>,
    joins: HashMap<String, ChildJoin>,
    child_join: HashMap<RunId, String>,
    workflows: HashMap<String, AwaitedWorkflow>,
    workflow_deliveries: HashSet<String>,
    next_root: u64,
}

pub struct LifecycleManager {
    ledger: MemoryLedger,
}

impl LifecycleManager {
    pub fn new(ledger: MemoryLedger) -> Self {
        Self { ledger }
    }

    pub fn execute(&mut self, command: Command) -> Result<CommandOutcome> {
        match command {
            Command::AdmitUserMessage {
                idempotency_key,
                request_hash,
            } => self.admit_user_message(idempotency_key, request_hash),
            Command::Claim { run_id, worker_id } => self.claim(run_id, worker_id),
            Command::AdmitChildren {
                parent_run_id,
                parent_claim_epoch,
                join_id,
                mode,
                child_run_ids,
            } => self.admit_children(
                parent_run_id,
                parent_claim_epoch,
                join_id,
                mode,
                child_run_ids,
            ),
            Command::CompleteChild {
                child_run_id,
                outcome,
            } => self.complete_child(child_run_id, outcome),
            Command::StartAwaitedWorkflow {
                parent_run_id,
                parent_claim_epoch,
                tool_call_id: _,
                workflow_instance_id,
            } => {
                self.start_awaited_workflow(parent_run_id, parent_claim_epoch, workflow_instance_id)
            }
            Command::DeliverWorkflowOutcome {
                workflow_instance_id,
                delivery_id,
                outcome,
            } => self.deliver_workflow_outcome(workflow_instance_id, delivery_id, outcome),
        }
    }

    pub fn run(&self, run_id: &RunId) -> Option<RunView> {
        self.ledger.runs.get(run_id).map(|run| run.view.clone())
    }

    pub fn semantic_sequence(&self, run_id: &RunId) -> Vec<String> {
        self.ledger
            .runs
            .get(run_id)
            .map(|run| run.semantic_records.clone())
            .unwrap_or_default()
    }

    fn admit_user_message(
        &mut self,
        idempotency_key: String,
        request_hash: String,
    ) -> Result<CommandOutcome> {
        if let Some(receipt) = self.ledger.admissions.get(&idempotency_key) {
            if receipt.request_hash != request_hash {
                bail!("idempotency key reused with a different request hash");
            }
            return Ok(CommandOutcome::RunAdmitted(receipt.run_id.clone()));
        }

        self.ledger.next_root += 1;
        let run_id = if self.ledger.next_root == 1 {
            RunId::from("run-parent")
        } else {
            RunId(format!("run-root-{}", self.ledger.next_root))
        };
        self.ledger.runs.insert(
            run_id.clone(),
            RunRecord {
                view: RunView {
                    run_id: run_id.clone(),
                    state: RunState::Pending,
                    claim_epoch: 0,
                    wake_count: 0,
                },
                semantic_records: vec!["UserMessage:v1".into()],
            },
        );
        self.ledger.admissions.insert(
            idempotency_key,
            AdmissionReceipt {
                request_hash,
                run_id: run_id.clone(),
            },
        );
        Ok(CommandOutcome::RunAdmitted(run_id))
    }

    fn claim(&mut self, run_id: RunId, _worker_id: String) -> Result<CommandOutcome> {
        let run = self.run_mut(&run_id)?;
        if run.view.state != RunState::Pending && run.view.state != RunState::RetryReady {
            bail!("run is not claimable");
        }
        run.view.claim_epoch += 1;
        run.view.state = RunState::Running;
        run.semantic_records
            .push(format!("AgentRunClaimed:{}", run.view.claim_epoch));
        Ok(CommandOutcome::Applied)
    }

    fn admit_children(
        &mut self,
        parent_run_id: RunId,
        parent_claim_epoch: u64,
        join_id: String,
        mode: ChildJoinMode,
        child_run_ids: Vec<RunId>,
    ) -> Result<CommandOutcome> {
        if child_run_ids.is_empty() {
            bail!("a ChildJoin requires at least one child");
        }
        let parent = self.run_mut(&parent_run_id)?;
        validate_running_epoch(parent, parent_claim_epoch)?;
        parent.view.state = RunState::Waiting;
        parent
            .semantic_records
            .push(format!("ChildJoinOpened:{join_id}"));

        for child_run_id in &child_run_ids {
            if self.ledger.runs.contains_key(child_run_id) {
                bail!("child identity already exists");
            }
            self.ledger.runs.insert(
                child_run_id.clone(),
                RunRecord {
                    view: RunView {
                        run_id: child_run_id.clone(),
                        state: RunState::Pending,
                        claim_epoch: 0,
                        wake_count: 0,
                    },
                    semantic_records: vec!["ChildAgentRunAdmitted:v1".into()],
                },
            );
            self.ledger
                .child_join
                .insert(child_run_id.clone(), join_id.clone());
        }
        self.ledger.joins.insert(
            join_id,
            ChildJoin {
                parent_run_id,
                mode,
                children: child_run_ids,
                outcomes: HashMap::new(),
                settled: false,
            },
        );
        Ok(CommandOutcome::Applied)
    }

    fn complete_child(&mut self, child_run_id: RunId, outcome: String) -> Result<CommandOutcome> {
        let join_id = self
            .ledger
            .child_join
            .get(&child_run_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("child has no join"))?;
        let join = self
            .ledger
            .joins
            .get_mut(&join_id)
            .ok_or_else(|| anyhow::anyhow!("ChildJoin is missing"))?;
        if join.outcomes.contains_key(&child_run_id) {
            return Ok(CommandOutcome::IdempotentReplay);
        }
        join.outcomes.insert(child_run_id.clone(), outcome.clone());

        let child = self
            .ledger
            .runs
            .get_mut(&child_run_id)
            .ok_or_else(|| anyhow::anyhow!("child AgentRun is missing"))?;
        child.view.state = child_terminal_state(&outcome);

        let parent = self
            .ledger
            .runs
            .get_mut(&join.parent_run_id)
            .ok_or_else(|| anyhow::anyhow!("parent AgentRun is missing"))?;
        parent
            .semantic_records
            .push(format!("ChildOutcome:{}:{outcome}", child_run_id.0));

        let successful = !outcome.starts_with("failed:") && !outcome.starts_with("canceled:");
        let should_settle = match join.mode {
            ChildJoinMode::AllTerminal => join.outcomes.len() == join.children.len(),
            ChildJoinMode::FirstSuccessful => {
                successful || join.outcomes.len() == join.children.len()
            }
        };
        if should_settle && !join.settled {
            join.settled = true;
            parent
                .semantic_records
                .push(format!("ChildJoinSettled:{join_id}"));
            parent.view.state = RunState::Pending;
            parent.view.wake_count += 1;
        }
        Ok(CommandOutcome::Applied)
    }

    fn start_awaited_workflow(
        &mut self,
        parent_run_id: RunId,
        parent_claim_epoch: u64,
        workflow_instance_id: String,
    ) -> Result<CommandOutcome> {
        let parent = self.run_mut(&parent_run_id)?;
        validate_running_epoch(parent, parent_claim_epoch)?;
        parent.view.state = RunState::Waiting;
        parent
            .semantic_records
            .push(format!("WorkflowStartIntent:{workflow_instance_id}"));
        self.ledger.workflows.insert(
            workflow_instance_id.clone(),
            AwaitedWorkflow {
                parent_run_id,
                workflow_instance_id,
                settled: false,
            },
        );
        Ok(CommandOutcome::Applied)
    }

    fn deliver_workflow_outcome(
        &mut self,
        workflow_instance_id: String,
        delivery_id: String,
        outcome: String,
    ) -> Result<CommandOutcome> {
        if !self.ledger.workflow_deliveries.insert(delivery_id) {
            return Ok(CommandOutcome::IdempotentReplay);
        }
        let workflow = self
            .ledger
            .workflows
            .get_mut(&workflow_instance_id)
            .ok_or_else(|| anyhow::anyhow!("WorkflowInstance is missing"))?;
        if workflow.settled {
            return Ok(CommandOutcome::IdempotentReplay);
        }
        workflow.settled = true;
        let parent = self
            .ledger
            .runs
            .get_mut(&workflow.parent_run_id)
            .ok_or_else(|| anyhow::anyhow!("parent AgentRun is missing"))?;
        parent.semantic_records.push(format!(
            "WorkflowOutcome:{}:{outcome}",
            workflow.workflow_instance_id
        ));
        parent.view.state = RunState::Pending;
        parent.view.wake_count += 1;
        Ok(CommandOutcome::Applied)
    }

    fn run_mut(&mut self, run_id: &RunId) -> Result<&mut RunRecord> {
        self.ledger
            .runs
            .get_mut(run_id)
            .ok_or_else(|| anyhow::anyhow!("AgentRun is missing"))
    }
}

fn validate_running_epoch(run: &RunRecord, expected_epoch: u64) -> Result<()> {
    if run.view.state != RunState::Running || run.view.claim_epoch != expected_epoch {
        bail!("stale or inactive AgentRunAttempt");
    }
    Ok(())
}

fn child_terminal_state(outcome: &str) -> RunState {
    if outcome.starts_with("failed:") {
        RunState::Failed
    } else if outcome.starts_with("canceled:") {
        RunState::Canceled
    } else {
        RunState::Succeeded
    }
}

pub struct PostgresLifecycle {
    client: Client,
}

fn lifecycle_database_config(database_url: &str) -> Result<postgres::Config> {
    let mut config = database_url.parse::<postgres::Config>()?;
    config.application_name("osfo-lifecycle");
    Ok(config)
}

impl PostgresLifecycle {
    pub fn connect(database_url: &str) -> Result<Self> {
        Ok(Self {
            client: lifecycle_database_config(database_url)?.connect(NoTls)?,
        })
    }

    pub fn reset(&mut self) -> Result<()> {
        self.client.batch_execute(include_str!("../schema.sql"))?;
        Ok(())
    }

    pub fn execute(&mut self, command: Command) -> Result<CommandOutcome> {
        match command {
            Command::AdmitUserMessage {
                idempotency_key,
                request_hash,
            } => self.admit_user_message(&idempotency_key, &request_hash),
            Command::Claim { run_id, worker_id } => self.claim(&run_id, &worker_id),
            Command::AdmitChildren {
                parent_run_id,
                parent_claim_epoch,
                join_id,
                mode,
                child_run_ids,
            } => self.admit_children(
                &parent_run_id,
                parent_claim_epoch,
                &join_id,
                mode,
                &child_run_ids,
            ),
            Command::CompleteChild {
                child_run_id,
                outcome,
            } => self.complete_child(&child_run_id, &outcome),
            Command::StartAwaitedWorkflow {
                parent_run_id,
                parent_claim_epoch,
                tool_call_id,
                workflow_instance_id,
            } => self.start_awaited_workflow(
                &parent_run_id,
                parent_claim_epoch,
                &tool_call_id,
                &workflow_instance_id,
            ),
            Command::DeliverWorkflowOutcome {
                workflow_instance_id,
                delivery_id,
                outcome,
            } => self.deliver_workflow_outcome(&workflow_instance_id, &delivery_id, &outcome),
        }
    }

    pub fn run(&mut self, run_id: &RunId) -> Result<RunView> {
        let row = self.client.query_opt(
            "SELECT state, claim_epoch, wake_count
             FROM agent_run_lifecycle.agent_runs WHERE run_id = $1",
            &[&run_id.0],
        )?;
        let row = row.ok_or_else(|| anyhow::anyhow!("AgentRun is missing"))?;
        Ok(RunView {
            run_id: run_id.clone(),
            state: parse_run_state(row.get::<_, &str>(0))?,
            claim_epoch: row.get::<_, i64>(1) as u64,
            wake_count: row.get::<_, i64>(2) as u64,
        })
    }

    pub fn semantic_sequence(&mut self, run_id: &RunId) -> Result<Vec<String>> {
        Ok(self
            .client
            .query(
                "SELECT semantic_record
                 FROM agent_run_lifecycle.interaction_records
                 WHERE run_id = $1 ORDER BY sequence",
                &[&run_id.0],
            )?
            .into_iter()
            .map(|row| row.get(0))
            .collect())
    }

    pub fn validate_supported_authoritative_records(&mut self, run_id: &RunId) -> Result<()> {
        const SUPPORTED_PREFIXES: &[&str] = &[
            "UserMessage:",
            "SemanticConfig:",
            "AgentRunClaimed:",
            "AgentRunTakenOver:",
            "ModelCallIntent:",
            "ModelCallOutcome:",
            "AssistantOutputFragment:",
            "ToolCallIntent:",
            "ToolCallAttempt:",
            "ToolCallAttemptUnknown:",
            "ToolCallRetryScheduled:",
            "ToolCallOutcome:",
            "ApprovalOpened:",
            "ApprovalSettled:",
            "ChildAgentRunAdmitted:",
            "ChildJoinOpened:",
            "ChildOutcome:",
            "ChildJoinSettled:",
            "ChildJoinDeadlineSettled:",
            "ChildOutcomesConsumed:",
            "WorkflowStartIntent:",
            "WorkflowProgress:",
            "WorkflowOutcome:",
            "DetachedWorkflowStartIntent:",
            "ArtifactRef:",
            "RuntimeCheckpointRef:",
            "AgentRunTerminal:",
            "AgentRunCanceled:",
        ];
        for record in self.semantic_sequence(run_id)? {
            if !SUPPORTED_PREFIXES
                .iter()
                .any(|prefix| record.starts_with(prefix))
            {
                bail!("unsupported authoritative interaction record: {record}");
            }
        }
        Ok(())
    }

    pub fn admit_workload(
        &mut self,
        admission: workload::WorkloadAdmission,
    ) -> Result<workload::AdmittedWorkload> {
        if admission.idempotency_key.trim().is_empty()
            || admission.principal_id.trim().is_empty()
            || admission.persistence_profile.trim().is_empty()
        {
            bail!("workload admission identity and configuration are required");
        }
        let mut tx = self.client.transaction()?;
        if let Some(row) = tx.query_opt(
            "WITH lock_acquired AS MATERIALIZED (
                 SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
             )
             SELECT r.request_hash, r.run_id, a.principal_id, a.journey_kind,
                    a.persistence_profile, a.workload_ordinal
             FROM lock_acquired
             CROSS JOIN agent_run_lifecycle.admission_receipts r
             JOIN agent_run_lifecycle.agent_runs a USING (run_id)
             WHERE r.idempotency_key = $1
             /*action='admission'*/",
            &[&admission.idempotency_key],
        )? {
            let existing_hash: String = row.get(0);
            let run_id: String = row.get(1);
            let principal_id: String = row.get(2);
            let journey_kind: String = row.get(3);
            let persistence_profile: String = row.get(4);
            let ordinal: Option<i64> = row.get(5);
            if existing_hash != admission.request_hash
                || principal_id != admission.principal_id
                || journey_kind != admission.journey_kind.as_str()
                || persistence_profile != admission.persistence_profile
                || ordinal != Some(admission.ordinal as i64)
            {
                bail!("idempotency key reused with different workload configuration");
            }
            tx.commit()?;
            return Ok(workload::AdmittedWorkload {
                run_id: RunId(run_id),
                idempotent_replay: true,
            });
        }

        let journey_kind = admission.journey_kind.as_str();
        let semantic_config = format!(
            "SemanticConfig:v1:{}:{}:{}",
            admission.principal_id, journey_kind, admission.persistence_profile
        );
        let run_id: String = tx
            .query_one(
                "WITH allocated AS MATERIALIZED (
                     SELECT nextval('agent_run_lifecycle.root_run_id_seq') AS sequence
                 ),
                 run_identity AS (
                     SELECT CASE sequence
                         WHEN 1 THEN 'run-parent'
                         ELSE 'run-root-' || sequence::text
                     END AS run_id
                     FROM allocated
                 ),
                 inserted_run AS (
                     INSERT INTO agent_run_lifecycle.agent_runs
                         (run_id, root_run_id, principal_id, journey_kind,
                          persistence_profile, workload_ordinal, state)
                     SELECT run_id, run_id, $1, $2, $3, $4, 'pending'
                     FROM run_identity
                     RETURNING run_id
                 ),
                 inserted_records AS (
                     INSERT INTO agent_run_lifecycle.interaction_records
                         (run_id, sequence, semantic_record)
                     SELECT run.run_id, record.sequence, record.semantic_record
                     FROM inserted_run run
                     CROSS JOIN (VALUES
                         (1::bigint, $5::text),
                         (2::bigint, $6::text)
                     ) AS record(sequence, semantic_record)
                     RETURNING run_id
                 ),
                 inserted_receipt AS (
                     INSERT INTO agent_run_lifecycle.admission_receipts
                         (idempotency_key, request_hash, run_id)
                     SELECT $7, $8, run_id FROM inserted_run
                     RETURNING run_id
                 )
                 SELECT run_id FROM inserted_receipt
                 /*action='admission'*/",
                &[
                    &admission.principal_id,
                    &journey_kind,
                    &admission.persistence_profile,
                    &(admission.ordinal as i64),
                    &"UserMessage:v1",
                    &semantic_config,
                    &admission.idempotency_key,
                    &admission.request_hash,
                ],
            )?
            .get(0);
        tx.commit()?;
        Ok(workload::AdmittedWorkload {
            run_id: RunId(run_id),
            idempotent_replay: false,
        })
    }

    pub fn claim_next_workload(
        &mut self,
        worker_id: &str,
        lease: Duration,
    ) -> Result<Option<workload::ClaimedWorkload>> {
        self.claim_next_workload_matching(worker_id, lease, None)
    }

    pub fn claim_next_workload_for(
        &mut self,
        worker_id: &str,
        lease: Duration,
        journey_kinds: &[workload::JourneyKind],
    ) -> Result<Option<workload::ClaimedWorkload>> {
        if journey_kinds.is_empty() {
            bail!("an execution lane must include at least one journey kind");
        }
        self.claim_next_workload_matching(worker_id, lease, Some(journey_kinds))
    }

    fn claim_next_workload_matching(
        &mut self,
        worker_id: &str,
        lease: Duration,
        journey_kinds: Option<&[workload::JourneyKind]>,
    ) -> Result<Option<workload::ClaimedWorkload>> {
        let lease_ms = lease.as_millis().max(1) as i64;
        let mut tx = self.client.transaction()?;
        let row = if let Some(journey_kinds) = journey_kinds {
            let journey_kinds = journey_kinds
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>();
            tx.query_opt(
                "WITH candidate AS (
                     SELECT run_id
                     FROM agent_run_lifecycle.agent_runs
                     WHERE state IN ('pending', 'retry_ready')
                       AND workload_ordinal IS NOT NULL
                       AND journey_kind = ANY($3)
                     ORDER BY (principal_id = 'noisy') ASC, created_at, run_id
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                 )
                 UPDATE agent_run_lifecycle.agent_runs a
                 SET state = 'running', claim_epoch = claim_epoch + 1, owner = $1,
                     lease_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
                 FROM candidate
                 WHERE a.run_id = candidate.run_id
                 RETURNING a.run_id, a.claim_epoch, a.principal_id, a.journey_kind,
                           a.persistence_profile, a.workload_ordinal
                 /*action='claim'*/",
                &[&worker_id, &lease_ms, &journey_kinds],
            )?
        } else {
            tx.query_opt(
                "WITH candidate AS (
                 SELECT run_id
                 FROM agent_run_lifecycle.agent_runs
                 WHERE state IN ('pending', 'retry_ready')
                   AND workload_ordinal IS NOT NULL
                 ORDER BY (principal_id = 'noisy') ASC, created_at, run_id
                   FOR UPDATE SKIP LOCKED
                   LIMIT 1
             )
             UPDATE agent_run_lifecycle.agent_runs a
             SET state = 'running', claim_epoch = claim_epoch + 1, owner = $1,
                 lease_until = clock_timestamp() + ($2::bigint * interval '1 millisecond')
             FROM candidate
             WHERE a.run_id = candidate.run_id
             RETURNING a.run_id, a.claim_epoch, a.principal_id, a.journey_kind,
                       a.persistence_profile, a.workload_ordinal
             /*action='claim'*/",
                &[&worker_id, &lease_ms],
            )?
        };
        let Some(row) = row else {
            tx.commit()?;
            return Ok(None);
        };
        let run_id: String = row.get(0);
        let claim_epoch: i64 = row.get(1);
        let principal_id: String = row.get(2);
        let journey_kind: String = row.get(3);
        let persistence_profile: String = row.get(4);
        let ordinal: i64 = row.get(5);
        append_semantic(&mut tx, &run_id, &format!("AgentRunClaimed:{claim_epoch}"))?;
        tx.commit()?;
        Ok(Some(workload::ClaimedWorkload {
            run_id: RunId(run_id),
            claim_epoch: claim_epoch as u64,
            principal_id,
            journey_kind: workload::JourneyKind::parse(&journey_kind)?,
            persistence_profile,
            ordinal: ordinal as u64,
        }))
    }

    pub fn commit_interaction(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        record_id: &str,
        semantic_record: &str,
    ) -> Result<CommandOutcome> {
        if record_id.trim().is_empty() || semantic_record.trim().is_empty() {
            bail!("interaction record identity and content are required");
        }
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, run_id, claim_epoch)?;
        let row = tx.query_one(
            "WITH existing AS MATERIALIZED (
                 SELECT semantic_record
                 FROM agent_run_lifecycle.interaction_records
                 WHERE run_id = $1 AND record_id = $2
             ),
             next_sequence AS (
                 SELECT COALESCE(max(sequence), 0) + 1 AS sequence
                 FROM agent_run_lifecycle.interaction_records
                 WHERE run_id = $1
             ),
             inserted AS (
                 INSERT INTO agent_run_lifecycle.interaction_records
                     (run_id, sequence, record_id, semantic_record)
                 SELECT $1, sequence, $2, $3
                 FROM next_sequence
                 WHERE NOT EXISTS (SELECT 1 FROM existing)
                 RETURNING 1
             )
             SELECT (SELECT semantic_record FROM existing),
                    EXISTS (SELECT 1 FROM inserted)
             /*action='transition'*/",
            &[&run_id.0, &record_id, &semantic_record],
        )?;
        let existing: Option<String> = row.get(0);
        if let Some(existing) = existing {
            if existing != semantic_record {
                bail!("stable interaction record ID reused with different content");
            }
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }
        let inserted: bool = row.get(1);
        if !inserted {
            bail!("interaction record was not committed");
        }
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    fn admit_user_message(
        &mut self,
        idempotency_key: &str,
        request_hash: &str,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&idempotency_key],
        )?;
        if let Some(row) = tx.query_opt(
            "SELECT request_hash, run_id
             FROM agent_run_lifecycle.admission_receipts
             WHERE idempotency_key = $1",
            &[&idempotency_key],
        )? {
            let existing_hash: String = row.get(0);
            if existing_hash != request_hash {
                bail!("idempotency key reused with a different request hash");
            }
            let run_id: String = row.get(1);
            tx.commit()?;
            return Ok(CommandOutcome::RunAdmitted(RunId(run_id)));
        }

        let root_sequence: i64 = tx
            .query_one("SELECT nextval('agent_run_lifecycle.root_run_id_seq')", &[])?
            .get(0);
        let run_id = if root_sequence == 1 {
            "run-parent".to_owned()
        } else {
            format!("run-root-{root_sequence}")
        };
        tx.execute(
            "INSERT INTO agent_run_lifecycle.agent_runs
                (run_id, root_run_id, state)
             VALUES ($1, $1, 'pending')",
            &[&run_id],
        )?;
        append_semantic(&mut tx, &run_id, "UserMessage:v1")?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.admission_receipts
                (idempotency_key, request_hash, run_id)
             VALUES ($1, $2, $3)",
            &[&idempotency_key, &request_hash, &run_id],
        )?;
        tx.commit()?;
        Ok(CommandOutcome::RunAdmitted(RunId(run_id)))
    }

    fn claim(&mut self, run_id: &RunId, worker_id: &str) -> Result<CommandOutcome> {
        self.claim_with_lease(run_id, worker_id, Duration::from_secs(30))
    }

    pub fn claim_with_lease(
        &mut self,
        run_id: &RunId,
        worker_id: &str,
        lease: Duration,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        let lease_ms = lease.as_millis().max(1) as i64;
        let row = tx.query_opt(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'running', claim_epoch = claim_epoch + 1, owner = $2,
                 lease_until = clock_timestamp() + ($3::bigint * interval '1 millisecond')
             WHERE run_id = $1 AND state IN ('pending', 'retry_ready')
             RETURNING claim_epoch",
            &[&run_id.0, &worker_id, &lease_ms],
        )?;
        let row = row.ok_or_else(|| anyhow::anyhow!("run is not claimable"))?;
        let epoch: i64 = row.get(0);
        append_semantic(&mut tx, &run_id.0, &format!("AgentRunClaimed:{epoch}"))?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn takeover_expired(
        &mut self,
        run_id: &RunId,
        worker_id: &str,
        lease: Duration,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        let lease_ms = lease.as_millis().max(1) as i64;
        let row = tx.query_opt(
            "UPDATE agent_run_lifecycle.agent_runs
             SET claim_epoch = claim_epoch + 1, owner = $2,
                 lease_until = clock_timestamp() + ($3::bigint * interval '1 millisecond')
             WHERE run_id = $1 AND state = 'running'
               AND lease_until < clock_timestamp()
             RETURNING claim_epoch",
            &[&run_id.0, &worker_id, &lease_ms],
        )?;
        let row = row.ok_or_else(|| anyhow::anyhow!("AgentRun lease is not expired"))?;
        let epoch: i64 = row.get(0);
        append_semantic(&mut tx, &run_id.0, &format!("AgentRunTakenOver:{epoch}"))?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn complete_run(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        terminal_state: RunState,
    ) -> Result<CommandOutcome> {
        let terminal_state = match terminal_state {
            RunState::Succeeded => "succeeded",
            RunState::Failed => "failed",
            RunState::Canceled => "canceled",
            _ => bail!("AgentRun completion requires a terminal state"),
        };
        let mut tx = self.client.transaction()?;
        let row = tx.query_opt(
            "SELECT state, claim_epoch FROM agent_run_lifecycle.agent_runs
             WHERE run_id = $1 FOR UPDATE",
            &[&run_id.0],
        )?;
        let row = row.ok_or_else(|| anyhow::anyhow!("AgentRun is missing"))?;
        let state: String = row.get(0);
        let current_epoch: i64 = row.get(1);
        if state != "running" || current_epoch as u64 != claim_epoch {
            tx.execute(
                "INSERT INTO agent_run_lifecycle.stale_commit_rejections
                    (run_id, attempted_epoch, current_epoch)
                 VALUES ($1, $2, $3)",
                &[&run_id.0, &(claim_epoch as i64), &current_epoch],
            )?;
            tx.commit()?;
            bail!("stale or inactive AgentRunAttempt");
        }
        let row = tx.query_one(
            "WITH updated AS (
                 UPDATE agent_run_lifecycle.agent_runs run
                 SET state = $3, owner = NULL, lease_until = NULL,
                     terminal_at = clock_timestamp()
                 WHERE run.run_id = $1 AND claim_epoch = $2 AND state = 'running'
                 RETURNING run.run_id
             ),
             next_sequence AS (
                 SELECT updated.run_id, COALESCE(max(records.sequence), 0) + 1 AS sequence
                 FROM updated
                 LEFT JOIN agent_run_lifecycle.interaction_records records USING (run_id)
                 GROUP BY updated.run_id
             ),
             inserted_record AS (
                 INSERT INTO agent_run_lifecycle.interaction_records
                     (run_id, sequence, semantic_record)
                 SELECT run_id, sequence, 'AgentRunTerminal:' || $3
                 FROM next_sequence
                 RETURNING 1
             )
             SELECT EXISTS (SELECT 1 FROM updated),
                    EXISTS (SELECT 1 FROM inserted_record)
             /*action='completion'*/",
            &[&run_id.0, &(claim_epoch as i64), &terminal_state],
        )?;
        let updated: bool = row.get(0);
        let recorded: bool = row.get(1);
        if !updated || !recorded {
            bail!("AgentRun terminal state was not committed");
        }
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn complete_basic_model_response(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        fragment_record_id: &str,
        fragment_record: &str,
        outcome_record_id: &str,
        outcome_record: &str,
    ) -> Result<CommandOutcome> {
        if fragment_record_id.trim().is_empty()
            || fragment_record.trim().is_empty()
            || outcome_record_id.trim().is_empty()
            || outcome_record.trim().is_empty()
        {
            bail!("model response record identities and content are required");
        }
        let mut tx = self.client.transaction()?;
        let row = tx.query_opt(
            "SELECT state, claim_epoch
             FROM agent_run_lifecycle.agent_runs
             WHERE run_id = $1
             FOR UPDATE",
            &[&run_id.0],
        )?;
        let row = row.ok_or_else(|| anyhow::anyhow!("AgentRun is missing"))?;
        let state: String = row.get(0);
        let current_epoch: i64 = row.get(1);
        let existing = tx.query_one(
            "SELECT
                 (SELECT semantic_record
                  FROM agent_run_lifecycle.interaction_records
                  WHERE run_id = $1 AND record_id = $2),
                 (SELECT semantic_record
                  FROM agent_run_lifecycle.interaction_records
                  WHERE run_id = $1 AND record_id = $3),
                 EXISTS (
                     SELECT 1
                     FROM agent_run_lifecycle.interaction_records
                     WHERE run_id = $1
                       AND semantic_record = 'AgentRunTerminal:succeeded'
                 )",
            &[&run_id.0, &fragment_record_id, &outcome_record_id],
        )?;
        let existing_fragment: Option<String> = existing.get(0);
        let existing_outcome: Option<String> = existing.get(1);
        let existing_terminal: bool = existing.get(2);

        if state == "succeeded"
            && current_epoch == claim_epoch as i64
            && existing_fragment.as_deref() == Some(fragment_record)
            && existing_outcome.as_deref() == Some(outcome_record)
            && existing_terminal
        {
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }
        if state != "running" || current_epoch != claim_epoch as i64 {
            tx.execute(
                "INSERT INTO agent_run_lifecycle.stale_commit_rejections
                    (run_id, attempted_epoch, current_epoch)
                 VALUES ($1, $2, $3)",
                &[&run_id.0, &(claim_epoch as i64), &current_epoch],
            )?;
            tx.commit()?;
            bail!("stale or inactive AgentRunAttempt");
        }
        if existing_fragment.is_some() || existing_outcome.is_some() || existing_terminal {
            bail!("model response records exist without the matching terminal commit");
        }

        let committed = tx.query_one(
            "WITH next_sequence AS MATERIALIZED (
                 SELECT COALESCE(max(sequence), 0) + 1 AS sequence
                 FROM agent_run_lifecycle.interaction_records
                 WHERE run_id = $1
             ),
             inserted_records AS (
                 INSERT INTO agent_run_lifecycle.interaction_records
                     (run_id, sequence, record_id, semantic_record)
                 SELECT $1, next_sequence.sequence + record.sequence_offset,
                        record.record_id, record.semantic_record
                 FROM next_sequence
                 CROSS JOIN (VALUES
                     (0::bigint, $3::text, $4::text),
                     (1::bigint, $5::text, $6::text)
                 ) AS record(sequence_offset, record_id, semantic_record)
                 RETURNING 1
             ),
             updated AS (
                 UPDATE agent_run_lifecycle.agent_runs
                 SET state = 'succeeded', owner = NULL, lease_until = NULL,
                     terminal_at = clock_timestamp()
                 WHERE run_id = $1 AND state = 'running' AND claim_epoch = $2
                 RETURNING run_id
             ),
             inserted_terminal AS (
                 INSERT INTO agent_run_lifecycle.interaction_records
                     (run_id, sequence, semantic_record)
                 SELECT $1, next_sequence.sequence + 2,
                        'AgentRunTerminal:succeeded'
                 FROM next_sequence
                 WHERE EXISTS (SELECT 1 FROM updated)
                 RETURNING 1
             )
             SELECT (SELECT count(*) FROM inserted_records),
                    EXISTS (SELECT 1 FROM updated),
                    EXISTS (SELECT 1 FROM inserted_terminal)
             /*action='completion'*/",
            &[
                &run_id.0,
                &(claim_epoch as i64),
                &fragment_record_id,
                &fragment_record,
                &outcome_record_id,
                &outcome_record,
            ],
        )?;
        let inserted_records: i64 = committed.get(0);
        let updated: bool = committed.get(1);
        let inserted_terminal: bool = committed.get(2);
        if inserted_records != 2 || !updated || !inserted_terminal {
            bail!("model response and terminal state were not committed atomically");
        }
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn cancel_run(&mut self, run_id: &RunId, reason: &str) -> Result<CommandOutcome> {
        if reason.trim().is_empty() {
            bail!("AgentRun cancellation requires a reason");
        }
        let mut tx = self.client.transaction()?;
        let row = tx.query_opt(
            "SELECT state FROM agent_run_lifecycle.agent_runs
             WHERE run_id = $1 FOR UPDATE",
            &[&run_id.0],
        )?;
        let row = row.ok_or_else(|| anyhow::anyhow!("AgentRun is missing"))?;
        let state: String = row.get(0);
        if state == "canceled" {
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }
        if matches!(state.as_str(), "succeeded" | "failed") {
            bail!("terminal AgentRun cannot be canceled");
        }
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'canceled', owner = NULL, lease_until = NULL,
                 terminal_at = clock_timestamp()
             WHERE run_id = $1",
            &[&run_id.0],
        )?;
        append_semantic(&mut tx, &run_id.0, &format!("AgentRunCanceled:{reason}"))?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    fn admit_children(
        &mut self,
        parent_run_id: &RunId,
        parent_claim_epoch: u64,
        join_id: &str,
        mode: ChildJoinMode,
        child_run_ids: &[RunId],
    ) -> Result<CommandOutcome> {
        if child_run_ids.is_empty() {
            bail!("a ChildJoin requires at least one child");
        }
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, parent_run_id, parent_claim_epoch)?;
        let root_run_id: String = tx
            .query_one(
                "SELECT root_run_id FROM agent_run_lifecycle.agent_runs WHERE run_id = $1",
                &[&parent_run_id.0],
            )?
            .get(0);
        let active_runs: i64 = tx
            .query_one(
                "SELECT count(*) FROM agent_run_lifecycle.agent_runs
                 WHERE root_run_id = $1
                   AND state NOT IN ('succeeded', 'failed', 'canceled')",
                &[&root_run_id],
            )?
            .get(0);
        if active_runs + child_run_ids.len() as i64 > MAX_ACTIVE_RUNS_PER_ROOT {
            bail!("root AgentRun concurrency limit exceeded");
        }
        let mode = match mode {
            ChildJoinMode::AllTerminal => "all_terminal",
            ChildJoinMode::FirstSuccessful => "first_successful",
        };
        tx.execute(
            "INSERT INTO agent_run_lifecycle.child_joins (join_id, parent_run_id, mode)
             VALUES ($1, $2, $3)",
            &[&join_id, &parent_run_id.0, &mode],
        )?;
        for (order, child_run_id) in child_run_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO agent_run_lifecycle.agent_runs
                    (run_id, parent_run_id, root_run_id, state)
                 VALUES ($1, $2, $3, 'pending')",
                &[&child_run_id.0, &parent_run_id.0, &root_run_id],
            )?;
            append_semantic(&mut tx, &child_run_id.0, "ChildAgentRunAdmitted:v1")?;
            tx.execute(
                "INSERT INTO agent_run_lifecycle.child_join_members
                    (join_id, child_run_id, stable_order)
                 VALUES ($1, $2, $3)",
                &[&join_id, &child_run_id.0, &(order as i32)],
            )?;
        }
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'waiting', owner = NULL, lease_until = NULL WHERE run_id = $1",
            &[&parent_run_id.0],
        )?;
        append_semantic(
            &mut tx,
            &parent_run_id.0,
            &format!("ChildJoinOpened:{join_id}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    fn complete_child(&mut self, child_run_id: &RunId, outcome: &str) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        let member = tx.query_opt(
            "SELECT join_id, terminal
             FROM agent_run_lifecycle.child_join_members
             WHERE child_run_id = $1",
            &[&child_run_id.0],
        )?;
        let member = member.ok_or_else(|| anyhow::anyhow!("child has no join"))?;
        let join_id: String = member.get(0);
        let already_terminal: bool = member.get(1);
        let join = tx.query_one(
            "SELECT parent_run_id, mode, settled
             FROM agent_run_lifecycle.child_joins
             WHERE join_id = $1 FOR UPDATE",
            &[&join_id],
        )?;
        if already_terminal {
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }
        let parent_run_id: String = join.get(0);
        let mode: String = join.get(1);
        let settled: bool = join.get(2);
        tx.execute(
            "UPDATE agent_run_lifecycle.child_join_members
             SET terminal = true, outcome = $2 WHERE child_run_id = $1",
            &[&child_run_id.0, &outcome],
        )?;
        let child_state = match child_terminal_state(outcome) {
            RunState::Succeeded => "succeeded",
            RunState::Failed => "failed",
            RunState::Canceled => "canceled",
            _ => unreachable!("child outcome must be terminal"),
        };
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = $2, owner = NULL, lease_until = NULL,
                 terminal_at = clock_timestamp()
             WHERE run_id = $1 AND state NOT IN ('succeeded', 'failed', 'canceled')",
            &[&child_run_id.0, &child_state],
        )?;
        append_semantic(
            &mut tx,
            &parent_run_id,
            &format!("ChildOutcome:{}:{outcome}", child_run_id.0),
        )?;

        let counts = tx.query_one(
            "SELECT count(*), count(*) FILTER (WHERE terminal)
             FROM agent_run_lifecycle.child_join_members WHERE join_id = $1",
            &[&join_id],
        )?;
        let total: i64 = counts.get(0);
        let terminal: i64 = counts.get(1);
        let successful = !outcome.starts_with("failed:") && !outcome.starts_with("canceled:");
        let should_settle = mode == "all_terminal" && total == terminal
            || mode == "first_successful" && (successful || total == terminal);
        if should_settle && !settled {
            tx.execute(
                "UPDATE agent_run_lifecycle.child_joins
                 SET settled = true, settled_at = clock_timestamp() WHERE join_id = $1",
                &[&join_id],
            )?;
            tx.execute(
                "UPDATE agent_run_lifecycle.agent_runs
                 SET state = 'pending', owner = NULL, lease_until = NULL,
                     wake_count = wake_count + 1
                 WHERE run_id = $1 AND state = 'waiting'",
                &[&parent_run_id],
            )?;
            append_semantic(
                &mut tx,
                &parent_run_id,
                &format!("ChildJoinSettled:{join_id}"),
            )?;
        }
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn expire_child_join(&mut self, join_id: &str) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        let join = tx.query_opt(
            "SELECT parent_run_id, settled
             FROM agent_run_lifecycle.child_joins
             WHERE join_id = $1 FOR UPDATE",
            &[&join_id],
        )?;
        let join = join.ok_or_else(|| anyhow::anyhow!("ChildJoin is missing"))?;
        let parent_run_id: String = join.get(0);
        let settled: bool = join.get(1);
        if settled {
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }

        let unfinished = tx.query(
            "SELECT child_run_id
             FROM agent_run_lifecycle.child_join_members
             WHERE join_id = $1 AND terminal = false
             ORDER BY stable_order FOR UPDATE",
            &[&join_id],
        )?;
        for row in unfinished {
            let child_run_id: String = row.get(0);
            tx.execute(
                "UPDATE agent_run_lifecycle.child_join_members
                 SET terminal = true, outcome = 'canceled:join-deadline'
                 WHERE join_id = $1 AND child_run_id = $2",
                &[&join_id, &child_run_id],
            )?;
            tx.execute(
                "UPDATE agent_run_lifecycle.agent_runs
                 SET state = 'canceled', owner = NULL, lease_until = NULL,
                     terminal_at = clock_timestamp()
                 WHERE run_id = $1 AND state NOT IN ('succeeded', 'failed', 'canceled')",
                &[&child_run_id],
            )?;
            append_semantic(
                &mut tx,
                &parent_run_id,
                &format!("ChildOutcome:{child_run_id}:canceled:join-deadline"),
            )?;
        }
        tx.execute(
            "UPDATE agent_run_lifecycle.child_joins
             SET settled = true, settled_at = clock_timestamp() WHERE join_id = $1",
            &[&join_id],
        )?;
        let woke = tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'pending', owner = NULL, lease_until = NULL,
                 wake_count = wake_count + 1
             WHERE run_id = $1 AND state = 'waiting'",
            &[&parent_run_id],
        )?;
        if woke != 1 {
            bail!("expired ChildJoin parent was not waiting");
        }
        append_semantic(
            &mut tx,
            &parent_run_id,
            &format!("ChildJoinDeadlineSettled:{join_id}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    fn start_awaited_workflow(
        &mut self,
        parent_run_id: &RunId,
        parent_claim_epoch: u64,
        tool_call_id: &str,
        workflow_instance_id: &str,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, parent_run_id, parent_claim_epoch)?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.workflow_instances
                (workflow_instance_id, parent_run_id, tool_call_id, mode, state)
             VALUES ($1, $2, $3, 'awaited', 'start_intent')",
            &[&workflow_instance_id, &parent_run_id.0, &tool_call_id],
        )?;
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'waiting', owner = NULL, lease_until = NULL WHERE run_id = $1",
            &[&parent_run_id.0],
        )?;
        append_semantic(
            &mut tx,
            &parent_run_id.0,
            &format!("WorkflowStartIntent:{workflow_instance_id}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn start_detached_workflow(
        &mut self,
        parent_run_id: &RunId,
        parent_claim_epoch: u64,
        tool_call_id: &str,
        workflow_instance_id: &str,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, parent_run_id, parent_claim_epoch)?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.workflow_instances
                (workflow_instance_id, parent_run_id, tool_call_id, mode, state)
             VALUES ($1, $2, $3, 'detached', 'start_intent')",
            &[&workflow_instance_id, &parent_run_id.0, &tool_call_id],
        )?;
        append_semantic(
            &mut tx,
            &parent_run_id.0,
            &format!("DetachedWorkflowStartIntent:{workflow_instance_id}:RecordOnly"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn deliver_workflow_progress(
        &mut self,
        workflow_instance_id: &str,
        delivery_id: &str,
        progress: &str,
    ) -> Result<CommandOutcome> {
        if progress.trim().is_empty() {
            bail!("Workflow progress must be typed and non-empty");
        }
        let mut tx = self.client.transaction()?;
        let workflow = tx.query_opt(
            "SELECT parent_run_id, state FROM agent_run_lifecycle.workflow_instances
             WHERE workflow_instance_id = $1 FOR UPDATE",
            &[&workflow_instance_id],
        )?;
        let workflow = workflow.ok_or_else(|| anyhow::anyhow!("WorkflowInstance is missing"))?;
        let parent_run_id: String = workflow.get(0);
        let state: String = workflow.get(1);
        if matches!(state.as_str(), "succeeded" | "failed" | "canceled") {
            bail!("terminal WorkflowInstance cannot accept progress");
        }
        let inserted = tx.execute(
            "INSERT INTO agent_run_lifecycle.workflow_progress_deliveries
                (delivery_id, workflow_instance_id, progress)
             VALUES ($1, $2, $3) ON CONFLICT (delivery_id) DO NOTHING",
            &[&delivery_id, &workflow_instance_id, &progress],
        )?;
        if inserted == 0 {
            let existing: String = tx
                .query_one(
                    "SELECT progress FROM agent_run_lifecycle.workflow_progress_deliveries
                     WHERE delivery_id = $1 AND workflow_instance_id = $2",
                    &[&delivery_id, &workflow_instance_id],
                )?
                .get(0);
            if existing != progress {
                bail!("workflow progress delivery ID reused with different content");
            }
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }
        append_semantic(
            &mut tx,
            &parent_run_id,
            &format!("WorkflowProgress:{workflow_instance_id}:{progress}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    fn deliver_workflow_outcome(
        &mut self,
        workflow_instance_id: &str,
        delivery_id: &str,
        outcome: &str,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        let inserted = tx.execute(
            "INSERT INTO agent_run_lifecycle.workflow_deliveries
                (delivery_id, workflow_instance_id)
             VALUES ($1, $2) ON CONFLICT (delivery_id) DO NOTHING",
            &[&delivery_id, &workflow_instance_id],
        )?;
        if inserted == 0 {
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }
        let workflow = tx.query_one(
            "SELECT parent_run_id, state, mode
             FROM agent_run_lifecycle.workflow_instances
             WHERE workflow_instance_id = $1 FOR UPDATE",
            &[&workflow_instance_id],
        )?;
        let parent_run_id: String = workflow.get(0);
        let state: String = workflow.get(1);
        let mode: String = workflow.get(2);
        if matches!(state.as_str(), "succeeded" | "failed" | "canceled") {
            tx.commit()?;
            return Ok(CommandOutcome::IdempotentReplay);
        }
        tx.execute(
            "UPDATE agent_run_lifecycle.workflow_instances
             SET state = 'succeeded', outcome = $2, terminal_at = clock_timestamp()
             WHERE workflow_instance_id = $1",
            &[&workflow_instance_id, &outcome],
        )?;
        if mode == "awaited" {
            let parent_state: String = tx
                .query_one(
                    "SELECT state FROM agent_run_lifecycle.agent_runs
                     WHERE run_id = $1 FOR UPDATE",
                    &[&parent_run_id],
                )?
                .get(0);
            if parent_state == "waiting" {
                tx.execute(
                    "UPDATE agent_run_lifecycle.agent_runs
                     SET state = 'pending', wake_count = wake_count + 1
                     WHERE run_id = $1",
                    &[&parent_run_id],
                )?;
                append_semantic(
                    &mut tx,
                    &parent_run_id,
                    &format!("WorkflowOutcome:{workflow_instance_id}:{outcome}"),
                )?;
            }
        }
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }
}

fn append_semantic(tx: &mut Transaction<'_>, run_id: &str, record: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO agent_run_lifecycle.interaction_records
            (run_id, sequence, semantic_record)
         SELECT $1, COALESCE(max(sequence), 0) + 1, $2
         FROM agent_run_lifecycle.interaction_records WHERE run_id = $1
         /*action='transition'*/",
        &[&run_id, &record],
    )?;
    Ok(())
}

fn lock_running_epoch(tx: &mut Transaction<'_>, run_id: &RunId, expected_epoch: u64) -> Result<()> {
    let row = tx.query_opt(
        "SELECT state, claim_epoch
         FROM agent_run_lifecycle.agent_runs WHERE run_id = $1 FOR UPDATE",
        &[&run_id.0],
    )?;
    let row = row.ok_or_else(|| anyhow::anyhow!("AgentRun is missing"))?;
    let state: String = row.get(0);
    let epoch: i64 = row.get(1);
    if state != "running" || epoch as u64 != expected_epoch {
        bail!("stale or inactive AgentRunAttempt");
    }
    Ok(())
}

fn parse_run_state(value: &str) -> Result<RunState> {
    Ok(match value {
        "pending" => RunState::Pending,
        "running" => RunState::Running,
        "waiting" => RunState::Waiting,
        "retry_ready" => RunState::RetryReady,
        "succeeded" => RunState::Succeeded,
        "failed" => RunState::Failed,
        "canceled" => RunState::Canceled,
        _ => bail!("unsupported AgentRun state {value}"),
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct SandboxSpec {
    pub sandbox_id: String,
    pub image: String,
    pub cpu_limit: f64,
    pub memory_bytes: u64,
    pub process_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxRef {
    pub provider: String,
    pub sandbox_id: String,
    pub identity_sha256: String,
    pub expires_at_unix_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxExecution {
    pub success: bool,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportedArtifact {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub trait SandboxProvider {
    fn create(&mut self, spec: SandboxSpec) -> Result<SandboxRef>;
    fn resume(&mut self, sandbox: &SandboxRef) -> Result<bool>;
    fn execute(
        &mut self,
        sandbox: &SandboxRef,
        command: &str,
        deadline: Duration,
    ) -> Result<SandboxExecution>;
    fn export(&mut self, sandbox: &SandboxRef, relative_path: &str) -> Result<ExportedArtifact>;
    fn stop(&mut self, sandbox: &SandboxRef) -> Result<()>;
    fn delete(&mut self, sandbox: &SandboxRef) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct DockerSandboxProvider;

static PREPARED_SANDBOX_IMAGES: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

impl DockerSandboxProvider {
    pub fn new() -> Self {
        Self
    }

    fn container_name(sandbox: &SandboxRef) -> Result<String> {
        if sandbox.provider != "docker-v1" {
            bail!("SandboxRef belongs to a different provider");
        }
        Ok(format!("osfo-sandbox-{}", sandbox.sandbox_id))
    }

    fn image_has_prepared_workspace(image: &str) -> Result<bool> {
        let cache = PREPARED_SANDBOX_IMAGES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut cache = cache
            .lock()
            .map_err(|_| anyhow::anyhow!("prepared sandbox image cache is poisoned"))?;
        if let Some(prepared) = cache.get(image) {
            return Ok(*prepared);
        }
        let output = ProcessCommand::new("docker")
            .args([
                "image",
                "inspect",
                "--format",
                "{{index .Config.Labels \"osfo.workspace-prepared\"}}",
                image,
            ])
            .output()?;
        let stdout = ensure_process_success(output, "inspect sandbox image")?;
        let prepared = String::from_utf8_lossy(&stdout).trim() == "true";
        cache.insert(image.to_owned(), prepared);
        Ok(prepared)
    }
}

impl SandboxProvider for DockerSandboxProvider {
    fn create(&mut self, spec: SandboxSpec) -> Result<SandboxRef> {
        if spec.sandbox_id.is_empty()
            || !spec
                .sandbox_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            bail!("sandbox identity contains unsupported characters");
        }
        if !spec.image.contains("@sha256:") {
            bail!("sandbox image must be pinned by digest");
        }
        let mut sandbox = SandboxRef {
            provider: "docker-v1".into(),
            sandbox_id: spec.sandbox_id.clone(),
            identity_sha256: sandbox_identity(&spec),
            expires_at_unix_seconds: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
                + 86_400,
        };
        let name = Self::container_name(&sandbox)?;
        let workspace_volume = format!("{name}-workspace");
        let existing = ProcessCommand::new("docker")
            .args([
                "inspect",
                "--format",
                "{{.Config.Image}}\t{{.Config.User}}\t{{index .Config.Labels \"osfo.prototype\"}}\t{{index .Config.Labels \"osfo.identity-sha256\"}}\t{{index .Config.Labels \"osfo.expires-at\"}}",
                &name,
            ])
            .output()?;
        if existing.status.success() {
            let identity = String::from_utf8_lossy(&existing.stdout);
            let fields = identity.trim().split('\t').collect::<Vec<_>>();
            if fields.len() == 5
                && fields[0] == spec.image
                && fields[1] == "65532:65532"
                && fields[2] == "agent-run-lifecycle"
                && fields[3] == sandbox.identity_sha256
            {
                sandbox.expires_at_unix_seconds = fields[4]
                    .parse()
                    .context("sandbox expiry label is invalid")?;
                self.resume(&sandbox)?;
                return Ok(sandbox);
            }
            let output = ProcessCommand::new("docker")
                .args(["rm", "--force", &name])
                .output()?;
            ensure_process_success(output, "delete incompatible sandbox")?;
            let output = ProcessCommand::new("docker")
                .args(["volume", "rm", &workspace_volume])
                .output()?;
            ensure_process_success(output, "delete incompatible sandbox workspace")?;
        }
        let output = ProcessCommand::new("docker")
            .args([
                "volume",
                "create",
                "--label",
                "osfo.prototype=agent-run-lifecycle",
                "--label",
                &format!("osfo.identity-sha256={}", sandbox.identity_sha256),
                "--label",
                &format!("osfo.expires-at={}", sandbox.expires_at_unix_seconds),
                &workspace_volume,
            ])
            .output()?;
        ensure_process_success(output, "create sandbox workspace")?;
        let workspace_mount = format!("{workspace_volume}:/workspace");
        if !Self::image_has_prepared_workspace(&spec.image)? {
            let output = ProcessCommand::new("docker")
                .args([
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--read-only",
                    "--cap-drop",
                    "ALL",
                    "--cap-add",
                    "CHOWN",
                    "--security-opt",
                    "no-new-privileges:true",
                    "--volume",
                    &workspace_mount,
                    &spec.image,
                    "chown",
                    "65532:65532",
                    "/workspace",
                ])
                .output()?;
            ensure_process_success(output, "prepare sandbox workspace")?;
        }
        let cpu_limit = spec.cpu_limit.to_string();
        let memory_limit = spec.memory_bytes.to_string();
        let process_limit = spec.process_limit.to_string();
        let output = ProcessCommand::new("docker")
            .args([
                "run",
                "--detach",
                "--name",
                &name,
                "--label",
                "osfo.prototype=agent-run-lifecycle",
                "--label",
                &format!("osfo.identity-sha256={}", sandbox.identity_sha256),
                "--label",
                &format!("osfo.expires-at={}", sandbox.expires_at_unix_seconds),
                "--user",
                "65532:65532",
                "--read-only",
                "--network",
                "none",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--cpus",
                &cpu_limit,
                "--memory",
                &memory_limit,
                "--pids-limit",
                &process_limit,
                "--volume",
                &workspace_mount,
                "--init",
                &spec.image,
                "sleep",
                "86400",
            ])
            .output()?;
        ensure_process_success(output, "create and start sandbox")?;
        Ok(sandbox)
    }

    fn resume(&mut self, sandbox: &SandboxRef) -> Result<bool> {
        if sandbox.expires_at_unix_seconds
            <= SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
        {
            bail!("SandboxRef is expired");
        }
        let name = Self::container_name(sandbox)?;
        let inspect = ProcessCommand::new("docker")
            .args([
                "inspect",
                "--format",
                "{{.State.Running}}\t{{index .Config.Labels \"osfo.identity-sha256\"}}",
                &name,
            ])
            .output()?;
        if !inspect.status.success() {
            return Ok(false);
        }
        let identity = String::from_utf8_lossy(&inspect.stdout);
        let (running, observed_identity) = identity
            .trim()
            .split_once('\t')
            .context("sandbox inspection omitted its identity")?;
        if observed_identity != sandbox.identity_sha256 {
            bail!("SandboxRef integrity does not match the provider resource");
        }
        if running != "true" {
            let output = ProcessCommand::new("docker")
                .args(["start", &name])
                .output()?;
            ensure_process_success(output, "resume sandbox")?;
        }
        Ok(true)
    }

    fn execute(
        &mut self,
        sandbox: &SandboxRef,
        command: &str,
        deadline: Duration,
    ) -> Result<SandboxExecution> {
        let name = Self::container_name(sandbox)?;
        let deadline = format!("{}s", deadline.as_secs().max(1));
        let output = ProcessCommand::new("timeout")
            .args([
                "--signal=KILL",
                &deadline,
                "docker",
                "exec",
                "--user",
                "65532:65532",
                &name,
                "/bin/sh",
                "-lc",
                command,
            ])
            .output()?;
        let code = output.status.code();
        Ok(SandboxExecution {
            success: output.status.success(),
            timed_out: code == Some(124) || code == Some(137),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    fn export(&mut self, sandbox: &SandboxRef, relative_path: &str) -> Result<ExportedArtifact> {
        let path = Path::new(relative_path);
        if path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            bail!("artifact export path must stay within the workspace");
        }
        let name = Self::container_name(sandbox)?;
        let container_path = format!("/workspace/{relative_path}");
        let output = ProcessCommand::new("docker")
            .args(["exec", &name, "cat", &container_path])
            .output()?;
        let bytes = ensure_process_success(output, "export artifact")?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        Ok(ExportedArtifact { bytes, sha256 })
    }

    fn stop(&mut self, sandbox: &SandboxRef) -> Result<()> {
        let name = Self::container_name(sandbox)?;
        let output = ProcessCommand::new("docker")
            .args(["stop", "--time", "1", &name])
            .output()?;
        ensure_process_success(output, "stop sandbox")?;
        Ok(())
    }

    fn delete(&mut self, sandbox: &SandboxRef) -> Result<()> {
        let name = Self::container_name(sandbox)?;
        let workspace_volume = format!("{name}-workspace");
        let output = ProcessCommand::new("docker")
            .args(["rm", "--force", &name])
            .output()?;
        ensure_process_success(output, "delete sandbox")?;
        let output = ProcessCommand::new("docker")
            .args(["volume", "rm", &workspace_volume])
            .output()?;
        ensure_process_success(output, "delete sandbox workspace")?;
        Ok(())
    }
}

fn sandbox_identity(spec: &SandboxSpec) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "docker-v1\0{}\0{}\0{}\0{}\0{}",
            spec.sandbox_id, spec.image, spec.cpu_limit, spec.memory_bytes, spec.process_limit
        ))
    )
}

fn ensure_process_success(output: std::process::Output, operation: &str) -> Result<Vec<u8>> {
    if !output.status.success() {
        bail!(
            "{operation} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.stdout)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub provider: String,
    pub bucket: String,
    pub key: String,
    pub sha256: String,
    pub size_bytes: u64,
}

pub trait ArtifactStore {
    fn put_immutable(&mut self, key: &str, bytes: &[u8]) -> Result<ArtifactRef>;
    fn get_verified(&mut self, artifact: &ArtifactRef) -> Result<Vec<u8>>;
}

pub struct MinioArtifactStore {
    client_container: String,
    bucket: String,
}

impl MinioArtifactStore {
    pub fn new(client_container: String, bucket: String) -> Self {
        Self {
            client_container,
            bucket,
        }
    }

    fn target(&self, key: &str) -> Result<String> {
        let path = Path::new(key);
        if path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            bail!("artifact key must be a relative object path");
        }
        Ok(format!("local/{}/{key}", self.bucket))
    }

    fn read(&self, target: &str) -> Result<Vec<u8>> {
        let output = ProcessCommand::new("docker")
            .args(["exec", &self.client_container, "mc", "cat", target])
            .output()?;
        ensure_process_success(output, "read artifact")
    }
}

impl ArtifactStore for MinioArtifactStore {
    fn put_immutable(&mut self, key: &str, bytes: &[u8]) -> Result<ArtifactRef> {
        let target = self.target(key)?;
        let stat = ProcessCommand::new("docker")
            .args(["exec", &self.client_container, "mc", "stat", &target])
            .output()?;
        if stat.status.success() {
            let existing = self.read(&target)?;
            if existing != bytes {
                bail!("immutable artifact key already contains different bytes");
            }
            return Ok(artifact_ref("minio-v1", &self.bucket, key, bytes));
        }

        let mut child = ProcessCommand::new("docker")
            .args([
                "exec",
                "--interactive",
                &self.client_container,
                "mc",
                "pipe",
                &target,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("artifact upload stdin is unavailable"))?
            .write_all(bytes)?;
        let output = child.wait_with_output()?;
        ensure_process_success(output, "upload artifact")?;
        let committed = self.read(&target)?;
        if committed != bytes {
            bail!("artifact read-back verification failed");
        }
        Ok(artifact_ref("minio-v1", &self.bucket, key, bytes))
    }

    fn get_verified(&mut self, artifact: &ArtifactRef) -> Result<Vec<u8>> {
        if artifact.provider != "minio-v1" || artifact.bucket != self.bucket {
            bail!("ArtifactRef belongs to a different store");
        }
        let target = self.target(&artifact.key)?;
        let bytes = self.read(&target)?;
        let observed = format!("{:x}", Sha256::digest(&bytes));
        if observed != artifact.sha256 || bytes.len() as u64 != artifact.size_bytes {
            bail!("artifact checksum or size verification failed");
        }
        Ok(bytes)
    }
}

fn artifact_ref(provider: &str, bucket: &str, key: &str, bytes: &[u8]) -> ArtifactRef {
    ArtifactRef {
        provider: provider.into(),
        bucket: bucket.into(),
        key: key.into(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size_bytes: bytes.len() as u64,
    }
}

pub struct GcsArtifactStore {
    bucket: String,
}

#[derive(Debug)]
struct CachedGcpAccessToken {
    value: String,
    refresh_at: Instant,
}

static GCS_HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
static GCP_ACCESS_TOKEN: Mutex<Option<CachedGcpAccessToken>> = Mutex::new(None);

impl GcsArtifactStore {
    pub fn new(bucket: String) -> Self {
        Self { bucket }
    }

    fn validate_key(&self, key: &str) -> Result<()> {
        let path = Path::new(key);
        if path.is_absolute()
            || path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            bail!("artifact key must be a relative object path");
        }
        Ok(())
    }

    fn client(&self) -> Result<&'static reqwest::blocking::Client> {
        if let Some(client) = GCS_HTTP_CLIENT.get() {
            return Ok(client);
        }
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(512)
            .build()?;
        let _ = GCS_HTTP_CLIENT.set(client);
        GCS_HTTP_CLIENT
            .get()
            .ok_or_else(|| anyhow::anyhow!("Cloud Storage HTTP client initialization failed"))
    }

    fn object_url(&self, key: &str) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse("https://storage.googleapis.com/storage/v1/b")?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Cloud Storage URL cannot accept path segments"))?
            .push(&self.bucket)
            .push("o")
            .push(key);
        url.query_pairs_mut().append_pair("alt", "media");
        Ok(url)
    }

    fn upload_url(&self, key: &str) -> Result<reqwest::Url> {
        let mut url = reqwest::Url::parse("https://storage.googleapis.com/upload/storage/v1/b")?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Cloud Storage URL cannot accept path segments"))?
            .push(&self.bucket)
            .push("o");
        url.query_pairs_mut()
            .append_pair("uploadType", "media")
            .append_pair("name", key)
            .append_pair("ifGenerationMatch", "0");
        Ok(url)
    }

    fn read(&self, key: &str) -> Result<Vec<u8>> {
        self.validate_key(key)?;
        let client = self.client()?;
        let response = client
            .get(self.object_url(key)?)
            .bearer_auth(gcp_access_token(client)?)
            .send()?;
        if !response.status().is_success() {
            bail!(
                "read Cloud Storage artifact failed with HTTP {}",
                response.status()
            );
        }
        Ok(response.bytes()?.to_vec())
    }
}

impl ArtifactStore for GcsArtifactStore {
    fn put_immutable(&mut self, key: &str, bytes: &[u8]) -> Result<ArtifactRef> {
        self.validate_key(key)?;
        let client = self.client()?;
        let response = client
            .post(self.upload_url(key)?)
            .bearer_auth(gcp_access_token(client)?)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes.to_vec())
            .send()?;
        if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
            let existing = self.read(key)?;
            if existing != bytes {
                bail!("immutable Cloud Storage key already contains different bytes");
            }
            return Ok(artifact_ref("gcs-v1", &self.bucket, key, bytes));
        }
        if !response.status().is_success() {
            bail!(
                "upload Cloud Storage artifact failed with HTTP {}",
                response.status()
            );
        }
        let committed = self.read(key)?;
        if committed != bytes {
            bail!("Cloud Storage artifact read-back verification failed");
        }
        Ok(artifact_ref("gcs-v1", &self.bucket, key, bytes))
    }

    fn get_verified(&mut self, artifact: &ArtifactRef) -> Result<Vec<u8>> {
        if artifact.provider != "gcs-v1" || artifact.bucket != self.bucket {
            bail!("ArtifactRef belongs to a different Cloud Storage bucket");
        }
        let bytes = self.read(&artifact.key)?;
        let observed = format!("{:x}", Sha256::digest(&bytes));
        if observed != artifact.sha256 || bytes.len() as u64 != artifact.size_bytes {
            bail!("Cloud Storage artifact checksum or size verification failed");
        }
        Ok(bytes)
    }
}

fn gcp_access_token(client: &reqwest::blocking::Client) -> Result<String> {
    let mut cached = GCP_ACCESS_TOKEN
        .lock()
        .map_err(|_| anyhow::anyhow!("Google access-token cache is poisoned"))?;
    if let Some(token) = cached.as_ref()
        && Instant::now() < token.refresh_at
    {
        return Ok(token.value.clone());
    }
    let metadata = client
        .get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token")
        .header("Metadata-Flavor", "Google")
        .timeout(Duration::from_millis(750))
        .send();
    let (value, lifetime) = if let Ok(response) = metadata {
        if response.status().is_success() {
            let token: serde_json::Value = response.json()?;
            let value = token["access_token"]
                .as_str()
                .context("metadata access token is missing")?
                .to_owned();
            let lifetime = token["expires_in"].as_u64().unwrap_or(300);
            (value, Duration::from_secs(lifetime))
        } else {
            local_gcloud_access_token()?
        }
    } else {
        local_gcloud_access_token()?
    };
    let refresh_margin = Duration::from_secs(60).min(lifetime / 2);
    *cached = Some(CachedGcpAccessToken {
        value: value.clone(),
        refresh_at: Instant::now() + lifetime.saturating_sub(refresh_margin),
    });
    Ok(value)
}

fn local_gcloud_access_token() -> Result<(String, Duration)> {
    let output = ProcessCommand::new("gcloud")
        .args(["auth", "print-access-token"])
        .output()?;
    let value = String::from_utf8(ensure_process_success(
        output,
        "obtain local Google access token",
    )?)?;
    let value = value.trim().to_owned();
    if value.is_empty() {
        bail!("gcloud returned an empty access token");
    }
    Ok((value, Duration::from_secs(300)))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Rejected,
}

pub struct PostgresApprovalLedger {
    client: Client,
}

impl PostgresApprovalLedger {
    pub fn connect(database_url: &str) -> Result<Self> {
        Ok(Self {
            client: Client::connect(database_url, NoTls)?,
        })
    }

    pub fn open_email_tool(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        tool_call_id: &str,
        approval_id: &str,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, run_id, claim_epoch)?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.tool_calls
                (tool_call_id, run_id, kind, state)
             VALUES ($1, $2, 'send_email', 'waiting_approval')",
            &[&tool_call_id, &run_id.0],
        )?;
        tx.execute(
            "INSERT INTO agent_run_lifecycle.approvals
                (approval_id, tool_call_id, state)
             VALUES ($1, $2, 'open')",
            &[&approval_id, &tool_call_id],
        )?;
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'waiting', owner = NULL, lease_until = NULL WHERE run_id = $1",
            &[&run_id.0],
        )?;
        append_semantic(
            &mut tx,
            &run_id.0,
            &format!("ToolCallIntent:{tool_call_id}:SendEmail"),
        )?;
        append_semantic(&mut tx, &run_id.0, &format!("ApprovalOpened:{approval_id}"))?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn decide(
        &mut self,
        approval_id: &str,
        decision_id: &str,
        decision: ApprovalDecision,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        let row = tx.query_opt(
            "SELECT a.state, a.decision_id, a.tool_call_id, t.run_id
             FROM agent_run_lifecycle.approvals a
             JOIN agent_run_lifecycle.tool_calls t USING (tool_call_id)
             WHERE a.approval_id = $1 FOR UPDATE OF a, t",
            &[&approval_id],
        )?;
        let row = row.ok_or_else(|| anyhow::anyhow!("approval is missing"))?;
        let state: String = row.get(0);
        let existing_decision_id: Option<String> = row.get(1);
        let tool_call_id: String = row.get(2);
        let run_id: String = row.get(3);
        if state != "open" {
            if existing_decision_id.as_deref() == Some(decision_id) {
                tx.commit()?;
                return Ok(CommandOutcome::IdempotentReplay);
            }
            bail!("approval is already settled by a different decision");
        }
        let state = match decision {
            ApprovalDecision::Approved => "approved",
            ApprovalDecision::Rejected => "rejected",
        };
        tx.execute(
            "UPDATE agent_run_lifecycle.approvals
             SET state = $2, decision_id = $3, decided_at = clock_timestamp()
             WHERE approval_id = $1",
            &[&approval_id, &state, &decision_id],
        )?;
        tx.execute(
            "UPDATE agent_run_lifecycle.tool_calls SET state = $2 WHERE tool_call_id = $1",
            &[&tool_call_id, &state],
        )?;
        tx.execute(
            "UPDATE agent_run_lifecycle.agent_runs
             SET state = 'pending', wake_count = wake_count + 1
             WHERE run_id = $1 AND state = 'waiting'",
            &[&run_id],
        )?;
        append_semantic(
            &mut tx,
            &run_id,
            &format!("ApprovalSettled:{approval_id}:{state}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn begin_attempt(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        tool_call_id: &str,
        attempt_id: &str,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, run_id, claim_epoch)?;
        let updated = tx.execute(
            "UPDATE agent_run_lifecycle.tool_calls
             SET state = 'running', attempt_count = attempt_count + 1
             WHERE tool_call_id = $1 AND run_id = $2 AND state = 'approved'",
            &[&tool_call_id, &run_id.0],
        )?;
        if updated != 1 {
            bail!("ToolCall is not approved for execution");
        }
        tx.execute(
            "INSERT INTO agent_run_lifecycle.tool_attempts
                (attempt_id, tool_call_id, claim_epoch, state)
             VALUES ($1, $2, $3, 'running')",
            &[&attempt_id, &tool_call_id, &(claim_epoch as i64)],
        )?;
        append_semantic(
            &mut tx,
            &run_id.0,
            &format!("ToolCallAttempt:{tool_call_id}:{attempt_id}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn complete_attempt(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        tool_call_id: &str,
        attempt_id: &str,
        outcome: &str,
    ) -> Result<CommandOutcome> {
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, run_id, claim_epoch)?;
        let tool = tx.query_opt(
            "SELECT state, terminal_outcome
             FROM agent_run_lifecycle.tool_calls
             WHERE tool_call_id = $1 AND run_id = $2 FOR UPDATE",
            &[&tool_call_id, &run_id.0],
        )?;
        let tool = tool.ok_or_else(|| anyhow::anyhow!("ToolCall is missing"))?;
        let state: String = tool.get(0);
        let terminal_outcome: Option<String> = tool.get(1);
        if matches!(state.as_str(), "succeeded" | "failed" | "canceled") {
            if terminal_outcome.as_deref() == Some(outcome) {
                tx.commit()?;
                return Ok(CommandOutcome::IdempotentReplay);
            }
            bail!("ToolCall already has a different terminal outcome");
        }
        let attempt = tx.execute(
            "UPDATE agent_run_lifecycle.tool_attempts
             SET state = 'succeeded', outcome = $2, completed_at = clock_timestamp()
             WHERE attempt_id = $1 AND tool_call_id = $3
               AND claim_epoch = $4 AND state IN ('running', 'unknown')",
            &[&attempt_id, &outcome, &tool_call_id, &(claim_epoch as i64)],
        )?;
        if attempt != 1 {
            bail!("ToolCall attempt is stale or already terminal");
        }
        tx.execute(
            "UPDATE agent_run_lifecycle.tool_calls
             SET state = 'succeeded', terminal_outcome = $2,
                 terminal_at = clock_timestamp()
             WHERE tool_call_id = $1",
            &[&tool_call_id, &outcome],
        )?;
        append_semantic(
            &mut tx,
            &run_id.0,
            &format!("ToolCallOutcome:{tool_call_id}:{outcome}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn fail_attempt(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        tool_call_id: &str,
        attempt_id: &str,
        outcome: &str,
        maximum_attempts: u32,
    ) -> Result<CommandOutcome> {
        if maximum_attempts == 0 || outcome.trim().is_empty() {
            bail!("ToolCall retry policy and failure outcome are required");
        }
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, run_id, claim_epoch)?;
        let tool = tx.query_opt(
            "SELECT state, attempt_count
             FROM agent_run_lifecycle.tool_calls
             WHERE tool_call_id = $1 AND run_id = $2 FOR UPDATE",
            &[&tool_call_id, &run_id.0],
        )?;
        let tool = tool.ok_or_else(|| anyhow::anyhow!("ToolCall is missing"))?;
        let state: String = tool.get(0);
        let attempt_count: i32 = tool.get(1);
        if state != "running" {
            bail!("ToolCall is not running");
        }
        let updated = tx.execute(
            "UPDATE agent_run_lifecycle.tool_attempts
             SET state = 'failed', outcome = $2, completed_at = clock_timestamp()
             WHERE attempt_id = $1 AND tool_call_id = $3
               AND claim_epoch = $4 AND state = 'running'",
            &[&attempt_id, &outcome, &tool_call_id, &(claim_epoch as i64)],
        )?;
        if updated != 1 {
            bail!("ToolCall attempt is stale or already terminal");
        }
        if attempt_count < maximum_attempts as i32 {
            tx.execute(
                "UPDATE agent_run_lifecycle.tool_calls SET state = 'approved'
                 WHERE tool_call_id = $1",
                &[&tool_call_id],
            )?;
            tx.execute(
                "UPDATE agent_run_lifecycle.agent_runs
                 SET state = 'retry_ready', owner = NULL, lease_until = NULL
                 WHERE run_id = $1",
                &[&run_id.0],
            )?;
            append_semantic(
                &mut tx,
                &run_id.0,
                &format!("ToolCallRetryScheduled:{tool_call_id}:{attempt_id}:{outcome}"),
            )?;
        } else {
            tx.execute(
                "UPDATE agent_run_lifecycle.tool_calls
                 SET state = 'failed', terminal_outcome = $2,
                     terminal_at = clock_timestamp()
                 WHERE tool_call_id = $1",
                &[&tool_call_id, &outcome],
            )?;
            append_semantic(
                &mut tx,
                &run_id.0,
                &format!("ToolCallOutcome:{tool_call_id}:failed:{outcome}"),
            )?;
        }
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }

    pub fn mark_attempt_unknown(
        &mut self,
        run_id: &RunId,
        claim_epoch: u64,
        tool_call_id: &str,
        attempt_id: &str,
        reason: &str,
    ) -> Result<CommandOutcome> {
        if reason.trim().is_empty() {
            bail!("unknown ToolCall attempt requires a reason");
        }
        let mut tx = self.client.transaction()?;
        lock_running_epoch(&mut tx, run_id, claim_epoch)?;
        let updated = tx.execute(
            "UPDATE agent_run_lifecycle.tool_attempts
             SET state = 'unknown', outcome = $2, completed_at = clock_timestamp()
             WHERE attempt_id = $1 AND tool_call_id = $3
               AND claim_epoch = $4 AND state = 'running'",
            &[&attempt_id, &reason, &tool_call_id, &(claim_epoch as i64)],
        )?;
        if updated != 1 {
            bail!("ToolCall attempt is stale or already terminal");
        }
        append_semantic(
            &mut tx,
            &run_id.0,
            &format!("ToolCallAttemptUnknown:{tool_call_id}:{attempt_id}:{reason}"),
        )?;
        tx.commit()?;
        Ok(CommandOutcome::Applied)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    pub from: String,
    pub to: String,
    pub subject: String,
    pub body: String,
}

pub trait SmtpSink {
    fn send(&mut self, message: &EmailMessage) -> Result<()>;
}

pub struct MailpitSmtpSink {
    smtp_address: String,
    api_address: String,
}

impl MailpitSmtpSink {
    pub fn local() -> Self {
        Self {
            smtp_address: "127.0.0.1:1025".into(),
            api_address: "127.0.0.1:8025".into(),
        }
    }

    pub fn reset(&mut self) -> Result<()> {
        self.http("DELETE", "/api/v1/messages")?;
        Ok(())
    }

    pub fn message_count(&mut self) -> Result<u64> {
        let body = self.http("GET", "/api/v1/messages")?;
        let response: serde_json::Value = serde_json::from_slice(&body)?;
        response["total"]
            .as_u64()
            .ok_or_else(|| anyhow::anyhow!("Mailpit response omitted total"))
    }

    fn http(&self, method: &str, path: &str) -> Result<Vec<u8>> {
        let mut stream = TcpStream::connect(&self.api_address)?;
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            self.api_address
        )?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response)?;
        let header_end = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .ok_or_else(|| anyhow::anyhow!("invalid Mailpit HTTP response"))?;
        let header = String::from_utf8_lossy(&response[..header_end]);
        let status = header
            .lines()
            .next()
            .ok_or_else(|| anyhow::anyhow!("Mailpit HTTP status is missing"))?;
        if !status.contains(" 200 ") {
            bail!("Mailpit HTTP request failed: {status}");
        }
        response_body(&response)
    }
}

fn response_body(response: &[u8]) -> Result<Vec<u8>> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| anyhow::anyhow!("invalid HTTP response"))?;
    let header = String::from_utf8_lossy(&response[..header_end]).to_ascii_lowercase();
    let body = &response[(header_end + 4)..];
    if !header
        .lines()
        .any(|line| line.trim() == "transfer-encoding: chunked")
    {
        return Ok(body.to_vec());
    }
    decode_chunked(body)
}

fn decode_chunked(mut encoded: &[u8]) -> Result<Vec<u8>> {
    let mut decoded = Vec::new();
    loop {
        let line_end = encoded
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| anyhow::anyhow!("chunk size line is incomplete"))?;
        let size_line = std::str::from_utf8(&encoded[..line_end])?;
        let size_text = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| anyhow::anyhow!("invalid HTTP chunk size"))?;
        encoded = &encoded[(line_end + 2)..];
        if size == 0 {
            return Ok(decoded);
        }
        if encoded.len() < size + 2 || &encoded[size..(size + 2)] != b"\r\n" {
            bail!("HTTP chunk body is incomplete");
        }
        decoded.extend_from_slice(&encoded[..size]);
        encoded = &encoded[(size + 2)..];
    }
}

impl SmtpSink for MailpitSmtpSink {
    fn send(&mut self, message: &EmailMessage) -> Result<()> {
        for header in [&message.from, &message.to, &message.subject] {
            if header.contains(['\r', '\n']) {
                bail!("email header contains a newline");
            }
        }
        let mut stream = TcpStream::connect(&self.smtp_address)?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.set_write_timeout(Some(Duration::from_secs(3)))?;
        let mut reader = BufReader::new(stream.try_clone()?);
        expect_smtp(&mut reader, 220)?;
        smtp_line(&mut stream, "EHLO osfo.invalid")?;
        expect_smtp(&mut reader, 250)?;
        smtp_line(&mut stream, &format!("MAIL FROM:<{}>", message.from))?;
        expect_smtp(&mut reader, 250)?;
        smtp_line(&mut stream, &format!("RCPT TO:<{}>", message.to))?;
        expect_smtp(&mut reader, 250)?;
        smtp_line(&mut stream, "DATA")?;
        expect_smtp(&mut reader, 354)?;
        let body = message.body.replace("\r\n", "\n").replace('\r', "\n");
        let body = body
            .lines()
            .map(|line| {
                if line.starts_with('.') {
                    format!(".{line}")
                } else {
                    line.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\r\n");
        write!(
            stream,
            "From: {}\r\nTo: {}\r\nSubject: {}\r\n\r\n{}\r\n.\r\n",
            message.from, message.to, message.subject, body
        )?;
        stream.flush()?;
        expect_smtp(&mut reader, 250)?;
        smtp_line(&mut stream, "QUIT")?;
        expect_smtp(&mut reader, 221)?;
        Ok(())
    }
}

#[cfg(test)]
mod mailpit_http_tests {
    use super::response_body;

    #[test]
    fn mailpit_chunked_api_response_is_decoded_before_json_parsing() {
        let response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1}\r\n0\r\n\r\n";

        let body = response_body(response).expect("decode chunked body");

        assert_eq!(body, b"{\"a\":1}");
    }
}

#[cfg(test)]
mod query_insights_tag_tests {
    use super::lifecycle_database_config;

    #[test]
    fn hot_lifecycle_queries_have_bounded_sqlcommenter_families() {
        let source = include_str!("lib.rs");

        for family in ["admission", "claim", "transition", "completion"] {
            assert!(
                source.contains(&format!("/*action='{family}'*/")),
                "missing Query Insights tag for {family}"
            );
        }
    }

    #[test]
    fn lifecycle_connections_have_a_bounded_application_name() {
        let config = lifecycle_database_config("postgresql://localhost/osfo")
            .expect("parse lifecycle database configuration");

        assert_eq!(config.get_application_name(), Some("osfo-lifecycle"));
    }
}

fn smtp_line(stream: &mut TcpStream, line: &str) -> Result<()> {
    write!(stream, "{line}\r\n")?;
    stream.flush()?;
    Ok(())
}

fn expect_smtp(reader: &mut BufReader<TcpStream>, expected: u16) -> Result<()> {
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            bail!("SMTP server closed the connection");
        }
        let code: u16 = line
            .get(0..3)
            .ok_or_else(|| anyhow::anyhow!("invalid SMTP response"))?
            .parse()?;
        if code != expected {
            bail!("SMTP expected {expected}, received {line:?}");
        }
        if line.as_bytes().get(3) != Some(&b'-') {
            return Ok(());
        }
    }
}
