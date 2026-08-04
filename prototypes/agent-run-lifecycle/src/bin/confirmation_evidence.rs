use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::{Command as ProcessCommand, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::{
    ArtifactStore, Command, DockerSandboxProvider, GcsArtifactStore, MailpitSmtpSink,
    MinioArtifactStore, PostgresApprovalLedger, PostgresLifecycle, RunState,
    confirmation::{
        ConfirmationManifest, ConfirmationObservations, ConfirmationStage, ConfirmationVerdict,
        StagePhase, TrafficAccounting,
    },
    evidence::{
        CorrectnessCheck, EvidenceBundle, FailureEvidence, ScenarioEvidence, TimeSample,
        load_frozen_telemetry, render_dashboard_with_telemetry,
    },
    latency::{LatencyRecorder, LatencySample},
    load::{ArrivalDisposition, LinearRampSchedule, OpenLoopSchedule},
    metrics::{MetricsRegistry, MetricsSnapshot},
    production_lane::{
        complete_after_awaited_workflow, complete_child_journey, consume_child_outcomes,
        execute_approved_email, execute_database_journey, execute_sandbox_artifact_journey,
        open_and_approve_email, open_and_settle_child_join,
    },
    temporal_lane::{TemporalWorkerFleet, TemporalWorkerFleetConfig, TemporalWorkflowClient},
    workload::{JourneyKind, WorkloadAdmission, WorkloadSelector},
};
use postgres::{Client, NoTls};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Default)]
struct StageCounters {
    offered: AtomicU64,
    received: AtomicU64,
    caller_drop: AtomicU64,
    accepted: AtomicU64,
    shed_or_rejected: AtomicU64,
    temporal_delivery_retries: AtomicU64,
    completed: AtomicU64,
    failed: AtomicU64,
    canceled: AtomicU64,
    errors: AtomicU64,
}

struct InFlightGuard {
    counter: Arc<AtomicU64>,
}

impl InFlightGuard {
    fn new(counter: Arc<AtomicU64>) -> Self {
        Self { counter }
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::Relaxed);
    }
}

fn retry_with_backoff<T, F>(attempts: usize, delay: Duration, mut operation: F) -> Result<T>
where
    F: FnMut() -> Result<T>,
{
    if attempts == 0 {
        anyhow::bail!("retry attempts must be greater than zero");
    }
    let mut last_error = None;
    for attempt in 0..attempts {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < attempts && !delay.is_zero() {
            thread::sleep(delay);
        }
    }
    Err(last_error.expect("at least one retry attempt executed"))
}

#[derive(Clone)]
struct ScheduledOffer {
    ordinal: usize,
    intended_at: Instant,
    principal: String,
    journey: JourneyKind,
}

struct TemporalDispatch {
    run_id: osfo_agent_run_lifecycle_prototype::RunId,
    workflow_id: String,
    ordinal: u64,
    stage: String,
}

#[derive(Clone, Copy)]
enum StageSchedule {
    Uniform(OpenLoopSchedule),
    Ramp(LinearRampSchedule),
}

impl StageSchedule {
    fn for_stage(
        stage: &ConfirmationStage,
        maximum_lag: Duration,
        duration: Duration,
    ) -> Result<Self> {
        if stage.phase == StagePhase::Ramp {
            Ok(Self::Ramp(LinearRampSchedule::new(
                700.0,
                stage.offered_agent_runs_per_second as f64,
                duration,
                maximum_lag,
            )?))
        } else {
            Ok(Self::Uniform(OpenLoopSchedule::new(
                stage.offered_agent_runs_per_second as f64,
                duration,
                maximum_lag,
            )?))
        }
    }

    fn offered_count(self) -> usize {
        match self {
            Self::Uniform(value) => value.offered_count(),
            Self::Ramp(value) => value.offered_count(),
        }
    }

    fn target_offset(self, ordinal: usize) -> Duration {
        match self {
            Self::Uniform(value) => value.target_offset(ordinal),
            Self::Ramp(value) => value.target_offset(ordinal),
        }
    }

