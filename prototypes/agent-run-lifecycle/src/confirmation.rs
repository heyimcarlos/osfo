use std::collections::{BTreeMap, BTreeSet, HashSet};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

pub const REQUIRED_OFFERED_RATES: [u64; 4] = [700, 1_400, 2_083, 4_167];
pub const REQUIRED_PERSISTENCE_PROFILES: [&str; 3] = [
    "cold-logical-reconstruction",
    "checkpoint-and-sandbox-restore",
    "per-step-checkpoint",
];
pub const REQUIRED_FAILURE_INJECTIONS: &[&str] = &[
    "unknown admission commit outcome",
    "expired lease takeover and stale completion",
    "model provider dispatch lost acknowledgement",
    "partial model output before normalized outcome",
    "ToolCall attempt retry exhaustion",
    "ToolCall unknown terminal commit outcome",
    "duplicate decision and terminal outcome",
    "ChildJoin concurrent settlement and late outcome",
    "ChildJoin deadline cancellation",
    "Temporal start missing confirmation reconciliation",
    "duplicate workflow progress and outcome delivery",
    "waiting wake races cancellation",
    "sandbox missing, deleted, corrupt, expired, and incompatible",
    "artifact export verification and commit interruption",
    "checkpoint absent, deleted, corrupt, and incompatible",
    "compatible worker temporarily unavailable",
    "authoritative record unsupported",
    "Osfo worker process kill and restart",
    "Temporal worker process kill and restart",
    "Temporal unavailable after start intent",
    "wrong-order release update",
    "duplicate editorial update ID",
    "post-settlement update",
    "timer herd with delayed callbacks",
    "first publish attempt fails",
    "dropped and replayed callback",
    "cancellation at workflow boundaries",
    "pinned history replay",
    "intentional command-order change",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmationManifest {
    pub schema_version: u32,
    pub run_id: String,
    pub seed: u64,
    pub question: String,
    pub topology: TopologyManifest,
    pub worker_fleet: WorkerFleetManifest,
    pub principal_mix: PrincipalMix,
    pub required_offered_agent_runs_per_second: Vec<u64>,
    pub required_persistence_profiles: Vec<String>,
    pub journey_mix: JourneyMix,
    pub stages: Vec<ConfirmationStage>,
    pub failure_plan: Vec<FailurePlanRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopologyManifest {
    pub same_region_compute_and_cloud_sql: bool,
    pub cloud_sql_is_agent_run_authority: bool,
    pub temporal_persistence_isolated: bool,
    pub fixed_temporal_worker_fleet: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerFleetManifest {
    pub generator_instances: usize,
    pub lifecycle_workers: usize,
    pub admission_workers: usize,
    pub execution_workers: usize,
    pub execution_lane_workers: ExecutionLaneWorkers,
    pub database_pool_size: usize,
    pub temporal_worker_processes: usize,
    pub temporal_gateway_concurrency: usize,
    pub temporal_workflow_slots_per_process: usize,
    pub temporal_activity_slots_per_process: usize,
    pub maximum_admission_queue_depth: usize,
    pub maximum_arrival_lag_milliseconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionLaneWorkers {
    pub basic: usize,
    pub child: usize,
    pub temporal: usize,
    pub sandbox: usize,
    pub smtp: usize,
}

impl ExecutionLaneWorkers {
    pub fn total(&self) -> usize {
        self.basic + self.child + self.temporal + self.sandbox + self.smtp
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrincipalMix {
    pub noisy_percent: u8,
    pub quiet_principal_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JourneyMix {
    pub basic_agent_run_percent: u8,
    pub child_fanout_percent: u8,
    pub awaited_workflow_percent: u8,
    pub detached_workflow_percent: u8,
    pub sandbox_artifact_percent: u8,
    pub approval_smtp_percent: u8,
    pub full_reference_journey_percent: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmationStage {
    pub name: String,
    pub phase: StagePhase,
    pub arrival_pattern: ArrivalPattern,
    pub workload_lane: WorkloadLane,
    pub offered_agent_runs_per_second: u64,
    pub duration_seconds: u64,
    pub persistence_profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailurePlanRow {
    pub injection: String,
    pub stage: String,
    pub offered_agent_runs_per_second: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StagePhase {
    Warmup,
    Steady,
    Ramp,
    Impulse,
    MixedJourneys,
    ChildFanout,
    ApprovalBatch,
    TimerHerd,
    RetryStorm,
    FailureUnderLoad,
    PostKnee,
    Recovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArrivalPattern {
    OpenLoopUniform,
    OpenLoopImpulse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkloadLane {
    ProductionShapedDeterministic,
    PostgresMetadataOnly,
}

impl ConfirmationManifest {
    pub fn from_json(input: &str) -> Result<Self> {
        let manifest: Self = serde_json::from_str(input).context("parse confirmation manifest")?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 3 {
            bail!(
                "unsupported confirmation schema version {}",
                self.schema_version
            );
        }
        if self.run_id.trim().is_empty() || self.question.trim().is_empty() {
            bail!("run ID and confirmation question are required");
        }
        if !self.topology.same_region_compute_and_cloud_sql
            || !self.topology.cloud_sql_is_agent_run_authority
            || !self.topology.temporal_persistence_isolated
            || !self.topology.fixed_temporal_worker_fleet
        {
            bail!(
                "confirmation topology must use same-region Cloud SQL authority, isolated Temporal persistence, and a fixed Temporal worker fleet"
            );
        }
        if [
            self.worker_fleet.generator_instances,
            self.worker_fleet.lifecycle_workers,
            self.worker_fleet.admission_workers,
            self.worker_fleet.execution_workers,
            self.worker_fleet.execution_lane_workers.basic,
            self.worker_fleet.execution_lane_workers.child,
            self.worker_fleet.execution_lane_workers.temporal,
            self.worker_fleet.execution_lane_workers.sandbox,
            self.worker_fleet.execution_lane_workers.smtp,
            self.worker_fleet.database_pool_size,
            self.worker_fleet.temporal_worker_processes,
            self.worker_fleet.temporal_gateway_concurrency,
            self.worker_fleet.temporal_workflow_slots_per_process,
            self.worker_fleet.temporal_activity_slots_per_process,
            self.worker_fleet.maximum_admission_queue_depth,
            self.worker_fleet.maximum_arrival_lag_milliseconds as usize,
        ]
        .contains(&0)
        {
            bail!("fixed worker fleet values must be positive");
        }
        if self.worker_fleet.admission_workers + self.worker_fleet.execution_workers
            != self.worker_fleet.lifecycle_workers
        {
            bail!("admission and execution worker split must equal the fixed lifecycle fleet");
        }
        if self.worker_fleet.execution_lane_workers.total() != self.worker_fleet.execution_workers {
            bail!("execution lane workers must equal the fixed execution worker split");
        }
        if self.worker_fleet.temporal_gateway_concurrency
            > self.worker_fleet.temporal_workflow_slots_per_process
                * self.worker_fleet.temporal_worker_processes
        {
            bail!("Temporal gateway concurrency cannot exceed fixed workflow worker slots");
        }
        if self.principal_mix.noisy_percent == 0
            || self.principal_mix.noisy_percent >= 100
            || self.principal_mix.quiet_principal_count == 0
        {
            bail!("principal mix must include one noisy and at least one quiet Principal");
        }
        if !REQUIRED_OFFERED_RATES
            .iter()
            .all(|rate| self.required_offered_agent_runs_per_second.contains(rate))
        {
            bail!("required offered rates must include 700, 1400, 2083, and 4167");
        }
        if !REQUIRED_PERSISTENCE_PROFILES.iter().all(|profile| {
            self.required_persistence_profiles
                .iter()
                .any(|candidate| candidate == profile)
        }) {
            bail!("all three issue 13 persistence profiles are required");
        }
        if self.journey_mix.total_percent() != 100 {
            bail!("journey mix must total exactly 100 percent");
        }

        let mut names = HashSet::new();
        for stage in &self.stages {
            if !names.insert(stage.name.as_str()) {
                bail!("duplicate confirmation stage name: {}", stage.name);
            }
            if stage.offered_agent_runs_per_second == 0 || stage.duration_seconds == 0 {
                bail!("stage {} has a non-positive load setting", stage.name);
            }
            if !self
                .required_persistence_profiles
                .contains(&stage.persistence_profile)
            {
                bail!(
                    "stage {} uses undeclared persistence profile {}",
                    stage.name,
                    stage.persistence_profile
                );
            }
        }

        for profile in &self.required_persistence_profiles {
            for rate in REQUIRED_OFFERED_RATES {
                let present = self.stages.iter().any(|stage| {
                    stage.phase == StagePhase::Steady
                        && stage.arrival_pattern == ArrivalPattern::OpenLoopUniform
                        && stage.workload_lane == WorkloadLane::ProductionShapedDeterministic
                        && stage.offered_agent_runs_per_second == rate
                        && stage.duration_seconds >= 1_800
                        && stage.persistence_profile == *profile
                });
                if !present {
                    bail!(
                        "missing steady production-shaped stage for {rate} AgentRuns/s and profile {profile}"
                    );
                }
            }
        }

        for phase in [
            StagePhase::Ramp,
            StagePhase::Impulse,
            StagePhase::MixedJourneys,
            StagePhase::ChildFanout,
            StagePhase::ApprovalBatch,
            StagePhase::TimerHerd,
            StagePhase::RetryStorm,
            StagePhase::FailureUnderLoad,
            StagePhase::PostKnee,
            StagePhase::Recovery,
        ] {
            let present = self.stages.iter().any(|stage| {
                stage.phase == phase
                    && stage.workload_lane == WorkloadLane::ProductionShapedDeterministic
                    && matches!(
                        (phase, stage.arrival_pattern),
                        (StagePhase::Impulse, ArrivalPattern::OpenLoopImpulse)
                            | (_, ArrivalPattern::OpenLoopUniform)
                    )
            });
            if !present {
                bail!("missing required production-shaped phase {phase:?}");
            }
        }

        let planned_injections = self
            .failure_plan
            .iter()
            .map(|row| row.injection.as_str())
            .collect::<HashSet<_>>();
        let missing_failures = REQUIRED_FAILURE_INJECTIONS
            .iter()
            .filter(|injection| !planned_injections.contains(**injection))
            .copied()
            .collect::<Vec<_>>();
        if !missing_failures.is_empty() {
            bail!("failure plan is missing: {}", missing_failures.join(", "));
        }
        if planned_injections.len() != self.failure_plan.len() {
            bail!("failure plan contains duplicate injection rows");
        }
        for row in &self.failure_plan {
            if !REQUIRED_FAILURE_INJECTIONS.contains(&row.injection.as_str()) {
                bail!(
                    "failure plan contains an unknown injection: {}",
                    row.injection
                );
            }
            let Some(stage) = self.stages.iter().find(|stage| stage.name == row.stage) else {
                bail!("failure plan references missing stage: {}", row.stage);
            };
            if stage.phase != StagePhase::FailureUnderLoad
                || stage.offered_agent_runs_per_second != row.offered_agent_runs_per_second
            {
                bail!(
                    "failure plan row must match a failure-under-load stage and its offered rate"
                );
            }
        }

        Ok(())
    }

    pub fn steady_target_stages(&self) -> impl Iterator<Item = &ConfirmationStage> {
        self.stages.iter().filter(|stage| {
            stage.phase == StagePhase::Steady
                && stage.workload_lane == WorkloadLane::ProductionShapedDeterministic
                && REQUIRED_OFFERED_RATES.contains(&stage.offered_agent_runs_per_second)
        })
    }
}

impl JourneyMix {
    fn total_percent(&self) -> u16 {
        [
            self.basic_agent_run_percent,
            self.child_fanout_percent,
            self.awaited_workflow_percent,
            self.detached_workflow_percent,
            self.sandbox_artifact_percent,
            self.approval_smtp_percent,
            self.full_reference_journey_percent,
        ]
        .into_iter()
        .map(u16::from)
        .sum()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrafficAccounting {
    pub offered: u64,
    pub received: u64,
    pub caller_drop: u64,
    pub accepted: u64,
    pub shed_or_rejected: u64,
    pub completed: u64,
    pub failed: u64,
    pub canceled: u64,
    pub still_in_flight: u64,
}

impl TrafficAccounting {
    pub fn reconcile(&self) -> Result<()> {
        if self.offered != self.received.saturating_add(self.caller_drop) {
            bail!("offered work does not reconcile with received work and caller drops");
        }
        if self.received != self.accepted.saturating_add(self.shed_or_rejected) {
            bail!("received work does not reconcile with accepted and shed or rejected work");
        }
        let terminal_or_live = self
            .completed
            .saturating_add(self.failed)
            .saturating_add(self.canceled)
            .saturating_add(self.still_in_flight);
        if self.accepted != terminal_or_live {
            bail!("accepted work does not reconcile with terminal and in-flight work");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GateStatus {
    Pass,
    Fail,
    Missing,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConfirmationObservations {
    pub run_id: String,
    pub observed_stages: BTreeSet<String>,
    pub traffic_by_stage: BTreeMap<String, TrafficAccounting>,
    pub failed_invariants: Vec<String>,
    pub observed_failure_injections: BTreeSet<String>,
    pub telemetry_complete: Option<bool>,
    pub workload_fidelity: Option<bool>,
    pub safe_overload: Option<bool>,
    pub recovery_complete: Option<bool>,
    pub topology_verified: Option<bool>,
    pub target_requirements_met: Option<bool>,
    pub evidence_checksums: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapacityEnvelope {
    pub unit: String,
    pub highest_confirmed: Option<u64>,
    pub knee_lower_bound: Option<u64>,
    pub knee_upper_bound: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfirmationVerdict {
    pub run_id: String,
    pub verdict: GateStatus,
    pub evidence_validity: GateStatus,
    pub target_result: GateStatus,
    pub correctness_gate: GateStatus,
    pub telemetry_gate: GateStatus,
    pub workload_fidelity_gate: GateStatus,
    pub safe_overload_gate: GateStatus,
    pub recovery_gate: GateStatus,
    pub topology_gate: GateStatus,
    pub load_matrix_gate: GateStatus,
    pub failure_matrix_gate: GateStatus,
    pub capacity_envelope: CapacityEnvelope,
    pub missing_rows: Vec<String>,
    pub failed_invariants: Vec<String>,
    pub evidence_checksums: Option<String>,
}

impl ConfirmationVerdict {
    pub fn evaluate(
        manifest: &ConfirmationManifest,
        observations: &ConfirmationObservations,
    ) -> Self {
        let missing_stages = manifest
            .stages
            .iter()
            .filter(|stage| !observations.observed_stages.contains(&stage.name))
            .map(|stage| format!("stage:{}", stage.name));
        let missing_failures = REQUIRED_FAILURE_INJECTIONS
            .iter()
            .filter(|injection| {
                !observations
                    .observed_failure_injections
                    .contains(**injection)
            })
            .map(|injection| format!("failure:{injection}"));
        let mut missing_rows = missing_stages.chain(missing_failures).collect::<Vec<_>>();
        for stage in &observations.observed_stages {
            if !observations.traffic_by_stage.contains_key(stage) {
                missing_rows.push(format!("traffic:{stage}"));
            }
        }
        missing_rows.sort();

        let traffic_failures = observations
            .traffic_by_stage
            .iter()
            .filter_map(|(stage, traffic)| {
                traffic
                    .reconcile()
                    .err()
                    .map(|error| format!("{stage}: {error}"))
            })
            .collect::<Vec<_>>();
        let mut failed_invariants = observations.failed_invariants.clone();
        failed_invariants.extend(traffic_failures);
        if observations.run_id != manifest.run_id {
            failed_invariants.push(format!(
                "run ID mismatch: expected {}, observed {}",
                manifest.run_id, observations.run_id
            ));
        }

        let load_matrix_gate = if missing_rows
            .iter()
            .any(|row| row.starts_with("stage:") || row.starts_with("traffic:"))
        {
            GateStatus::Missing
        } else if failed_invariants.iter().any(|failure| {
            observations
                .traffic_by_stage
                .keys()
                .any(|stage| failure.starts_with(stage))
        }) {
            GateStatus::Fail
        } else {
            GateStatus::Pass
        };
        let failure_matrix_gate = if missing_rows.iter().any(|row| row.starts_with("failure:")) {
            GateStatus::Missing
        } else {
            GateStatus::Pass
        };
        let correctness_gate = if failed_invariants.is_empty() {
            GateStatus::Pass
        } else {
            GateStatus::Fail
        };
        let telemetry_gate = status(observations.telemetry_complete);
        let workload_fidelity_gate = status(observations.workload_fidelity);
        let safe_overload_gate = status(observations.safe_overload);
        let recovery_gate = status(observations.recovery_complete);
        let topology_gate = status(observations.topology_verified);
        let target_result = status(observations.target_requirements_met);

        let evidence_gates = [
            correctness_gate,
            telemetry_gate,
            workload_fidelity_gate,
            safe_overload_gate,
            recovery_gate,
            topology_gate,
            load_matrix_gate,
            failure_matrix_gate,
            if observations.evidence_checksums.is_some() {
                GateStatus::Pass
            } else {
                GateStatus::Missing
            },
        ];
        let evidence_validity = combine(&evidence_gates);
        let verdict = combine(&[evidence_validity, target_result]);
        let capacity_envelope = capacity_envelope(manifest, observations);

        Self {
            run_id: manifest.run_id.clone(),
            verdict,
            evidence_validity,
            target_result,
            correctness_gate,
            telemetry_gate,
            workload_fidelity_gate,
            safe_overload_gate,
            recovery_gate,
            topology_gate,
            load_matrix_gate,
            failure_matrix_gate,
            capacity_envelope,
            missing_rows,
            failed_invariants,
            evidence_checksums: observations.evidence_checksums.clone(),
        }
    }
}

fn capacity_envelope(
    manifest: &ConfirmationManifest,
    observations: &ConfirmationObservations,
) -> CapacityEnvelope {
    let rate_passed = |rate: u64| {
        let stages = manifest
            .steady_target_stages()
            .filter(|stage| stage.offered_agent_runs_per_second == rate)
            .collect::<Vec<_>>();
        stages.len() == manifest.required_persistence_profiles.len()
            && stages.iter().all(|stage| {
                observations
                    .traffic_by_stage
                    .get(&stage.name)
                    .is_some_and(steady_stage_confirmed)
            })
    };
    let highest_confirmed = REQUIRED_OFFERED_RATES
        .into_iter()
        .filter(|rate| rate_passed(*rate))
        .max();
    let knee_upper_bound = REQUIRED_OFFERED_RATES.into_iter().find(|rate| {
        highest_confirmed.is_none_or(|confirmed| *rate > confirmed) && !rate_passed(*rate)
    });

    CapacityEnvelope {
        unit: "offered AgentRuns/s".into(),
        highest_confirmed,
        knee_lower_bound: highest_confirmed.filter(|_| knee_upper_bound.is_some()),
        knee_upper_bound,
    }
}

fn steady_stage_confirmed(traffic: &TrafficAccounting) -> bool {
    traffic.reconcile().is_ok()
        && traffic.caller_drop == 0
        && traffic.shed_or_rejected == 0
        && traffic.failed == 0
        && traffic.canceled == 0
        && traffic.still_in_flight == 0
        && traffic.completed == traffic.accepted
}

fn status(value: Option<bool>) -> GateStatus {
    match value {
        Some(true) => GateStatus::Pass,
        Some(false) => GateStatus::Fail,
        None => GateStatus::Missing,
    }
}

fn combine(statuses: &[GateStatus]) -> GateStatus {
    if statuses.contains(&GateStatus::Missing) {
        GateStatus::Missing
    } else if statuses.contains(&GateStatus::Fail) {
        GateStatus::Fail
    } else {
        GateStatus::Pass
    }
}