    fn classify(self, ordinal: usize, actual: Duration) -> ArrivalDisposition {
        match self {
            Self::Uniform(value) => value.classify(ordinal, actual),
            Self::Ramp(value) => value.classify(ordinal, actual),
        }
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let telemetry_profile = telemetry_profile();
    let prototype_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest_path = std::env::var("OSFO_CONFIRMATION_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| prototype_dir.join("config/issue-13-confirmation.json"));
    let manifest_source = fs::read_to_string(&manifest_path)?;
    let mut manifest = ConfirmationManifest::from_json(&manifest_source)?;
    if let Ok(run_id) = std::env::var("OSFO_RUN_ID") {
        manifest.run_id = run_id;
    }
    let diagnostic = std::env::var("OSFO_DIAGNOSTIC_MODE").as_deref() == Ok("1");
    if diagnostic && let Ok(workers) = std::env::var("OSFO_WORKER_OVERRIDE") {
        let workers = workers.parse::<usize>()?;
        if workers < 4 {
            anyhow::bail!("diagnostic worker override must be at least four");
        }
        manifest.worker_fleet.lifecycle_workers = workers;
        manifest.worker_fleet.admission_workers = (workers / 8).max(1);
        manifest.worker_fleet.execution_workers = workers - manifest.worker_fleet.admission_workers;
        let execution = manifest.worker_fleet.execution_workers;
        manifest.worker_fleet.execution_lane_workers.temporal = (execution * 38 / 100).max(1);
        manifest.worker_fleet.execution_lane_workers.sandbox = (execution * 9 / 100).max(1);
        manifest.worker_fleet.execution_lane_workers.child = (execution * 7 / 100).max(1);
        manifest.worker_fleet.execution_lane_workers.smtp = (execution * 2 / 100).max(1);
        manifest.worker_fleet.execution_lane_workers.basic = execution
            - manifest.worker_fleet.execution_lane_workers.temporal
            - manifest.worker_fleet.execution_lane_workers.sandbox
            - manifest.worker_fleet.execution_lane_workers.child
            - manifest.worker_fleet.execution_lane_workers.smtp;
        manifest.worker_fleet.database_pool_size = workers * 2;
    }
    if manifest.run_id == "replace-at-execution" && !diagnostic {
        anyhow::bail!("OSFO_RUN_ID is required for a confirmation run");
    }
    preflight_process_limits()?;
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .context("OSFO_TEST_DATABASE_URL must identify the Osfo PostgreSQL authority")?;
    let output = std::env::var("OSFO_EVIDENCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| prototype_dir.join("evidence/confirmation-latest"));
    fs::create_dir_all(&output)?;
    fs::write(
        output.join("confirmation-manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;

    let setup_database_url = database_url.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut setup = PostgresLifecycle::connect(&setup_database_url)?;
        setup.reset()?;
        MailpitSmtpSink::local().reset()?;
        Ok(())
    })
    .await??;

    let temporal_address = std::env::var("TEMPORAL_ADDRESS")
        .context("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint")?;
    let fleet_id = format!("{}-temporal-fleet", manifest.run_id);
    let fleet = TemporalWorkerFleet::start(
        &temporal_address,
        TemporalWorkerFleetConfig {
            fleet_id: fleet_id.clone(),
            metrics_address: std::env::var("OSFO_TEMPORAL_METRICS_ADDRESS")
                .unwrap_or_else(|_| "0.0.0.0:9465".into()),
            task_queue: std::env::var("TEMPORAL_TASK_QUEUE")
                .unwrap_or_else(|_| "osfo-agent-run-lifecycle-v1".into()),
            workflow_slots: manifest.worker_fleet.temporal_workflow_slots_per_process,
            activity_slots: manifest.worker_fleet.temporal_activity_slots_per_process,
        },
    )
    .await?;
    let temporal = fleet.workflow_client();
    let runtime = tokio::runtime::Handle::current();
    let registry = MetricsRegistry::default();
    let _metrics = registry
        .serve(&std::env::var("OSFO_METRICS_ADDRESS").unwrap_or_else(|_| "0.0.0.0:9464".into()))?;
    run_blocking(move || preflight_telemetry(telemetry_profile)).await?;
    let selector = WorkloadSelector::new(
        manifest.seed,
        manifest.journey_mix.clone(),
        manifest.principal_mix.clone(),
    );
    let filter = std::env::var("OSFO_STAGE_FILTER")
        .ok()
        .map(|value| value.split(',').map(str::to_owned).collect::<BTreeSet<_>>());
    let failure_matrix = load_failure_evidence()?;
    let mut scenarios = Vec::new();
    for (index, stage) in manifest.stages.iter().enumerate() {
        if filter
            .as_ref()
            .is_some_and(|names| !names.contains(&stage.name))
        {
            continue;
        }
        let duration = if diagnostic {
            std::env::var("OSFO_STAGE_DURATION_OVERRIDE_SECONDS")
                .ok()
                .and_then(|value| value.parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(Duration::from_secs(stage.duration_seconds))
        } else {
            Duration::from_secs(stage.duration_seconds)
        };
        scenarios.push(run_stage(
            &database_url,
            &manifest,
            stage,
            index,
            duration,
            &selector,
            &temporal,
            &runtime,
            &registry,
            &output,
        )?);
        write_partial(&output, &manifest, &scenarios, &failure_matrix, None)?;
    }
    let settle_seconds = std::env::var("OSFO_TEMPORAL_CLOUD_METRICS_SETTLE_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(telemetry_profile.settle_seconds);
    if settle_seconds > 0 {
        tokio::time::sleep(Duration::from_secs(settle_seconds)).await;
    }
    let telemetry_prototype_dir = prototype_dir.clone();
    let telemetry_output = output.clone();
    let telemetry_scenarios = scenarios.clone();
    let telemetry_complete = run_blocking(move || {
        capture_telemetry(
            &telemetry_prototype_dir,
            &telemetry_output,
            &telemetry_scenarios,
            telemetry_profile,
            settle_seconds,
        )
    })
    .await?;
    copy_evidence_configuration(&prototype_dir, &output, telemetry_profile)?;
    let checksum_manifest = write_checksums(&output)?;
    fleet.shutdown().await?;

    let observed_stages = scenarios.iter().map(|stage| stage.name.clone()).collect();
    let traffic_by_stage = scenarios
        .iter()
        .map(|stage| (stage.name.clone(), stage.traffic))
        .collect();
    let target_requirements_met = manifest.steady_target_stages().all(|required| {
        scenarios
            .iter()
            .find(|stage| stage.name == required.name)
            .is_some_and(|stage| {
                stage.traffic.caller_drop == 0
                    && stage.traffic.shed_or_rejected == 0
                    && stage.traffic.failed == 0
                    && stage.traffic.completed == stage.traffic.accepted
            })
    });
    let topology_verified = topology_verified();
    let observations = ConfirmationObservations {
        run_id: manifest.run_id.clone(),
        observed_stages,
        traffic_by_stage,
        failed_invariants: scenarios
            .iter()
            .flat_map(|stage| stage.errors.clone())
            .chain(
                failure_matrix
                    .iter()
                    .filter(|row| !row.passed)
                    .map(|row| format!("failure {}: invariant did not hold", row.injection)),
            )
            .collect(),
        observed_failure_injections: failure_matrix
            .iter()
            .filter(|row| row.passed)
            .map(|row| row.injection.clone())
            .collect(),
        telemetry_complete: Some(telemetry_complete),
        workload_fidelity: Some(!diagnostic),
        safe_overload: scenarios
            .iter()
            .find(|stage| stage.name == "post-knee-probe")
            .map(|stage| stage.traffic.reconcile().is_ok()),
        recovery_complete: scenarios
            .iter()
            .find(|stage| stage.name == "recovery-and-drain")
            .map(|stage| stage.traffic.still_in_flight == 0),
        topology_verified: Some(topology_verified),
        target_requirements_met: Some(target_requirements_met),
        evidence_checksums: Some(checksum_manifest),
    };
    let verdict = ConfirmationVerdict::evaluate(&manifest, &observations);
    write_partial(
        &output,
        &manifest,
        &scenarios,
        &failure_matrix,
        Some(verdict),
    )?;
    write_report_checksums(&output)?;
    println!("evidence={}", output.join("dashboard.html").display());
    Ok(())
}

fn load_failure_evidence() -> Result<Vec<FailureEvidence>> {
    let Ok(paths) = std::env::var("OSFO_FAILURE_EVIDENCE_FILES") else {
        return Ok(Vec::new());
    };
    let mut rows = BTreeMap::new();
    for path in paths.split(',').filter(|path| !path.trim().is_empty()) {
        let bundle: EvidenceBundle = serde_json::from_slice(&fs::read(path.trim())?)?;
        for row in bundle.failure_matrix {
            if rows.insert(row.injection.clone(), row).is_some() {
                anyhow::bail!("duplicate failure evidence row across input bundles");
            }
        }
    }
    Ok(rows.into_values().collect())
}

#[derive(Serialize)]
struct TelemetrySummary {
    profile: String,
    prometheus_url: String,
    range_start_unix_seconds: f64,
    range_end_unix_seconds: f64,
    post_run_settle_seconds: u64,
    required_jobs: Vec<String>,
    healthy_jobs: Vec<String>,
    query_count: usize,
    successful_queries: usize,
    complete: bool,
}

#[derive(Clone, Copy)]
struct TelemetryProfile {
    name: &'static str,
    required_jobs: &'static [&'static str],
    query_file: &'static str,
    prometheus_config: &'static str,
    settle_seconds: u64,
}

fn telemetry_profile() -> TelemetryProfile {
    TelemetryProfile {
        name: "temporal-cloud-openmetrics",
        required_jobs: &[
            "osfo-evidence-runner",
            "osfo-runner-node",
            "osfo-cloud-sql",
            "osfo-cloud-sql-monitoring",
            "temporal-cloud",
            "temporal-rust-sdk-worker",
            "prometheus",
        ],
        query_file: "observability/acceptance-queries.temporal-cloud.tsv",
        prometheus_config: "observability/prometheus.temporal-cloud.yml",
        settle_seconds: 210,
    }
}

fn healthy_target_jobs(targets: &serde_json::Value) -> BTreeSet<String> {
    targets["data"]["activeTargets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|target| target["health"].as_str() == Some("up"))
        .filter_map(|target| target["labels"]["job"].as_str())
        .map(str::to_owned)
        .collect()
}

async fn run_blocking<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation).await?
}

fn preflight_telemetry(profile: TelemetryProfile) -> Result<()> {
    let prometheus =
        std::env::var("OSFO_PROMETHEUS_URL").unwrap_or_else(|_| "http://127.0.0.1:9090".into());
    let timeout = Duration::from_secs(
        std::env::var("OSFO_TELEMETRY_PREFLIGHT_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(90),
    );
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()?;
    let started = Instant::now();
    let mut last_healthy = BTreeSet::new();

    loop {
        let scrape_error = match client.get(format!("{prometheus}/api/v1/targets")).send() {
            Ok(response) => match response.error_for_status() {
                Ok(response) => match response.json::<serde_json::Value>() {
                    Ok(targets) => {
                        last_healthy = healthy_target_jobs(&targets);
                        if profile
                            .required_jobs
                            .iter()
                            .all(|job| last_healthy.contains(*job))
                        {
                            return Ok(());
                        }
                        None
                    }
                    Err(error) => Some(format!("invalid target response: {error}")),
                },
                Err(error) => Some(format!("target endpoint rejected request: {error}")),
            },
            Err(error) => Some(format!("target endpoint unavailable: {error}")),
        };

        if started.elapsed() >= timeout {
            let missing = profile
                .required_jobs
                .iter()
                .filter(|job| !last_healthy.contains(**job))
                .copied()
                .collect::<Vec<_>>();
            anyhow::bail!(
                "telemetry preflight failed after {} seconds; missing or unhealthy jobs: {}; last scrape error: {}",
                timeout.as_secs(),
                missing.join(", "),
                scrape_error.as_deref().unwrap_or("none"),
            );
        }
        thread::sleep(Duration::from_secs(2));
    }
}

fn capture_telemetry(
    prototype_dir: &Path,
    output: &Path,
    scenarios: &[ScenarioEvidence],
    profile: TelemetryProfile,
    settle_seconds: u64,
) -> Result<bool> {
    let prometheus =
        std::env::var("OSFO_PROMETHEUS_URL").unwrap_or_else(|_| "http://127.0.0.1:9090".into());
    let start = scenarios
        .iter()
        .map(|scenario| scenario.started_at_unix_milliseconds)
        .min()
        .context("telemetry export requires an observed stage")? as f64
        / 1_000.0;
    let end = scenarios
        .iter()
        .map(|scenario| scenario.ended_at_unix_milliseconds)
        .max()
        .context("telemetry export requires an observed stage")? as f64
        / 1_000.0;
    let telemetry_dir = output.join("telemetry");
    let query_dir = telemetry_dir.join("queries");
    fs::create_dir_all(&query_dir)?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(60))
        .build()?;

    for endpoint in ["config", "flags", "runtimeinfo", "buildinfo"] {
        let response = client
            .get(format!("{prometheus}/api/v1/status/{endpoint}"))
            .send()?
            .error_for_status()?
            .bytes()?;
        fs::write(
            telemetry_dir.join(format!("prometheus-{endpoint}.json")),
            response,
        )?;
    }
    let targets: serde_json::Value = client
        .get(format!("{prometheus}/api/v1/targets"))
        .send()?
        .error_for_status()?
        .json()?;
    fs::write(
        telemetry_dir.join("prometheus-targets.json"),
        serde_json::to_vec_pretty(&targets)?,
    )?;
    let healthy_jobs = healthy_target_jobs(&targets);

    let query_source = fs::read_to_string(prototype_dir.join(profile.query_file))?;
    let mut query_count = 0;
    let mut successful_queries = 0;
    for line in query_source.lines().filter(|line| !line.trim().is_empty()) {
        let (name, query) = line
            .split_once('\t')
            .with_context(|| format!("invalid acceptance query row: {line}"))?;
        query_count += 1;
        let response: serde_json::Value = client
            .get(format!("{prometheus}/api/v1/query_range"))
            .query(&[
                ("query", query.to_owned()),
                ("start", start.to_string()),
                ("end", end.to_string()),
                ("step", "1s".to_owned()),
            ])
            .send()?
            .error_for_status()?
            .json()?;
        if response["status"].as_str() == Some("success")
            && response["data"]["result"]
                .as_array()
                .is_some_and(|result| !result.is_empty())
        {
            successful_queries += 1;
        }
        fs::write(
            query_dir.join(format!("{name}.json")),
            serde_json::to_vec_pretty(&response)?,
        )?;
    }
    let complete = profile
        .required_jobs
        .iter()
        .all(|job| healthy_jobs.contains(*job))
        && successful_queries == query_count;
    let summary = TelemetrySummary {
        profile: profile.name.to_owned(),
        prometheus_url: prometheus,
        range_start_unix_seconds: start,
        range_end_unix_seconds: end,
        post_run_settle_seconds: settle_seconds,
        required_jobs: profile
            .required_jobs
            .iter()
            .map(|job| (*job).to_owned())
            .collect(),
        healthy_jobs: healthy_jobs.into_iter().collect(),
        query_count,
        successful_queries,
        complete,
    };
    fs::write(
        telemetry_dir.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    Ok(complete)
}

fn copy_evidence_configuration(
    prototype_dir: &Path,
    output: &Path,
    profile: TelemetryProfile,
) -> Result<()> {
    let destination = output.join("configuration");
    fs::create_dir_all(&destination)?;
    for relative in [
        "Cargo.toml",
        "Cargo.lock",
        "README.md",
        "compose.yaml",
        "compose.cloud.yaml",
        "compose.temporal-cloud.yaml",
        "config/issue-13-confirmation.json",
        profile.query_file,
        profile.prometheus_config,
        "observability/grafana/dashboards/agent-run-lifecycle.json",
        "observability/grafana/dashboards/lifecycle-latency-capacity.json",
        "observability/grafana/dashboards/dependencies-saturation.json",
        "observability/grafana/dashboards/failure-recovery.json",
        "observability/grafana/dashboards/temporal-cloud.json",
        "observability/grafana/provisioning/datasources/prometheus.yml",
        "observability/grafana/provisioning/dashboards/dashboards.yml",
    ] {
        let source = prototype_dir.join(relative);
        let name = relative.replace('/', "__");
        fs::copy(source, destination.join(name))?;
    }
    capture_cloud_sql_configuration(&destination)?;
    capture_compute_configuration(&destination)?;
    Ok(())
}

fn cloud_sql_describe_args(instance: &str) -> Vec<String> {
    vec![
        "sql".into(),
        "instances".into(),
        "describe".into(),
        instance.into(),
        "--format=json(databaseVersion,databaseInstalledVersion,region,gceZone,state,settings.tier,settings.edition,settings.availabilityType,settings.dataDiskType,settings.dataDiskSizeGb,settings.dataDiskProvisionedIops,settings.dataDiskProvisionedThroughput,settings.insightsConfig,settings.databaseFlags)".into(),
    ]
}

fn capture_cloud_sql_configuration(destination: &Path) -> Result<()> {
    let Ok(instance) = std::env::var("OSFO_CLOUD_SQL_INSTANCE") else {
        return Ok(());
    };
    let captured = ProcessCommand::new("gcloud")
        .args(cloud_sql_describe_args(&instance))
        .output()
        .context("capture Cloud SQL runtime configuration")?;
    if !captured.status.success() {
        anyhow::bail!("Cloud SQL runtime configuration capture failed");
    }
    let configuration: serde_json::Value = serde_json::from_slice(&captured.stdout)
        .context("parse captured Cloud SQL runtime configuration")?;
    fs::write(
        destination.join("cloud-sql-instance.json"),
        serde_json::to_vec_pretty(&configuration)?,
    )?;
    Ok(())
}

fn compute_runner_describe_args(instance: &str, zone: &str) -> Vec<String> {
    vec![
        "compute".into(),
        "instances".into(),
        "describe".into(),
        instance.into(),
        format!("--zone={zone}"),
        "--format=json(name,zone,machineType,status,cpuPlatform,creationTimestamp,disks.boot,disks.type,disks.diskSizeGb,networkInterfaces.network,networkInterfaces.subnetwork,serviceAccounts.email,serviceAccounts.scopes,scheduling.provisioningModel,scheduling.onHostMaintenance,shieldedInstanceConfig,confidentialInstanceConfig)".into(),
    ]
}

fn compute_project_quota_args() -> Vec<String> {
    vec![
        "compute".into(),
        "project-info".into(),
        "describe".into(),
        "--format=json(quotas)".into(),
    ]
}

fn unavailable_capture(resource: &str, status: std::process::ExitStatus) -> serde_json::Value {
    serde_json::json!({
        "status": "unavailable",
        "resource": resource,
        "command_exit_code": status.code(),
        "reason": "the benchmark runner identity was not authorized to read this control-plane resource",
    })
}

fn capture_compute_configuration(destination: &Path) -> Result<()> {
    if let (Ok(instance), Ok(zone)) = (
        std::env::var("OSFO_RUNNER_INSTANCE"),
        std::env::var("OSFO_RUNNER_ZONE"),
    ) {
        let captured = ProcessCommand::new("gcloud")
            .args(compute_runner_describe_args(&instance, &zone))
            .output()
            .context("capture Compute Engine runner configuration")?;
        if !captured.status.success() {
            anyhow::bail!("Compute Engine runner configuration capture failed");
        }
        let configuration: serde_json::Value = serde_json::from_slice(&captured.stdout)
            .context("parse captured Compute Engine runner configuration")?;
        fs::write(
            destination.join("compute-runner.json"),
            serde_json::to_vec_pretty(&configuration)?,
        )?;
    }
    if std::env::var("GOOGLE_CLOUD_PROJECT").is_ok() {
        let captured = ProcessCommand::new("gcloud")
            .args(compute_project_quota_args())
            .output()
            .context("capture Compute Engine project quotas")?;
        if !captured.status.success() {
            fs::write(
                destination.join("compute-project-quotas-unavailable.json"),
                serde_json::to_vec_pretty(&unavailable_capture(
                    "compute-project-quotas",
                    captured.status,
                ))?,
            )?;
            return Ok(());
        }
        let configuration: serde_json::Value = serde_json::from_slice(&captured.stdout)
            .context("parse captured Compute Engine project quotas")?;
        fs::write(
            destination.join("compute-project-quotas.json"),
            serde_json::to_vec_pretty(&configuration)?,
        )?;
    }
    Ok(())
}

fn write_checksums(output: &Path) -> Result<String> {
    let mut files = Vec::new();
    collect_checksum_files(output, output, &mut files)?;
    files.sort();
    let mut manifest = String::new();
    for relative in files {
        let bytes = fs::read(output.join(&relative))?;
        manifest.push_str(&format!(
            "{:x}  {}\n",
            Sha256::digest(&bytes),
            relative.display()
        ));
    }
    let name = "SHA256SUMS";
    fs::write(output.join(name), manifest)?;
    Ok(name.into())
}

fn write_report_checksums(output: &Path) -> Result<()> {
    let mut manifest = String::new();
    for name in ["SHA256SUMS", "results.json", "dashboard.html"] {
        let bytes = fs::read(output.join(name))?;
        manifest.push_str(&format!("{:x}  {name}\n", Sha256::digest(&bytes)));
    }
    fs::write(output.join("REPORT_SHA256SUMS"), manifest)?;
    Ok(())
}

fn collect_checksum_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_checksum_files(root, &path, files)?;
            continue;
        }
        let relative = path.strip_prefix(root)?.to_path_buf();
        if is_checksum_input(&relative) {
            files.push(relative);
        }
    }
    Ok(())
}

fn is_checksum_input(relative: &Path) -> bool {
    !matches!(
        relative.to_str(),
        Some("SHA256SUMS" | "REPORT_SHA256SUMS" | "results.json" | "dashboard.html" | "run.log")
    )
}

#[allow(clippy::too_many_arguments)]
fn run_stage(
    database_url: &str,
    manifest: &ConfirmationManifest,
    stage: &ConfirmationStage,
    index: usize,
    duration: Duration,
    selector: &WorkloadSelector,
    temporal: &TemporalWorkflowClient,
    runtime: &tokio::runtime::Handle,
    registry: &MetricsRegistry,
    output: &Path,
) -> Result<ScenarioEvidence> {
    let schedule = StageSchedule::for_stage(
        stage,
        Duration::from_millis(manifest.worker_fleet.maximum_arrival_lag_milliseconds),
        duration,
    )?;
    let started_at_unix_milliseconds =
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    annotate_stage(
        &manifest.run_id,
        &stage.name,
        "start",
        started_at_unix_milliseconds,
    )?;
    let started = Instant::now();
    let counters = Arc::new(StageCounters::default());
    let errors = Arc::new(Mutex::new(Vec::new()));
    let latency_file = format!("latencies-{index:02}.csv");
    let latency = Arc::new(LatencyRecorder::create(output.join(&latency_file))?);
    let admission_done = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));
    let temporal_in_flight = Arc::new(AtomicU64::new(0));
    let capacity = manifest.worker_fleet.maximum_admission_queue_depth;
    let noisy_capacity = capacity * usize::from(manifest.principal_mix.noisy_percent) / 100;
    let quiet_capacity = capacity.saturating_sub(noisy_capacity).max(1);
    let (noisy_sender, noisy_receiver) = sync_channel(noisy_capacity.max(1));
    let (quiet_sender, quiet_receiver) = sync_channel(quiet_capacity);
    let noisy_receiver = Arc::new(Mutex::new(noisy_receiver));
    let quiet_receiver = Arc::new(Mutex::new(quiet_receiver));
    let (temporal_sender, temporal_receiver) = sync_channel(capacity);
    let temporal_receiver = Arc::new(Mutex::new(temporal_receiver));
    let temporal_dispatchers = spawn_temporal_dispatchers(
        database_url,
        manifest.worker_fleet.temporal_gateway_concurrency,
        temporal_receiver,
        temporal.clone(),
        runtime.clone(),
        counters.clone(),
        latency.clone(),
        errors.clone(),
        temporal_in_flight.clone(),
    );
    let admission_workers = manifest.worker_fleet.admission_workers;
    let noisy_workers = admission_workers * usize::from(manifest.principal_mix.noisy_percent) / 100;
    let mut admission_handles = Vec::new();
    for worker in 0..admission_workers {
        admission_handles.push(spawn_admission_worker(
            database_url,
            manifest.run_id.clone(),
            stage.clone(),
            worker,
            if worker < noisy_workers {
                noisy_receiver.clone()
            } else {
                quiet_receiver.clone()
            },
            counters.clone(),
            latency.clone(),
            errors.clone(),
        ));
    }
    let mut execution_handles = Vec::new();
    let lane_workers = &manifest.worker_fleet.execution_lane_workers;
    let lanes = [
        (lane_workers.basic, vec![JourneyKind::BasicAgentRun]),
        (lane_workers.child, vec![JourneyKind::ChildFanout]),
        (
            lane_workers.temporal,
            vec![
                JourneyKind::AwaitedWorkflow,
                JourneyKind::DetachedWorkflow,
                JourneyKind::FullReferenceJourney,
            ],
        ),
        (lane_workers.sandbox, vec![JourneyKind::SandboxArtifact]),
        (lane_workers.smtp, vec![JourneyKind::ApprovalSmtp]),
    ];
    let mut worker = 0;
    for (count, journey_kinds) in lanes {
        for _ in 0..count {
            execution_handles.push(spawn_execution_worker(
                database_url,
                worker,
                journey_kinds.clone(),
                stage.clone(),
                manifest.run_id.clone(),
                schedule,
                started,
                temporal_sender.clone(),
                temporal_in_flight.clone(),
                counters.clone(),
                latency.clone(),
                errors.clone(),
                admission_done.clone(),
                stop.clone(),
            ));
            worker += 1;
        }
    }
    let sampling = Arc::new(AtomicBool::new(true));
    let samples = Arc::new(Mutex::new(Vec::new()));
    let sampler = spawn_sampler(
        database_url,
        stage.name.clone(),
        started,
        counters.clone(),
        latency.clone(),
        samples.clone(),
        registry.clone(),
        sampling.clone(),
    );

    offer_stage(
        stage,
        schedule,
        started,
        selector,
        &noisy_sender,
        &quiet_sender,
        &counters,
        capacity,
    );
    drop(noisy_sender);
    drop(quiet_sender);
    for handle in admission_handles {
        handle
            .join()
            .map_err(|_| anyhow::anyhow!("admission worker panicked"))??;
    }
    admission_done.store(true, Ordering::Relaxed);
    let dispatch_ended = Instant::now();
    let drain_limit = Duration::from_secs(
        std::env::var("OSFO_MAX_DRAIN_SECONDS")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(1_800),
    );
    while terminal_count(&counters) < counters.accepted.load(Ordering::Relaxed)
        || temporal_in_flight.load(Ordering::Relaxed) > 0
    {
        if dispatch_ended.elapsed() >= drain_limit {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
    stop.store(true, Ordering::Relaxed);
    for handle in execution_handles {
        handle
            .join()
            .map_err(|_| anyhow::anyhow!("execution worker panicked"))??;
    }
    drop(temporal_sender);
    for handle in temporal_dispatchers {
        handle
            .join()
            .map_err(|_| anyhow::anyhow!("Temporal dispatcher panicked"))??;
    }
    sampling.store(false, Ordering::Relaxed);
    sampler
        .join()
        .map_err(|_| anyhow::anyhow!("sampler panicked"))??;
    let latency = Arc::try_unwrap(latency)
        .map_err(|_| anyhow::anyhow!("latency recorder still has live users"))?
        .finish()?;
    let offered = counters.offered.load(Ordering::Relaxed);
    let received = counters.received.load(Ordering::Relaxed);
    let caller_drop = counters.caller_drop.load(Ordering::Relaxed);
    let accepted = counters.accepted.load(Ordering::Relaxed);
    let shed_or_rejected = counters.shed_or_rejected.load(Ordering::Relaxed);
    let completed = counters.completed.load(Ordering::Relaxed);
    let failed = counters.failed.load(Ordering::Relaxed);
    let canceled = counters.canceled.load(Ordering::Relaxed);
    let traffic = TrafficAccounting {
        offered,
        received,
        caller_drop,
        accepted,
        shed_or_rejected,
        completed,
        failed,
        canceled,
        still_in_flight: accepted.saturating_sub(completed + failed + canceled),
    };
    let ended_at_unix_milliseconds =
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    annotate_stage(
        &manifest.run_id,
        &stage.name,
        "end",
        ended_at_unix_milliseconds,
    )?;
    Ok(ScenarioEvidence {
        name: stage.name.clone(),
        started_at_unix_milliseconds,
        ended_at_unix_milliseconds,
        workload: "production-shaped deterministic mixed lifecycle".into(),
        persistence_profile: stage.persistence_profile.clone(),
        offered,
        accepted,
        completed,
        shed: shed_or_rejected,
        traffic,
        errors: errors.lock().map(|value| value.clone()).unwrap_or_default(),
        elapsed_seconds: started.elapsed().as_secs_f64(),
        drain_seconds: dispatch_ended.elapsed().as_secs_f64(),
        offered_per_second: offered as f64 / duration.as_secs_f64(),
        completed_per_second: completed as f64 / started.elapsed().as_secs_f64(),
        metrics: latency.summaries,
        samples: samples
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default(),
        raw_latency_file: Some(latency_file),
        raw_latency_sha256: Some(latency.sha256),
        raw_latency_rows: latency.row_count,
    })
}

fn annotate_stage(run_id: &str, stage: &str, event: &str, at_milliseconds: u64) -> Result<()> {
    let grafana =
        std::env::var("OSFO_GRAFANA_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".into());
    let payload = serde_json::json!({
        "time": at_milliseconds,
        "tags": ["osfo-issue-13", run_id, stage, event],
        "text": format!("{run_id} {stage} {event}")
    });
    let mut child = ProcessCommand::new("curl")
        .args([
            "--fail",
            "--silent",
            "--show-error",
            "--request",
            "POST",
            "--header",
            "Content-Type: application/json",
            "--data-binary",
            "@-",
            &format!("{grafana}/api/annotations"),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()?;
    use std::io::Write;
    child
        .stdin
        .take()
        .context("Grafana annotation stdin unavailable")?
        .write_all(serde_json::to_string(&payload)?.as_bytes())?;
    let status = child.wait()?;
    if !status.success() {
        if std::env::var("OSFO_DIAGNOSTIC_MODE").as_deref() == Ok("1") {
            return Ok(());
        }
        anyhow::bail!("Grafana stage annotation failed");
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn spawn_admission_worker(
    database_url: &str,
    run_id: String,
    stage: ConfirmationStage,
    _worker: usize,
    receiver: Arc<Mutex<Receiver<ScheduledOffer>>>,
    counters: Arc<StageCounters>,
    latency: Arc<LatencyRecorder>,
    errors: Arc<Mutex<Vec<String>>>,
) -> thread::JoinHandle<Result<()>> {
    let database_url = database_url.to_owned();
    thread::spawn(move || {
        let mut lifecycle = PostgresLifecycle::connect(&database_url)?;
        loop {
            let offer = receiver
                .lock()
                .map_err(|_| anyhow::anyhow!("admission receiver poisoned"))?
                .recv();
            let Ok(offer) = offer else { break };
            let key = format!("{run_id}-{}-{}", stage.name, offer.ordinal);
            let principal = offer.principal.clone();
            let queue_delay = offer.intended_at.elapsed();
            let admission_started = Instant::now();
            let admission = lifecycle.admit_workload(WorkloadAdmission::new(
                key,
                principal.clone(),
                offer.journey,
                stage.persistence_profile.clone(),
                offer.ordinal as u64,
            ));
            let admission_commit = admission_started.elapsed();
            let mut samples = vec![
                LatencySample::from_duration("admission_queue_delay", queue_delay),
                LatencySample::from_duration("admission", admission_commit),
                LatencySample::from_duration("admission_commit", admission_commit),
            ];
            match admission {
                Ok(_) => {
                    counters.accepted.fetch_add(1, Ordering::Relaxed);
                    if offer.ordinal % 100 == 0 {
                        let replay_started = Instant::now();
                        let replay_key = format!("{run_id}-{}-{}", stage.name, offer.ordinal);
                        let replay = lifecycle.admit_workload(WorkloadAdmission::new(
                            replay_key,
                            principal,
                            offer.journey,
                            stage.persistence_profile.clone(),
                            offer.ordinal as u64,
                        ))?;
                        if !replay.idempotent_replay {
                            anyhow::bail!("idempotency retry created new accepted work");
                        }
                        samples.push(LatencySample::from_duration(
                            "idempotency_resolution",
                            replay_started.elapsed(),
                        ));
                    }
                    latency.record_batch(&stage.name, offer.ordinal, "accepted", &samples)?;
                }
                Err(error) => {
                    counters.shed_or_rejected.fetch_add(1, Ordering::Relaxed);
                    counters.errors.fetch_add(1, Ordering::Relaxed);
                    push_error(&errors, format!("admission {}: {error:#}", offer.ordinal));
                    latency.record_batch(&stage.name, offer.ordinal, "rejected", &samples)?;
                }
            }
        }
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
fn spawn_temporal_dispatchers(
    database_url: &str,
    dispatcher_count: usize,
    receiver: Arc<Mutex<Receiver<TemporalDispatch>>>,
    temporal: TemporalWorkflowClient,
    runtime: tokio::runtime::Handle,
    counters: Arc<StageCounters>,
    latency: Arc<LatencyRecorder>,
    errors: Arc<Mutex<Vec<String>>>,
    in_flight: Arc<AtomicU64>,
) -> Vec<thread::JoinHandle<Result<()>>> {
    (0..dispatcher_count)
        .map(|dispatcher| {
            let database_url = database_url.to_owned();
            let receiver = receiver.clone();
            let temporal = temporal.clone();
            let runtime = runtime.clone();
            let counters = counters.clone();
            let latency = latency.clone();
            let errors = errors.clone();
            let in_flight = in_flight.clone();
            thread::spawn(move || {
                loop {
                    let dispatch = receiver
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Temporal dispatch receiver poisoned"))?
                        .recv();
                    let Ok(dispatch) = dispatch else { break };
                    let _in_flight_guard = InFlightGuard::new(in_flight.clone());
                    let workflow_started = Instant::now();
                    let report = runtime.block_on(temporal.run_load_named(
                        dispatch.workflow_id.clone(),
                    ));
                    let mut samples = vec![LatencySample::from_duration(
                        "temporal_workflow_service",
                        workflow_started.elapsed(),
                    )];
                    let outcome = match report {
                        Ok(report) => {
                            let delivery_started = Instant::now();
                            let workflow_instance_id = dispatch.workflow_id.clone();
                            let delivery_id = format!("delivery-{}", dispatch.workflow_id);
                            let serialized_outcome = serde_json::to_string(&report.steps)?;
                            let mut delivery_attempts = 0_u64;
                            let delivered = retry_with_backoff(
                                3,
                                Duration::from_millis(100),
                                || {
                                    delivery_attempts += 1;
                                    let mut lifecycle =
                                        PostgresLifecycle::connect(&database_url)?;
                                    lifecycle.execute(Command::DeliverWorkflowOutcome {
                                        workflow_instance_id: workflow_instance_id.clone(),
                                        delivery_id: delivery_id.clone(),
                                        outcome: serialized_outcome.clone(),
                                    })
                                },
                            );
                            counters.temporal_delivery_retries.fetch_add(
                                delivery_attempts.saturating_sub(1),
                                Ordering::Relaxed,
                            );
                            samples.push(LatencySample::from_duration(
                                "workflow_outcome_delivery_and_wake",
                                delivery_started.elapsed(),
                            ));
                            match delivered {
                                Ok(_) => "temporal-completed",
                                Err(error) => {
                                    counters.errors.fetch_add(1, Ordering::Relaxed);
                                    push_error(
                                        &errors,
                                        format!(
                                            "Temporal dispatcher {dispatcher} delivery {}: {error:#}",
                                            dispatch.ordinal
                                        ),
                                    );
                                    if retry_with_backoff(
                                        3,
                                        Duration::from_millis(100),
                                        || {
                                            let mut lifecycle =
                                                PostgresLifecycle::connect(&database_url)?;
                                            lifecycle.cancel_run(
                                                &dispatch.run_id,
                                                "temporal-delivery-failed",
                                            )
                                        },
                                    )
                                    .is_ok()
                                    {
                                        counters.failed.fetch_add(1, Ordering::Relaxed);
                                    }
                                    "temporal-delivery-failed"
                                }
                            }
                        }
                        Err(error) => {
                            counters.errors.fetch_add(1, Ordering::Relaxed);
                            push_error(
                                &errors,
                                format!(
                                    "Temporal dispatcher {dispatcher} workflow {}: {error:#}",
                                    dispatch.ordinal
                                ),
                            );
                            if retry_with_backoff(3, Duration::from_millis(100), || {
                                let mut lifecycle = PostgresLifecycle::connect(&database_url)?;
                                lifecycle.cancel_run(&dispatch.run_id, "temporal-dispatch-failed")
                            })
                            .is_ok()
                            {
                                counters.failed.fetch_add(1, Ordering::Relaxed);
                            }
                            "temporal-failed"
                        }
                    };
                    latency.record_batch(
                        &dispatch.stage,
                        dispatch.ordinal as usize,
                        outcome,
                        &samples,
                    )?;
                }
                Ok(())
            })
        })
        .collect()
}

fn enqueue_awaited_workflow(
    lifecycle: &mut PostgresLifecycle,
    claimed: &osfo_agent_run_lifecycle_prototype::workload::ClaimedWorkload,
    stage: &str,
    benchmark_run_id: &str,
    sender: &SyncSender<TemporalDispatch>,
    in_flight: &AtomicU64,
) -> Result<Vec<LatencySample>> {
    let workflow_id = load_workflow_id(benchmark_run_id, &claimed.run_id);
    let started = Instant::now();
    lifecycle.execute(Command::StartAwaitedWorkflow {
        parent_run_id: claimed.run_id.clone(),
        parent_claim_epoch: claimed.claim_epoch,
        tool_call_id: format!("workflow-tool-{}", claimed.run_id.as_str()),
        workflow_instance_id: workflow_id.clone(),
    })?;
    let samples = vec![LatencySample::from_duration(
        "workflow_start_intent_commit",
        started.elapsed(),
    )];
    send_temporal_dispatch(
        sender,
        in_flight,
        TemporalDispatch {
            run_id: claimed.run_id.clone(),
            workflow_id,
            ordinal: claimed.ordinal,
            stage: stage.to_owned(),
        },
    )?;
    Ok(samples)
}

fn enqueue_detached_workflow(
    lifecycle: &mut PostgresLifecycle,
    claimed: &osfo_agent_run_lifecycle_prototype::workload::ClaimedWorkload,
    stage: &str,
    benchmark_run_id: &str,
    sender: &SyncSender<TemporalDispatch>,
    in_flight: &AtomicU64,
) -> Result<Vec<LatencySample>> {
    let workflow_id = load_workflow_id(benchmark_run_id, &claimed.run_id);
    let intent_started = Instant::now();
    lifecycle.start_detached_workflow(
        &claimed.run_id,
        claimed.claim_epoch,
        &format!("workflow-tool-{}", claimed.run_id.as_str()),
        &workflow_id,
    )?;
    let mut samples = vec![LatencySample::from_duration(
        "workflow_start_intent_commit",
        intent_started.elapsed(),
    )];
    send_temporal_dispatch(
        sender,
        in_flight,
        TemporalDispatch {
            run_id: claimed.run_id.clone(),
            workflow_id,
            ordinal: claimed.ordinal,
            stage: stage.to_owned(),
        },
    )?;
    let terminal_started = Instant::now();
    lifecycle.complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Succeeded)?;
    samples.push(LatencySample::from_duration(
        "terminal_commit",
        terminal_started.elapsed(),
    ));
    Ok(samples)
}

fn send_temporal_dispatch(
    sender: &SyncSender<TemporalDispatch>,
    in_flight: &AtomicU64,
    dispatch: TemporalDispatch,
) -> Result<()> {
    in_flight.fetch_add(1, Ordering::Relaxed);
    if sender.send(dispatch).is_err() {
        in_flight.fetch_sub(1, Ordering::Relaxed);
        anyhow::bail!("Temporal dispatch queue is unavailable");
    }
    Ok(())
}

fn load_workflow_id(
    benchmark_run_id: &str,
    run_id: &osfo_agent_run_lifecycle_prototype::RunId,
) -> String {
    format!("workflow-{benchmark_run_id}-{}", run_id.as_str())
}

#[allow(clippy::too_many_arguments)]
fn spawn_execution_worker(
    database_url: &str,
    worker: usize,
    journey_kinds: Vec<JourneyKind>,
    stage: ConfirmationStage,
    benchmark_run_id: String,
    schedule: StageSchedule,
    stage_started: Instant,
    temporal_sender: SyncSender<TemporalDispatch>,
    temporal_in_flight: Arc<AtomicU64>,
    counters: Arc<StageCounters>,
    latency: Arc<LatencyRecorder>,
    errors: Arc<Mutex<Vec<String>>>,
    admission_done: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<Result<()>> {
    let database_url = database_url.to_owned();
    thread::spawn(move || {
        let mut lifecycle = PostgresLifecycle::connect(&database_url)?;
        while !stop.load(Ordering::Relaxed) {
            let Some(claimed) = lifecycle.claim_next_workload_for(
                &format!("production-worker-{worker}"),
                Duration::from_secs(30),
                &journey_kinds,
            )?
            else {
                if admission_done.load(Ordering::Relaxed)
                    && terminal_count(&counters) >= counters.accepted.load(Ordering::Relaxed)
                {
                    break;
                }
                thread::sleep(Duration::from_millis(2));
                continue;
            };
            let records = if matches!(
                claimed.journey_kind,
                JourneyKind::BasicAgentRun
                    | JourneyKind::DetachedWorkflow
                    | JourneyKind::SandboxArtifact
            ) {
                Vec::new()
            } else {
                lifecycle.semantic_sequence(&claimed.run_id)?
            };
            let has = |prefix: &str| records.iter().any(|record| record.starts_with(prefix));
            let result: Result<(Vec<LatencySample>, bool)> = match claimed.journey_kind {
                JourneyKind::BasicAgentRun => execute_database_journey(&mut lifecycle, &claimed)
                    .map(|samples| (samples, true)),
                JourneyKind::ChildFanout => {
                    if has("ChildJoinSettled:") {
                        complete_child_journey(&mut lifecycle, &claimed)
                            .map(|samples| (samples, true))
                    } else {
                        open_and_settle_child_join(&mut lifecycle, &claimed)
                            .map(|samples| (samples, false))
                    }
                }
                JourneyKind::AwaitedWorkflow => {
                    if has("WorkflowOutcome:") {
                        complete_after_awaited_workflow(&mut lifecycle, &claimed)
                            .map(|samples| (samples, true))
                    } else {
                        enqueue_awaited_workflow(
                            &mut lifecycle,
                            &claimed,
                            &stage.name,
                            &benchmark_run_id,
                            &temporal_sender,
                            &temporal_in_flight,
                        )
                        .map(|samples| (samples, false))
                    }
                }
                JourneyKind::FullReferenceJourney => {
                    if !has("ChildJoinSettled:") {
                        open_and_settle_child_join(&mut lifecycle, &claimed)
                            .map(|samples| (samples, false))
                    } else if !has("WorkflowOutcome:") {
                        let mut samples = consume_child_outcomes(&mut lifecycle, &claimed)?;
                        samples.extend(enqueue_awaited_workflow(
                            &mut lifecycle,
                            &claimed,
                            &stage.name,
                            &benchmark_run_id,
                            &temporal_sender,
                            &temporal_in_flight,
                        )?);
                        Ok((samples, false))
                    } else {
                        complete_after_awaited_workflow(&mut lifecycle, &claimed)
                            .map(|samples| (samples, true))
                    }
                }
                JourneyKind::DetachedWorkflow => enqueue_detached_workflow(
                    &mut lifecycle,
                    &claimed,
                    &stage.name,
                    &benchmark_run_id,
                    &temporal_sender,
                    &temporal_in_flight,
                )
                .map(|samples| (samples, true)),
                JourneyKind::ApprovalSmtp => {
                    let mut approvals = PostgresApprovalLedger::connect(&database_url)?;
                    if has("ApprovalSettled:") {
                        let mut smtp = MailpitSmtpSink::local();
                        execute_approved_email(&mut lifecycle, &mut approvals, &mut smtp, &claimed)
                            .map(|samples| (samples, true))
                    } else {
                        open_and_approve_email(&mut approvals, &claimed)
                            .map(|samples| (samples, false))
                    }
                }
                JourneyKind::SandboxArtifact => {
                    let mut sandbox = DockerSandboxProvider::new();
                    let mut artifacts = artifact_store();
                    let image = std::env::var("OSFO_SANDBOX_IMAGE").unwrap_or_else(|_| {
                        "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1".into()
                    });
                    execute_sandbox_artifact_journey(
                        &mut lifecycle,
                        &mut sandbox,
                        artifacts.as_mut(),
                        &claimed,
                        &image,
                    )
                    .map(|samples| (samples, true))
                }
                JourneyKind::MeasuredAgentDecision => Err(anyhow::anyhow!(
                    "measured AgentDecision replay belongs to the deployed ingress lane"
                )),
            };
            let (mut samples, terminal, outcome) = match result {
                Ok((samples, terminal)) => {
                    if terminal {
                        counters.completed.fetch_add(1, Ordering::Relaxed);
                    }
                    (
                        samples,
                        terminal,
                        if terminal { "completed" } else { "yielded" },
                    )
                }
                Err(error) => {
                    counters.errors.fetch_add(1, Ordering::Relaxed);
                    push_error(&errors, format!("execution {}: {error:#}", claimed.ordinal));
                    if lifecycle
                        .complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Failed)
                        .is_ok()
                    {
                        counters.failed.fetch_add(1, Ordering::Relaxed);
                    }
                    (Vec::new(), true, "failed")
                }
            };
            if terminal {
                let end_to_end =
                    (stage_started + schedule.target_offset(claimed.ordinal as usize)).elapsed();
                samples.push(LatencySample::from_duration(
                    "end_to_end_journey",
                    end_to_end,
                ));
                samples.push(LatencySample::from_duration(
                    format!("end_to_end_journey_{outcome}"),
                    end_to_end,
                ));
            }
            latency.record_batch(&stage.name, claimed.ordinal as usize, outcome, &samples)?;
        }
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
fn offer_stage(
    stage: &ConfirmationStage,
    schedule: StageSchedule,
    started: Instant,
    selector: &WorkloadSelector,
    noisy_sender: &SyncSender<ScheduledOffer>,
    quiet_sender: &SyncSender<ScheduledOffer>,
    counters: &StageCounters,
    capacity: usize,
) {
    for ordinal in 0..schedule.offered_count() {
        let target = started + schedule.target_offset(ordinal);
        if let Some(wait) = target.checked_duration_since(Instant::now()) {
            thread::sleep(wait);
        }
        counters.offered.fetch_add(1, Ordering::Relaxed);
        if matches!(
            schedule.classify(ordinal, started.elapsed()),
            ArrivalDisposition::CallerDrop { .. }
        ) {
            counters.caller_drop.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        counters.received.fetch_add(1, Ordering::Relaxed);
        let in_flight = counters
            .accepted
            .load(Ordering::Relaxed)
            .saturating_sub(terminal_count(counters));
        if in_flight >= capacity as u64 {
            counters.shed_or_rejected.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        let principal = selector.principal(ordinal);
        let journey = journey_for_stage(stage.phase, selector, ordinal);
        let offer = ScheduledOffer {
            ordinal,
            intended_at: target,
            principal: principal.clone(),
            journey,
        };
        let sent = if principal == "noisy" {
            noisy_sender.try_send(offer)
        } else {
            quiet_sender.try_send(offer)
        };
        if matches!(
            sent,
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_))
        ) {
            counters.shed_or_rejected.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn journey_for_stage(
    phase: StagePhase,
    selector: &WorkloadSelector,
    ordinal: usize,
) -> JourneyKind {
    match phase {
        StagePhase::ChildFanout => JourneyKind::ChildFanout,
        StagePhase::ApprovalBatch => JourneyKind::ApprovalSmtp,
        StagePhase::TimerHerd | StagePhase::RetryStorm => JourneyKind::AwaitedWorkflow,
        _ => selector.journey(ordinal),
    }
}

fn artifact_store() -> Box<dyn ArtifactStore> {
    if let Ok(bucket) = std::env::var("OSFO_ARTIFACT_BUCKET") {
        Box::new(GcsArtifactStore::new(bucket))
    } else {
        Box::new(MinioArtifactStore::new(
            std::env::var("MINIO_CLIENT_CONTAINER")
                .unwrap_or_else(|_| "osfo-lifecycle-artifact-client".into()),
            std::env::var("MINIO_BUCKET").unwrap_or_else(|_| "osfo-lifecycle-local".into()),
        ))
    }
}

fn terminal_count(counters: &StageCounters) -> u64 {
    counters.completed.load(Ordering::Relaxed)
        + counters.failed.load(Ordering::Relaxed)
        + counters.canceled.load(Ordering::Relaxed)
}

fn push_error(errors: &Mutex<Vec<String>>, error: String) {
    if let Ok(mut errors) = errors.lock()
        && errors.len() < 100
    {
        errors.push(error);
    }
}

#[derive(Default)]
struct DatabaseSnapshot {
    pending: i64,
    running: i64,
    waiting: i64,
    connections: i64,
    lock_waiters: i64,
}

#[allow(clippy::too_many_arguments)]
fn spawn_sampler(
    database_url: &str,
    stage: String,
    started: Instant,
    counters: Arc<StageCounters>,
    latency: Arc<LatencyRecorder>,
    samples: Arc<Mutex<Vec<TimeSample>>>,
    registry: MetricsRegistry,
    sampling: Arc<AtomicBool>,
) -> thread::JoinHandle<Result<()>> {
    let database_url = database_url.to_owned();
    thread::spawn(move || {
        let mut client = Client::connect(&database_url, NoTls)?;
        loop {
            let row = client.query_one(
                "SELECT count(*) FILTER (WHERE state IN ('pending','retry_ready')),
                        count(*) FILTER (WHERE state = 'running'),
                        count(*) FILTER (WHERE state = 'waiting')
                 FROM agent_run_lifecycle.agent_runs",
                &[],
            )?;
            let activity = client.query_one(
                "SELECT count(*), count(*) FILTER (WHERE wait_event_type = 'Lock')
                 FROM pg_stat_activity WHERE datname = current_database()",
                &[],
            )?;
            let database = DatabaseSnapshot {
                pending: row.get(0),
                running: row.get(1),
                waiting: row.get(2),
                connections: activity.get(0),
                lock_waiters: activity.get(1),
            };
            let snapshot = MetricsSnapshot {
                stage: stage.clone(),
                offered: counters.offered.load(Ordering::Relaxed),
                received: counters.received.load(Ordering::Relaxed),
                caller_drop: counters.caller_drop.load(Ordering::Relaxed),
                accepted: counters.accepted.load(Ordering::Relaxed),
                completed: counters.completed.load(Ordering::Relaxed),
                failed: counters.failed.load(Ordering::Relaxed),
                shed_or_rejected: counters.shed_or_rejected.load(Ordering::Relaxed),
                temporal_delivery_retries: counters
                    .temporal_delivery_retries
                    .load(Ordering::Relaxed),
                errors: counters.errors.load(Ordering::Relaxed),
                pending: database.pending,
                running: database.running,
                waiting: database.waiting,
                database_connections: database.connections,
                lock_waiters: database.lock_waiters,
                end_to_end_latencies: BTreeMap::from([
                    (
                        "all".into(),
                        latency.prometheus_histogram("end_to_end_journey"),
                    ),
                    (
                        "completed".into(),
                        latency.prometheus_histogram("end_to_end_journey_completed"),
                    ),
                    (
                        "failed".into(),
                        latency.prometheus_histogram("end_to_end_journey_failed"),
                    ),
                ]),
            };
            registry.replace(snapshot);
            if let Ok(mut values) = samples.lock() {
                values.push(TimeSample {
                    elapsed_seconds: started.elapsed().as_secs_f64(),
                    offered: counters.offered.load(Ordering::Relaxed),
                    received: counters.received.load(Ordering::Relaxed),
                    caller_drop: counters.caller_drop.load(Ordering::Relaxed),
                    accepted: counters.accepted.load(Ordering::Relaxed),
                    shed_or_rejected: counters.shed_or_rejected.load(Ordering::Relaxed),
                    completed: counters.completed.load(Ordering::Relaxed),
                    failed: counters.failed.load(Ordering::Relaxed),
                    errors: counters.errors.load(Ordering::Relaxed),
                    pending: database.pending,
                    running: database.running,
                    waiting: database.waiting,
                    database_connections: database.connections,
                    lock_waiters: database.lock_waiters,
                });
            }
            if !sampling.load(Ordering::Relaxed) {
                break;
            }
            thread::sleep(Duration::from_secs(1));
        }
        Ok(())
    })
}

fn topology_verified() -> bool {
    let database = std::env::var("OSFO_DATABASE_PROFILE").unwrap_or_default();
    let compute_region = std::env::var("OSFO_COMPUTE_REGION").ok();
    let database_region = std::env::var("OSFO_CLOUD_SQL_REGION").ok();
    topology_matches(
        &database,
        compute_region.as_deref(),
        database_region.as_deref(),
    )
}

fn topology_matches(
    database_profile: &str,
    compute_region: Option<&str>,
    database_region: Option<&str>,
) -> bool {
    let normalized_profile = database_profile
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    normalized_profile.contains("cloudsql")
        && compute_region.is_some()
        && compute_region == database_region
}

fn parse_soft_nofile_limit(source: &str) -> Option<u64> {
    source.lines().find_map(|line| {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.starts_with(&["Max", "open", "files"]) {
            columns.get(3)?.parse().ok()
        } else {
            None
        }
    })
}

fn preflight_process_limits() -> Result<()> {
    let required = std::env::var("OSFO_MIN_NOFILE")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4_096);
    let limits = fs::read_to_string("/proc/self/limits")
        .context("read Linux process limits for benchmark preflight")?;
    let observed =
        parse_soft_nofile_limit(&limits).context("parse the soft Max open files process limit")?;
    if observed < required {
        anyhow::bail!(
            "process file-descriptor preflight failed: soft nofile limit {observed} is below required {required}; raise it before starting load"
        );
    }
    Ok(())
}

fn write_partial(
    output: &Path,
    manifest: &ConfirmationManifest,
    scenarios: &[ScenarioEvidence],
    failure_matrix: &[FailureEvidence],
    verdict: Option<ConfirmationVerdict>,
) -> Result<()> {
    let bundle = EvidenceBundle {
        schema_version: 3,
        generated_at: format!(
            "unix:{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
        ),
        question: manifest.question.clone(),
        environment: BTreeMap::from([
            ("run-id".into(), manifest.run_id.clone()),
            ("database-profile".into(), std::env::var("OSFO_DATABASE_PROFILE").unwrap_or_else(|_| "local diagnostic".into())),
            ("compute-region".into(), std::env::var("OSFO_COMPUTE_REGION").unwrap_or_else(|_| "local".into())),
            ("runner-zone".into(), std::env::var("OSFO_RUNNER_ZONE").unwrap_or_else(|_| "local".into())),
            ("runner-machine-type".into(), std::env::var("OSFO_RUNNER_MACHINE_TYPE").unwrap_or_else(|_| "local".into())),
            ("cloud-sql-region".into(), std::env::var("OSFO_CLOUD_SQL_REGION").unwrap_or_else(|_| "local".into())),
            ("cloud-sql-tier".into(), std::env::var("OSFO_CLOUD_SQL_TIER").unwrap_or_else(|_| "local".into())),
            ("cloud-sql-version".into(), std::env::var("OSFO_CLOUD_SQL_VERSION").unwrap_or_else(|_| "PostgreSQL 17".into())),
            ("temporal-service".into(), "Temporal Cloud managed".into()),
            ("temporal-deployment".into(), "temporal-cloud-on-demand".into()),
            ("temporal-region".into(), std::env::var("OSFO_TEMPORAL_CLOUD_REGION").unwrap_or_else(|_| "local".into())),
            ("temporal-capacity-mode".into(), std::env::var("OSFO_TEMPORAL_CLOUD_CAPACITY_MODE").unwrap_or_else(|_| "not-applicable".into())),
            ("temporal-action-limit".into(), std::env::var("OSFO_TEMPORAL_CLOUD_ACTION_LIMIT").unwrap_or_else(|_| "not-applicable".into())),
            ("temporal-rust-sdk".into(), "0.5.0 Public Preview".into()),
            ("prometheus".into(), "3.13.0".into()),
            ("grafana".into(), "13.1.0".into()),
            ("postgres-exporter".into(), "0.18.1".into()),
            ("stackdriver-exporter".into(), "0.19.0".into()),
            ("mailpit".into(), "1.30.6".into()),
            ("sandbox-image".into(), std::env::var("OSFO_SANDBOX_IMAGE").unwrap_or_else(|_| "not-configured".into())),
            ("worker-fleet".into(), format!("{} lifecycle workers ({} admission, {} execution: {} basic, {} child, {} Temporal, {} sandbox, {} SMTP), {} database connections, {} Temporal gateway requests, {} Temporal workflow slots, fixed for run", manifest.worker_fleet.lifecycle_workers, manifest.worker_fleet.admission_workers, manifest.worker_fleet.execution_workers, manifest.worker_fleet.execution_lane_workers.basic, manifest.worker_fleet.execution_lane_workers.child, manifest.worker_fleet.execution_lane_workers.temporal, manifest.worker_fleet.execution_lane_workers.sandbox, manifest.worker_fleet.execution_lane_workers.smtp, manifest.worker_fleet.database_pool_size, manifest.worker_fleet.temporal_gateway_concurrency, manifest.worker_fleet.temporal_workflow_slots_per_process)),
        ]),
        scenarios: scenarios.to_vec(),
        correctness: vec![CorrectnessCheck {
            name: "traffic accounting".into(),
            passed: scenarios.iter().all(|stage| stage.traffic.reconcile().is_ok()),
            evidence: format!("{} observed stages reconciled at caller, admission, and terminal seams", scenarios.len()),
        }],
        failure_matrix: failure_matrix.to_vec(),
        notes: vec![
            "The deterministic adapter is the primary load lane. Real Temporal, Docker, artifact, approval, and Mailpit services are selected by the immutable journey mix.".into(),
            "Mailpit is the only SMTP destination. This is not a production ActionReceipt guarantee.".into(),
            "Local Docker tests the provider seam and controls, not hostile-code isolation.".into(),
            "Temporal Cloud is the primary workflow service. Its GCP us-east4 Namespace is cross-region from the Montreal runner and Cloud SQL, so the measured result includes that network path.".into(),
            "Temporal Cloud OpenMetrics are precomputed one-minute aggregates. Count, limit, and throttle metrics are evaluated together, and Cloud percentiles are not re-aggregated across dimensions.".into(),
        ],
        confirmation_verdict: verdict,
    };
    fs::write(
        output.join("results.json"),
        serde_json::to_vec_pretty(&bundle)?,
    )?;
    let telemetry = load_frozen_telemetry(output)?;
    fs::write(
        output.join("dashboard.html"),
        render_dashboard_with_telemetry(&bundle, &telemetry)?,
    )?;
    Ok(())
}

#[cfg(test)]
mod telemetry_profile_tests {
    use std::{
        collections::BTreeSet,
        fs,
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        time::Duration,
    };

    use super::{
        InFlightGuard, cloud_sql_describe_args, compute_project_quota_args,
        compute_runner_describe_args, healthy_target_jobs, is_checksum_input, load_workflow_id,
        parse_soft_nofile_limit, retry_with_backoff, run_blocking, telemetry_profile,
        topology_matches, unavailable_capture,
    };
    use osfo_agent_run_lifecycle_prototype::RunId;

    #[test]
    fn temporal_cloud_requires_openmetrics_and_delayed_capture() {
        let profile = telemetry_profile();

        assert!(profile.required_jobs.contains(&"temporal-cloud"));
        assert!(profile.required_jobs.contains(&"osfo-cloud-sql-monitoring"));
        assert!(profile.required_jobs.contains(&"osfo-runner-node"));
        assert!(profile.required_jobs.contains(&"temporal-rust-sdk-worker"));
        assert!(!profile.required_jobs.contains(&"temporal-frontend"));
        assert_eq!(
            profile.query_file,
            "observability/acceptance-queries.temporal-cloud.tsv"
        );
        assert_eq!(
            profile.prometheus_config,
            "observability/prometheus.temporal-cloud.yml"
        );
        assert_eq!(profile.settle_seconds, 210);
        assert_eq!(profile.name, "temporal-cloud-openmetrics");
    }

    #[test]
    fn every_confirmation_profile_targets_temporal_cloud() {
        let profile = telemetry_profile();

        assert!(!profile.required_jobs.contains(&"temporal-frontend"));
        assert!(!profile.required_jobs.contains(&"temporal-history"));
        assert!(profile.required_jobs.contains(&"temporal-cloud"));
        assert_eq!(
            profile.query_file,
            "observability/acceptance-queries.temporal-cloud.tsv"
        );
        assert_eq!(
            profile.prometheus_config,
            "observability/prometheus.temporal-cloud.yml"
        );
        assert_eq!(profile.settle_seconds, 210);
        assert_eq!(profile.name, "temporal-cloud-openmetrics");
    }

    #[test]
    fn target_health_only_accepts_up_jobs() {
        let targets = serde_json::json!({
            "data": {
                "activeTargets": [
                    {"health": "up", "labels": {"job": "temporal-cloud"}},
                    {"health": "down", "labels": {"job": "temporal-rust-sdk-worker"}},
                    {"health": "up", "labels": {}},
                    {"health": "up", "labels": {"job": "prometheus"}}
                ]
            }
        });

        assert_eq!(
            healthy_target_jobs(&targets),
            BTreeSet::from(["prometheus".to_owned(), "temporal-cloud".to_owned()])
        );
    }

    #[test]
    fn temporal_cloud_scrape_profile_targets_the_global_endpoint() {
        let config = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("observability/prometheus.temporal-cloud.yml"),
        )
        .expect("read Temporal Cloud Prometheus profile");

        assert!(config.contains("job_name: temporal-cloud"));
        assert!(config.contains("targets: [metrics.temporal.io]"));
        assert!(config.contains("credentials_file: /run/secrets/temporal-metrics-api-key"));
        assert!(config.contains("job_name: osfo-runner-node"));
    }

    #[test]
    fn temporal_cloud_acceptance_queries_cover_runner_and_database_saturation() {
        let queries = fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("observability/acceptance-queries.temporal-cloud.tsv"),
        )
        .expect("read Temporal Cloud acceptance queries");

        for required in [
            "runner_cpu_utilization",
            "runner_memory_utilization",
            "runner_network_receive_bytes_rate",
            "postgres_rollbacks_rate",
            "postgres_rows_inserted_rate",
            "postgres_rows_updated_rate",
            "postgres_blocks_read_rate",
            "postgres_cache_hit_ratio",
            "cloud_sql_wal_inserted_bytes_rate",
            "cloud_sql_disk_read_ops_rate",
            "cloud_sql_disk_write_ops_rate",
            "cloud_sql_swap_bytes_used",
        ] {
            assert!(queries.contains(required), "missing query {required}");
        }
    }

    #[test]
    fn compose_pins_a_read_only_runner_node_exporter() {
        let config =
            fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("compose.yaml"))
                .expect("read compose profile");

        assert!(config.contains("quay.io/prometheus/node-exporter:v1.9.1@sha256:"));
        assert!(config.contains("/:/host:ro,rslave"));
        assert!(config.contains("--path.rootfs=/host"));
        assert!(!config.contains("temporalio/auto-setup"));
        assert!(!config.contains("temporal-postgres"));
    }

    #[test]
    fn cloud_sql_capture_requests_only_reviewable_runtime_configuration() {
        let arguments = cloud_sql_describe_args("issue-13-instance");
        let joined = arguments.join(" ");

        assert!(joined.contains("instances describe issue-13-instance"));
        assert!(joined.contains("settings.insightsConfig"));
        assert!(joined.contains("settings.databaseFlags"));
        assert!(!joined.contains("credential"));
        assert!(!joined.contains("password"));
    }

    #[test]
    fn compute_capture_records_runner_shape_and_project_quota_without_credentials() {
        let runner = compute_runner_describe_args("issue-13-runner", "region-c").join(" ");
        let quota = compute_project_quota_args().join(" ");

        assert!(runner.contains("instances describe issue-13-runner"));
        assert!(runner.contains("--zone=region-c"));
        assert!(runner.contains("machineType"));
        assert!(quota.contains("compute project-info describe"));
        assert!(quota.contains("quotas"));
        assert!(!runner.contains("credential"));
        assert!(!quota.contains("credential"));
    }

    #[cfg(unix)]
    #[test]
    fn unavailable_control_plane_capture_is_sanitized_and_non_secret() {
        use std::os::unix::process::ExitStatusExt;

        let record = unavailable_capture(
            "compute-project-quotas",
            std::process::ExitStatus::from_raw(1 << 8),
        );
        let rendered = serde_json::to_string(&record).expect("render unavailable record");

        assert!(rendered.contains("unavailable"));
        assert!(rendered.contains("compute-project-quotas"));
        assert!(rendered.contains("command_exit_code"));
        assert!(!rendered.contains("stderr"));
        assert!(!rendered.contains("credential"));
        assert!(!rendered.contains("token"));
    }

    #[tokio::test]
    async fn blocking_http_client_lifecycle_stays_off_the_async_runtime() {
        run_blocking(|| {
            let client = reqwest::blocking::Client::builder().build()?;
            drop(client);
            Ok(())
        })
        .await
        .expect("blocking HTTP lifecycle completes on a blocking thread");
    }

    #[test]
    fn parses_linux_soft_file_descriptor_limit() {
        let limits = "Limit                     Soft Limit           Hard Limit           Units\n\
                      Max open files            65536                1048576              files\n";

        assert_eq!(parse_soft_nofile_limit(limits), Some(65_536));
    }

    #[test]
    fn topology_accepts_the_deployed_cloud_sql_profile_name() {
        assert!(topology_matches(
            "Cloud_SQL_PostgreSQL_same-region_confirmation",
            Some("northamerica-northeast1"),
            Some("northamerica-northeast1"),
        ));
        assert!(!topology_matches(
            "Cloud_SQL_PostgreSQL_same-region_confirmation",
            Some("northamerica-northeast1"),
            Some("us-east4"),
        ));
    }

    #[test]
    fn load_workflow_ids_are_scoped_to_the_immutable_benchmark_run() {
        let agent_run = RunId::from("run-root-586");

        assert_ne!(
            load_workflow_id("confirmation-a", &agent_run),
            load_workflow_id("confirmation-b", &agent_run)
        );
        assert_eq!(
            load_workflow_id("confirmation-a", &agent_run),
            "workflow-confirmation-a-run-root-586"
        );
    }

    #[test]
    fn transient_idempotent_delivery_is_retried_until_success() {
        let mut attempts = 0;

        let result = retry_with_backoff(3, Duration::ZERO, || {
            attempts += 1;
            if attempts < 3 {
                anyhow::bail!("transient Cloud SQL IAM login failure");
            }
            Ok("delivered")
        })
        .expect("third idempotent delivery attempt succeeds");

        assert_eq!(result, "delivered");
        assert_eq!(attempts, 3);
    }

    #[test]
    fn temporal_in_flight_counter_is_released_on_early_return() {
        let in_flight = Arc::new(AtomicU64::new(1));

        {
            let _guard = InFlightGuard::new(in_flight.clone());
        }

        assert_eq!(in_flight.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn checksum_manifest_excludes_externally_appended_run_log() {
        assert!(!is_checksum_input(PathBuf::from("run.log").as_path()));
        assert!(!is_checksum_input(PathBuf::from("SHA256SUMS").as_path()));
        assert!(!is_checksum_input(
            PathBuf::from("REPORT_SHA256SUMS").as_path()
        ));
        assert!(is_checksum_input(
            PathBuf::from("telemetry/summary.json").as_path()
        ));
    }
}
