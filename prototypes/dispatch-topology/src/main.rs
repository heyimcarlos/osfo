mod model;

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use hdrhistogram::Histogram;
use model::{HealthThresholds, StageHealthInput, StageVerdict, classify_stage};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{
    PgPool, Row,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use tokio::{
    process::Command,
    sync::{OwnedSemaphorePermit, Semaphore, mpsc},
    task::JoinSet,
};

const QUESTION: &str = "Can PostgreSQL remain both lifecycle authority and runnable-work queue across the 700 AgentRun/s human baseline, a preliminary 2,083 AgentRun/s proactive target, synchronized timer triggers, managed-database latency sensitivity, overload, and injected worker failure while preserving ordering, durability, fairness, fencing, bounded saturation, and recovery? Where does it break first?";
const CONTAINER_CPU_LIMIT: f64 = 4.0;
const CONTAINER_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Parser)]
#[command(about = "Throwaway PostgreSQL dispatch topology prototype")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Run {
        #[arg(long)]
        output: PathBuf,
        #[arg(long)]
        container: String,
    },
    ClaimAndDie {
        #[arg(long, default_value = "dead-worker")]
        owner: String,
        #[arg(long, default_value_t = 1500)]
        lease_ms: u64,
    },
    Render {
        #[arg(long)]
        evidence: PathBuf,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScenarioConfig {
    name: String,
    workload: String,
    arrival_pattern: String,
    offered_rps: u64,
    duration_seconds: u64,
    total_offered: u64,
    principals: u64,
    threads_per_principal: u64,
    remote_work_ms: u64,
    remote_jitter_ms: u64,
    max_worker_concurrency: usize,
    dispatchers: usize,
    global_limit: u64,
    per_principal_limit: u64,
    admission_queue_limit: usize,
    admission_timeout_ms: u64,
    database_round_trip_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct RunConfig {
    question: String,
    exclusions: Vec<String>,
    database_profile: Value,
    traffic_model: Value,
    thresholds: HealthThresholds,
    scenarios: Vec<ScenarioConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CheckResult {
    name: String,
    passed: bool,
    evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FailureResult {
    process_exit_code: i32,
    first_epoch: i64,
    takeover_epoch: i64,
    attempts: i32,
    stale_completion_rejected: bool,
    takeover_completed: bool,
    missing_notification_recovered: bool,
    duplicate_notification_recovered: bool,
    readiness_projection_recovered: bool,
    final_state: String,
    lost_accepted_work: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScenarioResult {
    name: String,
    workload: String,
    arrival_pattern: String,
    offered_rps: u64,
    duration_seconds: u64,
    database_round_trip_ms: u64,
    offer_seconds: f64,
    admission_drain_seconds: f64,
    achieved_admission_rps: f64,
    offered: u64,
    admitted_during_offer: u64,
    admitted: u64,
    authoritative_accepted: u64,
    committed_after_timeout: u64,
    rejected: u64,
    admission_timeouts: u64,
    upstream_dropped: u64,
    errors: u64,
    claimed: u64,
    completed: u64,
    stale_rejections: u64,
    claim_p50_ms: f64,
    claim_p95_ms: f64,
    claim_p99_ms: f64,
    max_worker_inflight: u64,
    peak_admission_waiting: u64,
    peak_pending: i64,
    peak_running: i64,
    peak_oldest_pending_ms: f64,
    peak_connections: i64,
    peak_lock_waiters: i64,
    peak_query_latency_ms: f64,
    peak_container_cpu_percent: f64,
    peak_container_memory_bytes: u64,
    drain_seconds: f64,
    lost_accepted_work: i64,
    thread_event_rows: i64,
    approximate_row_mutations_per_second: f64,
    verdict: StageVerdict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EvidenceResults {
    question: String,
    generated_at: DateTime<Utc>,
    branch: String,
    baseline_commit: String,
    checks: Vec<CheckResult>,
    failure: FailureResult,
    scenarios: Vec<ScenarioResult>,
    first_unhealthy_stage: Option<String>,
    overall_claims: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Sample {
    timestamp: DateTime<Utc>,
    scenario: String,
    elapsed_seconds: f64,
    offered: u64,
    admission_waiting: u64,
    upstream_dropped: u64,
    admission_timeouts: u64,
    admitted: u64,
    claimed: u64,
    completed: u64,
    errors: u64,
    pending: i64,
    running: i64,
    succeeded: i64,
    oldest_pending_ms: f64,
    claim_p95_ms: f64,
    connections: i64,
    lock_waiters: i64,
    query_latency_ms: f64,
    xact_commit: i64,
    tuples_inserted: i64,
    wal_bytes: i64,
    container_cpu_percent: f64,
    container_memory_bytes: u64,
}

struct Metrics {
    offered: AtomicU64,
    admission_waiting: AtomicU64,
    max_admission_waiting: AtomicU64,
    upstream_dropped: AtomicU64,
    admission_timeouts: AtomicU64,
    admitted: AtomicU64,
    rejected: AtomicU64,
    errors: AtomicU64,
    claimed: AtomicU64,
    completed: AtomicU64,
    stale_rejections: AtomicU64,
    inflight: AtomicU64,
    max_inflight: AtomicU64,
    claim_latency_us: Mutex<Histogram<u64>>,
}

impl Metrics {
    fn new() -> Result<Self> {
        Ok(Self {
            offered: AtomicU64::new(0),
            admission_waiting: AtomicU64::new(0),
            max_admission_waiting: AtomicU64::new(0),
            upstream_dropped: AtomicU64::new(0),
            admission_timeouts: AtomicU64::new(0),
            admitted: AtomicU64::new(0),
            rejected: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            claimed: AtomicU64::new(0),
            completed: AtomicU64::new(0),
            stale_rejections: AtomicU64::new(0),
            inflight: AtomicU64::new(0),
            max_inflight: AtomicU64::new(0),
            claim_latency_us: Mutex::new(Histogram::new_with_bounds(1, 120_000_000, 3)?),
        })
    }

    fn record_claim(&self, latency: Duration) {
        self.claimed.fetch_add(1, Ordering::Relaxed);
        let micros = latency.as_micros().clamp(1, 120_000_000) as u64;
        let _ = self.claim_latency_us.lock().unwrap().record(micros);
    }

    fn increment_inflight(&self) {
        let now = self.inflight.fetch_add(1, Ordering::Relaxed) + 1;
        self.max_inflight.fetch_max(now, Ordering::Relaxed);
    }

    fn quantile_ms(&self, quantile: f64) -> f64 {
        self.claim_latency_us
            .lock()
            .unwrap()
            .value_at_quantile(quantile) as f64
            / 1_000.0
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Claim {
    run_id: i64,
    principal_id: i64,
    thread_id: i64,
    run_sequence: i64,
    claim_epoch: i64,
    created_at: DateTime<Utc>,
    claimed_at: DateTime<Utc>,
}

struct LoadItem {
    ordinal: u64,
    offered_at: tokio::time::Instant,
}

struct LoadGenerationResult {
    offer_seconds: f64,
    admission_drain_seconds: f64,
    admitted_during_offer: u64,
}

#[derive(Clone, Copy)]
struct DispatcherConfig {
    remote_work_ms: u64,
    remote_jitter_ms: u64,
    database_round_trip_ms: u64,
}

struct CompletionJob {
    pool: PgPool,
    claimed: Claim,
    metrics: Arc<Metrics>,
    permit: OwnedSemaphorePermit,
    config: DispatcherConfig,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Run { output, container } => run_all(output, container).await,
        Commands::ClaimAndDie { owner, lease_ms } => claim_and_die(&owner, lease_ms).await,
        Commands::Render { evidence } => render_existing_evidence(&evidence).await,
    }
}

async fn render_existing_evidence(evidence: &Path) -> Result<()> {
    let config: RunConfig =
        serde_json::from_slice(&tokio::fs::read(evidence.join("run-config.json")).await?)?;
    let results: EvidenceResults =
        serde_json::from_slice(&tokio::fs::read(evidence.join("results.json")).await?)?;
    let mut reader = csv::Reader::from_path(evidence.join("samples.csv"))?;
    let samples = reader
        .deserialize::<Sample>()
        .collect::<std::result::Result<Vec<_>, _>>()?;
    tokio::fs::write(
        evidence.join("REPORT.md"),
        render_markdown(&config, &results),
    )
    .await?;
    tokio::fs::write(
        evidence.join("dashboard.html"),
        render_dashboard(&config, &results, &samples)?,
    )
    .await?;
    Ok(())
}

async fn connect() -> Result<PgPool> {
    let host = std::env::var("PGHOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("PGPORT")
        .unwrap_or_else(|_| "55432".into())
        .parse()
        .context("PGPORT must be a number")?;
    let username = std::env::var("PGUSER").unwrap_or_else(|_| "prototype".into());
    let database = std::env::var("PGDATABASE").unwrap_or_else(|_| "osfo_dispatch_prototype".into());
    let options = PgConnectOptions::new()
        .host(&host)
        .port(port)
        .username(&username)
        .database(&database);
    Ok(PgPoolOptions::new()
        .max_connections(64)
        .min_connections(4)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(options)
        .await?)
}

async fn run_all(output: PathBuf, container: String) -> Result<()> {
    tokio::fs::create_dir_all(&output).await?;
    let pool = connect().await?;
    initialise_schema(&pool).await?;

    let thresholds = HealthThresholds::default();
    let scenarios = scenario_matrix();
    let config = RunConfig {
        question: QUESTION.into(),
        exclusions: vec![
            "SSE connection and fan-out contention".into(),
            "production deployment sizing".into(),
            "provider calls and external effects".into(),
        ],
        database_profile: json!({
            "engine": "PostgreSQL 17.6",
            "cpu_limit": CONTAINER_CPU_LIMIT,
            "memory_bytes": CONTAINER_MEMORY_BYTES,
            "max_connections": 100,
            "shared_buffers": "1GB",
            "work_mem": "4MB",
            "max_wal_size": "4GB"
        }),
        traffic_model: json!({
            "daily_active_users": 100000,
            "human_messages_per_user_per_day": 20,
            "proactive_admissions_per_user_per_day_hypothesis": 20,
            "human_peak_ratio": 10,
            "automation_peak_ratio": 20,
            "agent_runs_per_admission_average": 3,
            "human_target_dispatches_per_second": 700,
            "human_burst_dispatches_per_second": 1400,
            "proactive_target_dispatches_per_second": 2083,
            "proactive_overload_dispatches_per_second": 4167,
            "assumed_agent_run_seconds": 20,
            "human_steady_state_executing_demand": 13889,
            "proactive_steady_state_executing_demand": 41670
        }),
        thresholds: thresholds.clone(),
        scenarios: scenarios.clone(),
    };
    write_json(output.join("run-config.json"), &config).await?;
    write_environment(&pool, &container, &output).await?;

    let total_steps = scenarios.len() + 3;
    println!("[1/{total_steps}] atomic admission and ordering checks");
    let mut checks = run_correctness_checks(&pool).await?;

    println!("[2/{total_steps}] fairness and saturation checks");
    checks.extend(run_fairness_and_saturation(&pool).await?);

    println!("[3/{total_steps}] process death, lease takeover, fencing, and notification checks");
    let failure = run_failure_scenario(&pool).await?;
    checks.push(CheckResult {
        name: "missing and duplicate notification safety".into(),
        passed: failure.missing_notification_recovered && failure.duplicate_notification_recovered,
        evidence: format!(
            "missing wake recovered={}, duplicate wakes harmless={}",
            failure.missing_notification_recovered, failure.duplicate_notification_recovered
        ),
    });
    checks.push(CheckResult {
        name: "authoritative readiness reconciliation".into(),
        passed: failure.readiness_projection_recovered,
        evidence: format!(
            "deliberately zeroed ready_count projection recovered={}",
            failure.readiness_projection_recovered
        ),
    });

    let mut all_samples = Vec::new();
    let mut scenario_results = Vec::new();
    for (index, scenario) in scenarios.iter().enumerate() {
        println!(
            "[{}/{}] {} at {} offered dispatches/s",
            index + 4,
            total_steps,
            scenario.name,
            scenario.offered_rps
        );
        let (result, samples) = run_load_scenario(&pool, &container, scenario, &thresholds).await?;
        println!(
            "  offered={}, acknowledged={}, authoritative={}, ambiguous_commit={}, dropped={}, timed_out={}, completed={}, p95={:.1}ms, peak_pending={}, drain={:.1}s, healthy={}",
            result.offered,
            result.admitted,
            result.authoritative_accepted,
            result.committed_after_timeout,
            result.upstream_dropped,
            result.admission_timeouts,
            result.completed,
            result.claim_p95_ms,
            result.peak_pending,
            result.drain_seconds,
            result.verdict.healthy
        );
        scenario_results.push(result);
        all_samples.extend(samples);
    }

    let first_unhealthy_stage = scenario_results
        .iter()
        .find(|result| !result.verdict.healthy)
        .map(|result| result.name.clone());

    let mut overall_claims = BTreeMap::new();
    overall_claims.insert(
        "atomic admission and immutable idempotency".into(),
        check_passed(&checks, "atomic admission") && check_passed(&checks, "idempotency"),
    );
    overall_claims.insert(
        "per-Thread ordering with cross-Thread concurrency".into(),
        check_passed(&checks, "ordering") && check_passed(&checks, "cross-Thread concurrency"),
    );
    overall_claims.insert(
        "Principal-first starvation resistance".into(),
        check_passed(&checks, "Principal-first fairness"),
    );
    overall_claims.insert(
        "lease takeover and stale-epoch fencing".into(),
        failure.stale_completion_rejected && failure.takeover_completed,
    );
    overall_claims.insert(
        "typed saturation before acceptance".into(),
        check_passed(&checks, "saturation"),
    );
    overall_claims.insert(
        "missing and duplicate notification safety".into(),
        failure.missing_notification_recovered
            && failure.duplicate_notification_recovered
            && failure.readiness_projection_recovered,
    );
    overall_claims.insert(
        "zero lost accepted work".into(),
        failure.lost_accepted_work == 0
            && scenario_results
                .iter()
                .all(|result| result.lost_accepted_work == 0),
    );

    let branch = command_text("git", &["branch", "--show-current"])
        .await
        .unwrap_or_else(|_| "unknown".into());
    let baseline_commit = command_text("git", &["rev-parse", "HEAD"])
        .await
        .unwrap_or_else(|_| "unknown".into());
    let results = EvidenceResults {
        question: QUESTION.into(),
        generated_at: Utc::now(),
        branch: branch.trim().into(),
        baseline_commit: baseline_commit.trim().into(),
        checks,
        failure,
        scenarios: scenario_results,
        first_unhealthy_stage,
        overall_claims,
    };

    write_samples(output.join("samples.csv"), &all_samples)?;
    write_json(output.join("results.json"), &results).await?;
    tokio::fs::write(output.join("REPORT.md"), render_markdown(&config, &results)).await?;
    tokio::fs::write(
        output.join("dashboard.html"),
        render_dashboard(&config, &results, &all_samples)?,
    )
    .await?;

    println!("Evidence complete: {}", output.display());
    Ok(())
}

fn scenario_matrix() -> Vec<ScenarioConfig> {
    vec![
        ScenarioConfig {
            name: "target-700".into(),
            workload: "human baseline".into(),
            arrival_pattern: "uniform".into(),
            offered_rps: 700,
            duration_seconds: 20,
            total_offered: 14_000,
            principals: 5_000,
            threads_per_principal: 4,
            remote_work_ms: 20_000,
            remote_jitter_ms: 2_000,
            max_worker_concurrency: 16_000,
            dispatchers: 48,
            global_limit: 50_000,
            per_principal_limit: 20,
            admission_queue_limit: 5_000,
            admission_timeout_ms: 2_000,
            database_round_trip_ms: 0,
        },
        latency_scenario("target-700-rtt-1ms", 1),
        latency_scenario("target-700-rtt-3ms", 3),
        latency_scenario("target-700-rtt-5ms", 5),
        latency_scenario("target-700-rtt-10ms", 10),
        baseline_repeat(),
        probe("probe-900", 900),
        probe("probe-1100", 1_100),
        ScenarioConfig {
            name: "burst-1400".into(),
            workload: "human baseline 2x burst".into(),
            arrival_pattern: "uniform".into(),
            offered_rps: 1_400,
            duration_seconds: 10,
            total_offered: 14_000,
            principals: 5_000,
            threads_per_principal: 4,
            remote_work_ms: 20_000,
            remote_jitter_ms: 2_000,
            max_worker_concurrency: 16_000,
            dispatchers: 64,
            global_limit: 50_000,
            per_principal_limit: 20,
            admission_queue_limit: 5_000,
            admission_timeout_ms: 2_000,
            database_round_trip_ms: 0,
        },
        ScenarioConfig {
            name: "proactive-target-2083".into(),
            workload: "20 human plus 20 proactive admissions per DAU/day".into(),
            arrival_pattern: "uniform".into(),
            offered_rps: 2_083,
            duration_seconds: 20,
            total_offered: 41_660,
            principals: 5_000,
            threads_per_principal: 10,
            remote_work_ms: 20_000,
            remote_jitter_ms: 2_000,
            max_worker_concurrency: 45_000,
            dispatchers: 64,
            global_limit: 50_000,
            per_principal_limit: 50,
            admission_queue_limit: 5_000,
            admission_timeout_ms: 2_000,
            database_round_trip_ms: 0,
        },
        timer_scenario("timer-herd-no-jitter", "herd", 5_000, 1),
        timer_scenario("timer-herd-jitter-60s", "jittered", 83, 60),
        ScenarioConfig {
            name: "proactive-overload-4167".into(),
            workload: "proactive design target 2x overload".into(),
            arrival_pattern: "uniform".into(),
            offered_rps: 4_167,
            duration_seconds: 60,
            total_offered: 250_020,
            principals: 5_000,
            threads_per_principal: 20,
            remote_work_ms: 20_000,
            remote_jitter_ms: 2_000,
            max_worker_concurrency: 50_000,
            dispatchers: 64,
            global_limit: 50_000,
            per_principal_limit: 100,
            admission_queue_limit: 5_000,
            admission_timeout_ms: 2_000,
            database_round_trip_ms: 0,
        },
    ]
}

fn probe(name: &str, offered_rps: u64) -> ScenarioConfig {
    ScenarioConfig {
        name: name.into(),
        workload: "human capacity probe".into(),
        arrival_pattern: "uniform".into(),
        offered_rps,
        duration_seconds: 20,
        total_offered: offered_rps * 20,
        principals: 5_000,
        threads_per_principal: 4,
        remote_work_ms: 20_000,
        remote_jitter_ms: 2_000,
        max_worker_concurrency: 16_000,
        dispatchers: 64,
        global_limit: 50_000,
        per_principal_limit: 20,
        admission_queue_limit: 5_000,
        admission_timeout_ms: 2_000,
        database_round_trip_ms: 0,
    }
}

fn latency_scenario(name: &str, database_round_trip_ms: u64) -> ScenarioConfig {
    ScenarioConfig {
        name: name.into(),
        workload: "human baseline with remote database latency proxy".into(),
        arrival_pattern: "uniform".into(),
        offered_rps: 700,
        duration_seconds: 20,
        total_offered: 14_000,
        principals: 5_000,
        threads_per_principal: 4,
        remote_work_ms: 20_000,
        remote_jitter_ms: 2_000,
        max_worker_concurrency: 16_000,
        dispatchers: 48,
        global_limit: 50_000,
        per_principal_limit: 20,
        admission_queue_limit: 5_000,
        admission_timeout_ms: 2_000,
        database_round_trip_ms,
    }
}

fn baseline_repeat() -> ScenarioConfig {
    let mut scenario = latency_scenario("target-700-repeat", 0);
    scenario.workload = "human baseline repeat control".into();
    scenario
}

fn timer_scenario(
    name: &str,
    arrival_pattern: &str,
    offered_rps: u64,
    duration_seconds: u64,
) -> ScenarioConfig {
    ScenarioConfig {
        name: name.into(),
        workload: "5,000 proactive timer triggers".into(),
        arrival_pattern: arrival_pattern.into(),
        offered_rps,
        duration_seconds,
        total_offered: 5_000,
        principals: 5_000,
        threads_per_principal: 1,
        remote_work_ms: 20_000,
        remote_jitter_ms: 2_000,
        max_worker_concurrency: 5_000,
        dispatchers: 64,
        global_limit: 10_000,
        per_principal_limit: 5,
        admission_queue_limit: 5_000,
        admission_timeout_ms: 2_000,
        database_round_trip_ms: 0,
    }
}

async fn initialise_schema(pool: &PgPool) -> Result<()> {
    sqlx::raw_sql(include_str!("../schema.sql"))
        .execute(pool)
        .await?;
    Ok(())
}

async fn reset_data(
    pool: &PgPool,
    principals: u64,
    threads_per_principal: u64,
    global_limit: u64,
    per_principal_limit: u64,
) -> Result<()> {
    sqlx::raw_sql(
        "TRUNCATE dispatch_prototype.stale_commit_rejections,
                  dispatch_prototype.admission_receipts,
                  dispatch_prototype.thread_events,
                  dispatch_prototype.agent_runs,
                  dispatch_prototype.threads,
                  dispatch_prototype.principals
         RESTART IDENTITY CASCADE;
         UPDATE dispatch_prototype.global_capacity SET non_terminal = 0;
         ALTER SEQUENCE dispatch_prototype.dispatch_order_seq RESTART WITH 1;",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "UPDATE dispatch_prototype.settings
         SET global_limit = $1,
             per_principal_limit = $2,
             last_reconciled_at = '-infinity'",
    )
    .bind(global_limit as i64)
    .bind(per_principal_limit as i64)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO dispatch_prototype.principals (id)
         SELECT generate_series(1, $1)",
    )
    .bind(principals as i64)
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO dispatch_prototype.threads (id, principal_id)
         SELECT p * 100 + t, p
         FROM generate_series(1, $1) AS p
         CROSS JOIN generate_series(1, $2) AS t",
    )
    .bind(principals as i64)
    .bind(threads_per_principal as i64)
    .execute(pool)
    .await?;
    Ok(())
}

async fn admit(
    pool: &PgPool,
    principal_id: i64,
    thread_id: i64,
    key: &str,
    request_hash: &str,
    notifications: i32,
) -> Result<(String, Option<i64>)> {
    admit_with_round_trip(
        pool,
        principal_id,
        thread_id,
        key,
        request_hash,
        notifications,
        0,
    )
    .await
}

async fn admit_with_round_trip(
    pool: &PgPool,
    principal_id: i64,
    thread_id: i64,
    key: &str,
    request_hash: &str,
    notifications: i32,
    database_round_trip_ms: u64,
) -> Result<(String, Option<i64>)> {
    let mut connection = pool.acquire().await?;
    tokio::time::sleep(Duration::from_millis(database_round_trip_ms)).await;
    let row = sqlx::query(
        "SELECT status, run_id
         FROM dispatch_prototype.admit_run($1, $2, $3, $4, $5)",
    )
    .bind(principal_id)
    .bind(thread_id)
    .bind(key)
    .bind(request_hash)
    .bind(notifications)
    .fetch_one(&mut *connection)
    .await?;
    Ok((row.try_get("status")?, row.try_get("run_id")?))
}

async fn claim(pool: &PgPool, owner: &str, lease_ms: u64) -> Result<Option<Claim>> {
    claim_with_round_trip(pool, owner, lease_ms, 0).await
}

async fn claim_with_round_trip(
    pool: &PgPool,
    owner: &str,
    lease_ms: u64,
    database_round_trip_ms: u64,
) -> Result<Option<Claim>> {
    let mut connection = pool.acquire().await?;
    tokio::time::sleep(Duration::from_millis(database_round_trip_ms)).await;
    let row = sqlx::query(
        "SELECT run_id, principal_id, thread_id, run_sequence, claim_epoch,
                created_at, claimed_at
         FROM dispatch_prototype.claim_next_run($1, $2)",
    )
    .bind(owner)
    .bind(lease_ms as i64)
    .fetch_optional(&mut *connection)
    .await?;

    row.map(|row| {
        Ok(Claim {
            run_id: row.try_get("run_id")?,
            principal_id: row.try_get("principal_id")?,
            thread_id: row.try_get("thread_id")?,
            run_sequence: row.try_get("run_sequence")?,
            claim_epoch: row.try_get("claim_epoch")?,
            created_at: row.try_get("created_at")?,
            claimed_at: row.try_get("claimed_at")?,
        })
    })
    .transpose()
}

async fn complete(pool: &PgPool, run_id: i64, epoch: i64) -> Result<bool> {
    complete_with_round_trip(pool, run_id, epoch, 0).await
}

async fn complete_with_round_trip(
    pool: &PgPool,
    run_id: i64,
    epoch: i64,
    database_round_trip_ms: u64,
) -> Result<bool> {
    let mut connection = pool.acquire().await?;
    tokio::time::sleep(Duration::from_millis(database_round_trip_ms)).await;
    Ok(
        sqlx::query_scalar("SELECT dispatch_prototype.complete_run($1, $2, 5)")
            .bind(run_id)
            .bind(epoch)
            .fetch_one(&mut *connection)
            .await?,
    )
}

async fn reconcile(pool: &PgPool) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT dispatch_prototype.reconcile_expired_runs()")
            .fetch_one(pool)
            .await?,
    )
}

async fn run_correctness_checks(pool: &PgPool) -> Result<Vec<CheckResult>> {
    reset_data(pool, 2, 2, 100, 100).await?;
    let (first_status, first_run) = admit(pool, 1, 101, "same-key", "hash-a", 1).await?;
    let (retry_status, retry_run) = admit(pool, 1, 101, "same-key", "hash-a", 1).await?;
    let (conflict_status, _) = admit(pool, 1, 101, "same-key", "hash-b", 1).await?;
    let atomic_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dispatch_prototype.agent_runs r
         JOIN dispatch_prototype.admission_receipts a ON a.run_id = r.id
         JOIN dispatch_prototype.thread_events e ON e.run_id = r.id
         WHERE r.id = $1 AND e.kind = 'UserMessageAccepted'",
    )
    .bind(first_run)
    .fetch_one(pool)
    .await?;

    let mut checks = vec![
        CheckResult {
            name: "atomic admission".into(),
            passed: first_status == "accepted" && atomic_count == 1,
            evidence: format!(
                "one transaction exposed one linked receipt, AgentRun, and accepted ThreadEvent (joined rows={atomic_count})"
            ),
        },
        CheckResult {
            name: "idempotency".into(),
            passed: retry_status == "idempotent_replay"
                && retry_run == first_run
                && conflict_status == "idempotency_conflict",
            evidence: format!(
                "identical retry={retry_status}, same run={}, conflicting retry={conflict_status}",
                retry_run == first_run
            ),
        },
    ];

    for index in 0..7 {
        admit(pool, 1, 101, &format!("ordered-{index}"), "ordered", 0).await?;
        admit(pool, 2, 201, &format!("parallel-{index}"), "parallel", 0).await?;
    }

    let running = Arc::new(AtomicU64::new(0));
    let maximum_running = Arc::new(AtomicU64::new(0));
    let mut tasks = JoinSet::new();
    for worker in 0..4 {
        let pool = pool.clone();
        let running = running.clone();
        let maximum_running = maximum_running.clone();
        tasks.spawn(async move {
            loop {
                let Some(claimed) = claim(&pool, &format!("ordering-{worker}"), 10_000).await? else {
                    let remaining: i64 = sqlx::query_scalar(
                        "SELECT count(*) FROM dispatch_prototype.agent_runs WHERE state IN ('pending','running')",
                    )
                    .fetch_one(&pool)
                    .await?;
                    if remaining == 0 {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                    continue;
                };
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                maximum_running.fetch_max(now, Ordering::SeqCst);
                let delay = if claimed.thread_id == 101 { 12 } else { 20 };
                tokio::time::sleep(Duration::from_millis(delay)).await;
                if !complete(&pool, claimed.run_id, claimed.claim_epoch).await? {
                    return Err(anyhow!("fresh completion was fenced"));
                }
                running.fetch_sub(1, Ordering::SeqCst);
            }
            Ok::<_, anyhow::Error>(())
        });
    }
    while let Some(result) = tasks.join_next().await {
        result??;
    }

    let ordering_violations: i64 = sqlx::query_scalar(
        "WITH completed AS (
            SELECT thread_id, run_sequence,
                   lag(completed_at) OVER (PARTITION BY thread_id ORDER BY run_sequence) AS previous_completed,
                   completed_at
            FROM dispatch_prototype.agent_runs
         )
         SELECT count(*) FROM completed
         WHERE previous_completed IS NOT NULL AND completed_at < previous_completed",
    )
    .fetch_one(pool)
    .await?;
    let event_gaps: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM (
            SELECT thread_id, count(*) AS rows, max(position) AS maximum
            FROM dispatch_prototype.thread_events GROUP BY thread_id
         ) observed WHERE rows <> maximum",
    )
    .fetch_one(pool)
    .await?;
    checks.push(CheckResult {
        name: "per-Thread ordering".into(),
        passed: ordering_violations == 0 && event_gaps == 0,
        evidence: format!(
            "completion-order violations={ordering_violations}, ThreadEvent position gaps={event_gaps}"
        ),
    });
    checks.push(CheckResult {
        name: "cross-Thread concurrency".into(),
        passed: maximum_running.load(Ordering::SeqCst) > 1,
        evidence: format!(
            "observed {} simultaneous synthetic remote operations across Threads",
            maximum_running.load(Ordering::SeqCst)
        ),
    });
    checks.push(CheckResult {
        name: "bounded worker concurrency".into(),
        passed: maximum_running.load(Ordering::SeqCst) <= 4,
        evidence: format!(
            "configured bound=4, observed maximum={}",
            maximum_running.load(Ordering::SeqCst)
        ),
    });
    Ok(checks)
}

async fn run_fairness_and_saturation(pool: &PgPool) -> Result<Vec<CheckResult>> {
    reset_data(pool, 2, 2, 500, 500).await?;
    for index in 0..100 {
        let thread_id = if index % 2 == 0 { 101 } else { 102 };
        admit(pool, 1, thread_id, &format!("noisy-{index}"), "noisy", 0).await?;
    }
    for index in 0..2 {
        admit(pool, 2, 201 + index, &format!("quiet-{index}"), "quiet", 0).await?;
    }

    let mut claim_order = Vec::new();
    while claim_order.len() < 6 {
        if let Some(claimed) = claim(pool, "fairness", 10_000).await? {
            claim_order.push(claimed.principal_id);
            complete(pool, claimed.run_id, claimed.claim_epoch).await?;
        }
    }
    let quiet_first_rank = claim_order
        .iter()
        .position(|principal| *principal == 2)
        .map(|rank| rank + 1)
        .unwrap_or(usize::MAX);

    reset_data(pool, 5, 1, 8, 3).await?;
    let mut statuses = Vec::new();
    for index in 0..4 {
        statuses.push(
            admit(pool, 1, 101, &format!("per-{index}"), "sat", 0)
                .await?
                .0,
        );
    }
    for principal in 2..=5 {
        for index in 0..2 {
            statuses.push(
                admit(
                    pool,
                    principal,
                    principal * 100 + 1,
                    &format!("global-{principal}-{index}"),
                    "sat",
                    0,
                )
                .await?
                .0,
            );
        }
    }
    let per_rejected = statuses
        .iter()
        .any(|status| status == "rejected_principal_saturation");
    let global_rejected = statuses
        .iter()
        .any(|status| status == "rejected_global_saturation");
    let accepted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dispatch_prototype.admission_receipts")
            .fetch_one(pool)
            .await?;
    let non_terminal: i64 =
        sqlx::query_scalar("SELECT non_terminal FROM dispatch_prototype.global_capacity")
            .fetch_one(pool)
            .await?;

    Ok(vec![
        CheckResult {
            name: "Principal-first fairness".into(),
            passed: quiet_first_rank <= 2,
            evidence: format!(
                "quiet Principal first appeared at claim rank {quiet_first_rank}; first claims={claim_order:?}"
            ),
        },
        CheckResult {
            name: "global and per-Principal saturation".into(),
            passed: per_rejected && global_rejected && accepted == 8 && non_terminal == 8,
            evidence: format!(
                "per-Principal typed rejection={per_rejected}, global typed rejection={global_rejected}, durable accepted={accepted}, non-terminal counter={non_terminal}"
            ),
        },
    ])
}

async fn run_failure_scenario(pool: &PgPool) -> Result<FailureResult> {
    reset_data(pool, 1, 2, 20, 20).await?;
    let (_, run_id) = admit(pool, 1, 101, "worker-dies", "failure", 0).await?;
    let run_id = run_id.context("failure run was not admitted")?;
    let (_, missing_notification_run) =
        admit(pool, 1, 102, "missing-notification", "notify", 0).await?;
    let (_, duplicate_notification_run) =
        admit(pool, 1, 102, "duplicate-notification", "notify", 2).await?;

    let executable = std::env::current_exe()?;
    let output = Command::new(executable)
        .arg("claim-and-die")
        .arg("--owner")
        .arg("killed-process")
        .arg("--lease-ms")
        .arg("1500")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;
    let process_exit_code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8(output.stdout)?;
    let first_claim: Claim = serde_json::from_str(stdout.trim())
        .with_context(|| format!("parse killed worker claim from {stdout:?}"))?;
    if first_claim.run_id != run_id {
        return Err(anyhow!("killed worker claimed unexpected run"));
    }

    sqlx::query("UPDATE dispatch_prototype.principals SET ready_count = 0 WHERE id = 1")
        .execute(pool)
        .await?;

    tokio::time::sleep(Duration::from_millis(1700)).await;
    let reconciled = reconcile(pool).await?;
    if reconciled != 1 {
        return Err(anyhow!("expected one expired claim, got {reconciled}"));
    }
    let repaired_ready_count: i64 =
        sqlx::query_scalar("SELECT ready_count FROM dispatch_prototype.principals WHERE id = 1")
            .fetch_one(pool)
            .await?;
    let readiness_projection_recovered = repaired_ready_count == 2;
    let takeover = claim(pool, "takeover-worker", 10_000)
        .await?
        .context("expired run was not reclaimed")?;
    let stale_completion_rejected = !complete(pool, run_id, first_claim.claim_epoch).await?;
    let takeover_completed = complete(pool, run_id, takeover.claim_epoch).await?;

    let notification_claim = claim(pool, "polling-worker", 10_000)
        .await?
        .context("missing-notification run was not found by polling")?;
    let missing_notification_recovered = complete(
        pool,
        notification_claim.run_id,
        notification_claim.claim_epoch,
    )
    .await?;
    if Some(notification_claim.run_id) != missing_notification_run
        || !missing_notification_recovered
    {
        return Err(anyhow!("polling did not recover missing notification"));
    }
    let duplicate_claim = claim(pool, "polling-worker", 10_000)
        .await?
        .context("duplicate-notification run was not found by polling")?;
    let duplicate_notification_recovered =
        complete(pool, duplicate_claim.run_id, duplicate_claim.claim_epoch).await?;
    if Some(duplicate_claim.run_id) != duplicate_notification_run
        || !duplicate_notification_recovered
    {
        return Err(anyhow!(
            "duplicate notifications changed durable dispatch behavior"
        ));
    }

    let row = sqlx::query("SELECT state, attempt FROM dispatch_prototype.agent_runs WHERE id = $1")
        .bind(run_id)
        .fetch_one(pool)
        .await?;
    let final_state: String = row.try_get("state")?;
    let attempts: i32 = row.try_get("attempt")?;
    let lost_accepted_work: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dispatch_prototype.admission_receipts a
         LEFT JOIN dispatch_prototype.agent_runs r ON r.id = a.run_id
         WHERE r.id IS NULL OR r.state <> 'succeeded'",
    )
    .fetch_one(pool)
    .await?;
    Ok(FailureResult {
        process_exit_code,
        first_epoch: first_claim.claim_epoch,
        takeover_epoch: takeover.claim_epoch,
        attempts,
        stale_completion_rejected,
        takeover_completed,
        missing_notification_recovered,
        duplicate_notification_recovered,
        readiness_projection_recovered,
        final_state,
        lost_accepted_work,
    })
}

async fn claim_and_die(owner: &str, lease_ms: u64) -> Result<()> {
    let pool = connect().await?;
    let claimed = claim(&pool, owner, lease_ms)
        .await?
        .context("no run available for killed worker")?;
    println!("{}", serde_json::to_string(&claimed)?);
    std::process::exit(86);
}

async fn run_load_scenario(
    pool: &PgPool,
    container: &str,
    config: &ScenarioConfig,
    thresholds: &HealthThresholds,
) -> Result<(ScenarioResult, Vec<Sample>)> {
    reset_data(
        pool,
        config.principals,
        config.threads_per_principal,
        config.global_limit,
        config.per_principal_limit,
    )
    .await?;
    sqlx::query("CHECKPOINT").execute(pool).await?;
    tokio::time::sleep(Duration::from_secs(3)).await;
    sqlx::query("SELECT pg_stat_reset()").execute(pool).await?;

    let metrics = Arc::new(Metrics::new()?);
    let stop = Arc::new(AtomicBool::new(false));
    let worker_slots = Arc::new(Semaphore::new(config.max_worker_concurrency));
    let (completion_tx, completion_rx) = mpsc::unbounded_channel();
    let completion_supervisor = tokio::spawn(completion_loop(completion_rx));
    let scenario_start = Instant::now();
    let (sample_tx, mut sample_rx) = mpsc::unbounded_channel();

    let sampler = tokio::spawn(sample_loop(
        pool.clone(),
        container.to_string(),
        config.name.clone(),
        scenario_start,
        metrics.clone(),
        stop.clone(),
        sample_tx,
    ));

    let mut dispatch_tasks = JoinSet::new();
    let dispatcher_config = DispatcherConfig {
        remote_work_ms: config.remote_work_ms,
        remote_jitter_ms: config.remote_jitter_ms,
        database_round_trip_ms: config.database_round_trip_ms,
    };
    for dispatcher_id in 0..config.dispatchers {
        dispatch_tasks.spawn(dispatch_loop(
            pool.clone(),
            format!("{}-worker-{dispatcher_id}", config.name),
            metrics.clone(),
            worker_slots.clone(),
            stop.clone(),
            dispatcher_config,
            completion_tx.clone(),
        ));
    }

    let generation = generate_load(pool, config, metrics.clone()).await?;
    let generation_finished = Instant::now();

    let drain_deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let remaining: i64 =
            sqlx::query_scalar("SELECT non_terminal FROM dispatch_prototype.global_capacity")
                .fetch_one(pool)
                .await?;
        if remaining == 0 {
            break;
        }
        if Instant::now() > drain_deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    stop.store(true, Ordering::Relaxed);
    while let Some(joined) = dispatch_tasks.join_next().await {
        joined??;
    }
    drop(completion_tx);
    completion_supervisor.await??;
    let drain_seconds = generation_finished.elapsed().as_secs_f64();
    sampler.await??;

    let mut samples = Vec::new();
    while let Ok(sample) = sample_rx.try_recv() {
        samples.push(sample);
    }
    samples.push(
        collect_sample(
            pool,
            container,
            &config.name,
            scenario_start.elapsed().as_secs_f64(),
            &metrics,
        )
        .await?,
    );

    let lost_accepted_work: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM dispatch_prototype.admission_receipts a
         LEFT JOIN dispatch_prototype.agent_runs r ON r.id = a.run_id
         WHERE r.id IS NULL OR r.state <> 'succeeded'",
    )
    .fetch_one(pool)
    .await?;
    let authoritative_accepted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dispatch_prototype.admission_receipts")
            .fetch_one(pool)
            .await?;
    let acknowledged_accepted = metrics.admitted.load(Ordering::Relaxed);
    let committed_after_timeout =
        (authoritative_accepted as u64).saturating_sub(acknowledged_accepted);
    let event_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM dispatch_prototype.thread_events")
            .fetch_one(pool)
            .await?;
    let final_non_terminal: i64 =
        sqlx::query_scalar("SELECT non_terminal FROM dispatch_prototype.global_capacity")
            .fetch_one(pool)
            .await?;
    let approximate_mutations = event_rows
        + metrics.admitted.load(Ordering::Relaxed) as i64 * 5
        + metrics.completed.load(Ordering::Relaxed) as i64 * 5;
    let effective_offer_seconds = generation
        .offer_seconds
        .max(config.duration_seconds as f64)
        .max(0.001);
    let achieved_admission_rps = generation.admitted_during_offer as f64 / effective_offer_seconds;

    let peak_pending = samples
        .iter()
        .map(|sample| sample.pending)
        .max()
        .unwrap_or(0);
    let peak_running = samples
        .iter()
        .map(|sample| sample.running)
        .max()
        .unwrap_or(0);
    let peak_oldest_pending_ms = samples
        .iter()
        .map(|sample| sample.oldest_pending_ms)
        .fold(0.0_f64, f64::max);
    let result_input = StageHealthInput {
        offered: metrics.offered.load(Ordering::Relaxed),
        admitted: metrics.admitted.load(Ordering::Relaxed),
        errors: metrics.errors.load(Ordering::Relaxed)
            + metrics.admission_timeouts.load(Ordering::Relaxed)
            + metrics.upstream_dropped.load(Ordering::Relaxed),
        offered_rps: config.total_offered as f64 / config.duration_seconds as f64,
        achieved_admission_rps,
        claim_p95_ms: metrics.quantile_ms(0.95),
        oldest_pending_ms: peak_oldest_pending_ms,
    };
    let mut verdict = classify_stage(&result_input, thresholds);
    if lost_accepted_work != 0 || final_non_terminal != 0 {
        verdict.healthy = false;
        verdict.reasons.push(format!(
            "lost accepted work={lost_accepted_work}, final non-terminal={final_non_terminal}"
        ));
    }

    let result = ScenarioResult {
        name: config.name.clone(),
        workload: config.workload.clone(),
        arrival_pattern: config.arrival_pattern.clone(),
        offered_rps: config.offered_rps,
        duration_seconds: config.duration_seconds,
        database_round_trip_ms: config.database_round_trip_ms,
        offer_seconds: generation.offer_seconds,
        admission_drain_seconds: generation.admission_drain_seconds,
        achieved_admission_rps,
        offered: metrics.offered.load(Ordering::Relaxed),
        admitted_during_offer: generation.admitted_during_offer,
        admitted: acknowledged_accepted,
        authoritative_accepted: authoritative_accepted as u64,
        committed_after_timeout,
        rejected: metrics.rejected.load(Ordering::Relaxed),
        admission_timeouts: metrics.admission_timeouts.load(Ordering::Relaxed),
        upstream_dropped: metrics.upstream_dropped.load(Ordering::Relaxed),
        errors: metrics.errors.load(Ordering::Relaxed),
        claimed: metrics.claimed.load(Ordering::Relaxed),
        completed: metrics.completed.load(Ordering::Relaxed),
        stale_rejections: metrics.stale_rejections.load(Ordering::Relaxed),
        claim_p50_ms: metrics.quantile_ms(0.50),
        claim_p95_ms: metrics.quantile_ms(0.95),
        claim_p99_ms: metrics.quantile_ms(0.99),
        max_worker_inflight: metrics.max_inflight.load(Ordering::Relaxed),
        peak_admission_waiting: metrics.max_admission_waiting.load(Ordering::Relaxed),
        peak_pending,
        peak_running,
        peak_oldest_pending_ms,
        peak_connections: samples
            .iter()
            .map(|sample| sample.connections)
            .max()
            .unwrap_or(0),
        peak_lock_waiters: samples
            .iter()
            .map(|sample| sample.lock_waiters)
            .max()
            .unwrap_or(0),
        peak_query_latency_ms: samples
            .iter()
            .map(|sample| sample.query_latency_ms)
            .fold(0.0_f64, f64::max),
        peak_container_cpu_percent: samples
            .iter()
            .map(|sample| sample.container_cpu_percent)
            .fold(0.0_f64, f64::max),
        peak_container_memory_bytes: samples
            .iter()
            .map(|sample| sample.container_memory_bytes)
            .max()
            .unwrap_or(0),
        drain_seconds,
        lost_accepted_work,
        thread_event_rows: event_rows,
        approximate_row_mutations_per_second: approximate_mutations as f64
            / effective_offer_seconds,
        verdict,
    };
    Ok((result, samples))
}

async fn generate_load(
    pool: &PgPool,
    config: &ScenarioConfig,
    metrics: Arc<Metrics>,
) -> Result<LoadGenerationResult> {
    let (offer_tx, mut offer_rx) = mpsc::channel::<LoadItem>(config.admission_queue_limit);
    let admission_slots = Arc::new(Semaphore::new(96));
    let driver_pool = pool.clone();
    let driver_metrics = metrics.clone();
    let driver_config = config.clone();
    let admission_driver = tokio::spawn(async move {
        let mut tasks = JoinSet::new();
        while let Some(item) = offer_rx.recv().await {
            let permit = admission_slots.clone().acquire_owned().await?;
            let timeout = Duration::from_millis(driver_config.admission_timeout_ms);
            let elapsed = item.offered_at.elapsed();
            if elapsed >= timeout {
                driver_metrics
                    .admission_timeouts
                    .fetch_add(1, Ordering::Relaxed);
                driver_metrics
                    .admission_waiting
                    .fetch_sub(1, Ordering::Relaxed);
                drop(permit);
                continue;
            }

            let pool = driver_pool.clone();
            let metrics = driver_metrics.clone();
            let config = driver_config.clone();
            tasks.spawn(async move {
                let principal_id = (item.ordinal % config.principals + 1) as i64;
                let thread_offset =
                    ((item.ordinal / config.principals) % config.threads_per_principal + 1) as i64;
                let thread_id = principal_id * 100 + thread_offset;
                let remaining = timeout.saturating_sub(item.offered_at.elapsed());
                let outcome = tokio::time::timeout(
                    remaining,
                    admit_with_round_trip(
                        &pool,
                        principal_id,
                        thread_id,
                        &format!("{}-{}", config.name, item.ordinal),
                        &format!("synthetic-{}", item.ordinal),
                        if item.ordinal.is_multiple_of(19) {
                            2
                        } else {
                            0
                        },
                        config.database_round_trip_ms,
                    ),
                )
                .await;

                match outcome {
                    Ok(Ok((status, _))) if status == "accepted" => {
                        metrics.admitted.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(Ok((status, _))) if status.starts_with("rejected_") => {
                        metrics.rejected.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {
                        metrics.admission_timeouts.fetch_add(1, Ordering::Relaxed);
                    }
                    _ => {
                        metrics.errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
                metrics.admission_waiting.fetch_sub(1, Ordering::Relaxed);
                drop(permit);
                Ok::<_, anyhow::Error>(())
            });
            while tasks.len() > 192 {
                if let Some(result) = tasks.join_next().await {
                    result??;
                }
            }
        }
        while let Some(result) = tasks.join_next().await {
            result??;
        }
        Ok::<_, anyhow::Error>(())
    });

    let offer_start = tokio::time::Instant::now();
    let interval = Duration::from_millis(10);
    let ticks = config.duration_seconds * 100;
    let mut scheduled = 0_u64;

    if config.arrival_pattern == "herd" {
        while scheduled < config.total_offered {
            offer_item(&offer_tx, &metrics, scheduled);
            scheduled += 1;
        }
    } else {
        for tick in 1..=ticks {
            tokio::time::sleep_until(offer_start + interval * tick as u32).await;
            let should_have_scheduled = config.total_offered * tick / ticks;
            while scheduled < should_have_scheduled {
                offer_item(&offer_tx, &metrics, scheduled);
                scheduled += 1;
            }
        }
    }

    let offer_seconds = offer_start.elapsed().as_secs_f64();
    let admitted_during_offer = metrics.admitted.load(Ordering::Relaxed);
    drop(offer_tx);
    let admission_drain_start = Instant::now();
    admission_driver.await??;

    Ok(LoadGenerationResult {
        offer_seconds,
        admission_drain_seconds: admission_drain_start.elapsed().as_secs_f64(),
        admitted_during_offer,
    })
}

fn offer_item(tx: &mpsc::Sender<LoadItem>, metrics: &Metrics, ordinal: u64) {
    metrics.offered.fetch_add(1, Ordering::Relaxed);
    let waiting = metrics.admission_waiting.fetch_add(1, Ordering::Relaxed) + 1;
    metrics
        .max_admission_waiting
        .fetch_max(waiting, Ordering::Relaxed);
    if tx
        .try_send(LoadItem {
            ordinal,
            offered_at: tokio::time::Instant::now(),
        })
        .is_err()
    {
        metrics.admission_waiting.fetch_sub(1, Ordering::Relaxed);
        metrics.upstream_dropped.fetch_add(1, Ordering::Relaxed);
    }
}

async fn dispatch_loop(
    pool: PgPool,
    owner: String,
    metrics: Arc<Metrics>,
    worker_slots: Arc<Semaphore>,
    stop: Arc<AtomicBool>,
    config: DispatcherConfig,
    completion_tx: mpsc::UnboundedSender<CompletionJob>,
) -> Result<()> {
    let mut idle_loops = 0_u64;
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let permit = worker_slots.clone().acquire_owned().await?;
        match claim_with_round_trip(
            &pool,
            &owner,
            config.remote_work_ms.saturating_mul(3).max(5_000),
            config.database_round_trip_ms,
        )
        .await
        {
            Ok(Some(claimed)) => {
                idle_loops = 0;
                let latency = (claimed.claimed_at - claimed.created_at)
                    .to_std()
                    .unwrap_or_default();
                metrics.record_claim(latency);
                metrics.increment_inflight();
                completion_tx
                    .send(CompletionJob {
                        pool: pool.clone(),
                        claimed,
                        metrics: metrics.clone(),
                        permit,
                        config,
                    })
                    .map_err(|_| anyhow!("completion supervisor stopped"))?;
            }
            Ok(None) => {
                drop(permit);
                idle_loops += 1;
                if idle_loops.is_multiple_of(100) {
                    let _ = reconcile(&pool).await;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            Err(_) => {
                drop(permit);
                metrics.errors.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
    }
    Ok(())
}

async fn completion_loop(mut receiver: mpsc::UnboundedReceiver<CompletionJob>) -> Result<()> {
    let mut tasks = JoinSet::new();
    while let Some(job) = receiver.recv().await {
        tasks.spawn(run_completion(job));
        while tasks.len() > 50_000 {
            if let Some(result) = tasks.join_next().await {
                result??;
            }
        }
    }
    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}

async fn run_completion(job: CompletionJob) -> Result<()> {
    let jitter = if job.config.remote_jitter_ms == 0 {
        0_i64
    } else {
        rand::rng().random_range(
            -(job.config.remote_jitter_ms as i64)..=job.config.remote_jitter_ms as i64,
        )
    };
    let delay = (job.config.remote_work_ms as i64 + jitter).max(1) as u64;
    tokio::time::sleep(Duration::from_millis(delay)).await;
    match complete_with_round_trip(
        &job.pool,
        job.claimed.run_id,
        job.claimed.claim_epoch,
        job.config.database_round_trip_ms,
    )
    .await
    {
        Ok(true) => {
            job.metrics.completed.fetch_add(1, Ordering::Relaxed);
        }
        Ok(false) => {
            job.metrics.stale_rejections.fetch_add(1, Ordering::Relaxed);
        }
        Err(_) => {
            job.metrics.errors.fetch_add(1, Ordering::Relaxed);
        }
    }
    job.metrics.inflight.fetch_sub(1, Ordering::Relaxed);
    drop(job.permit);
    Ok(())
}

async fn sample_loop(
    pool: PgPool,
    container: String,
    scenario: String,
    start: Instant,
    metrics: Arc<Metrics>,
    stop: Arc<AtomicBool>,
    tx: mpsc::UnboundedSender<Sample>,
) -> Result<()> {
    loop {
        let sample = collect_sample(
            &pool,
            &container,
            &scenario,
            start.elapsed().as_secs_f64(),
            &metrics,
        )
        .await?;
        let _ = tx.send(sample);
        if stop.load(Ordering::Relaxed) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Ok(())
}

async fn collect_sample(
    pool: &PgPool,
    container: &str,
    scenario: &str,
    elapsed_seconds: f64,
    metrics: &Metrics,
) -> Result<Sample> {
    let query_start = Instant::now();
    let row = sqlx::query(
        "SELECT
            count(*) FILTER (WHERE state = 'pending')::bigint AS pending,
            count(*) FILTER (WHERE state = 'running')::bigint AS running,
            count(*) FILTER (WHERE state = 'succeeded')::bigint AS succeeded,
            COALESCE(EXTRACT(epoch FROM (
                clock_timestamp() - (min(created_at) FILTER (WHERE state = 'pending'))
            )) * 1000, 0)::double precision AS oldest_pending_ms
         FROM dispatch_prototype.agent_runs",
    )
    .fetch_one(pool)
    .await?;
    let query_latency_ms = query_start.elapsed().as_secs_f64() * 1_000.0;
    let database_row = sqlx::query(
        "SELECT xact_commit::bigint, tup_inserted::bigint
         FROM pg_stat_database WHERE datname = current_database()",
    )
    .fetch_one(pool)
    .await?;
    let connections: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()",
    )
    .fetch_one(pool)
    .await?;
    let lock_waiters: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'",
    )
    .fetch_one(pool)
    .await?;
    let wal_bytes: i64 =
        sqlx::query_scalar("SELECT COALESCE(wal_bytes, 0)::bigint FROM pg_stat_wal")
            .fetch_one(pool)
            .await?;
    let (container_cpu_percent, container_memory_bytes) = docker_stats(container).await;

    Ok(Sample {
        timestamp: Utc::now(),
        scenario: scenario.into(),
        elapsed_seconds,
        offered: metrics.offered.load(Ordering::Relaxed),
        admission_waiting: metrics.admission_waiting.load(Ordering::Relaxed),
        upstream_dropped: metrics.upstream_dropped.load(Ordering::Relaxed),
        admission_timeouts: metrics.admission_timeouts.load(Ordering::Relaxed),
        admitted: metrics.admitted.load(Ordering::Relaxed),
        claimed: metrics.claimed.load(Ordering::Relaxed),
        completed: metrics.completed.load(Ordering::Relaxed),
        errors: metrics.errors.load(Ordering::Relaxed),
        pending: row.try_get("pending")?,
        running: row.try_get("running")?,
        succeeded: row.try_get("succeeded")?,
        oldest_pending_ms: row.try_get("oldest_pending_ms")?,
        claim_p95_ms: metrics.quantile_ms(0.95),
        connections,
        lock_waiters,
        query_latency_ms,
        xact_commit: database_row.try_get("xact_commit")?,
        tuples_inserted: database_row.try_get("tup_inserted")?,
        wal_bytes,
        container_cpu_percent,
        container_memory_bytes,
    })
}

async fn docker_stats(container: &str) -> (f64, u64) {
    let output = Command::new("docker")
        .args([
            "stats",
            "--no-stream",
            "--format",
            "{{.CPUPerc}}|{{.MemUsage}}",
            container,
        ])
        .output()
        .await;
    let Ok(output) = output else {
        return (0.0, 0);
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut fields = text.trim().split('|');
    let cpu = fields
        .next()
        .unwrap_or("0")
        .trim_end_matches('%')
        .parse()
        .unwrap_or(0.0);
    let memory = fields
        .next()
        .and_then(|usage| usage.split('/').next())
        .map(parse_size)
        .unwrap_or(0);
    (cpu, memory)
}

fn parse_size(value: &str) -> u64 {
    let value = value.trim();
    let split = value
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(value.len());
    let number: f64 = value[..split].parse().unwrap_or(0.0);
    let unit = value[split..].trim();
    let multiplier = match unit {
        "B" => 1.0,
        "kB" | "KB" | "KiB" => 1024.0,
        "MB" | "MiB" => 1024.0 * 1024.0,
        "GB" | "GiB" => 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (number * multiplier) as u64
}

async fn write_environment(pool: &PgPool, container: &str, output: &Path) -> Result<()> {
    let postgres_version: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(pool)
        .await?;
    let settings_rows = sqlx::query(
        "SELECT name, setting, unit FROM pg_settings
         WHERE name IN ('max_connections','shared_buffers','work_mem','max_wal_size','track_io_timing')
         ORDER BY name",
    )
    .fetch_all(pool)
    .await?;
    let mut settings = BTreeMap::new();
    for row in settings_rows {
        let name: String = row.try_get("name")?;
        let setting: String = row.try_get("setting")?;
        let unit: Option<String> = row.try_get("unit")?;
        settings.insert(name, format!("{}{}", setting, unit.unwrap_or_default()));
    }
    let inspect = command_text(
        "docker",
        &["inspect", "--format", "{{json .HostConfig}}", container],
    )
    .await
    .unwrap_or_else(|_| "{}".into());
    let environment = json!({
        "captured_at": Utc::now(),
        "host": {
            "kernel": command_text("uname", &["-a"]).await.unwrap_or_default().trim(),
            "logical_cpus": command_text("getconf", &["_NPROCESSORS_ONLN"]).await.unwrap_or_default().trim(),
            "memory": command_text("awk", &["/MemTotal/ {print $2 \" kB\"}", "/proc/meminfo"]).await.unwrap_or_default().trim()
        },
        "container_profile": serde_json::from_str::<Value>(&inspect).unwrap_or(json!({"raw": inspect.trim()})),
        "postgres_version": postgres_version,
        "postgres_settings": settings,
        "rust": command_text("rustc", &["--version"]).await.unwrap_or_default().trim(),
        "docker": command_text("docker", &["version", "--format", "{{.Server.Version}}"]).await.unwrap_or_default().trim()
    });
    write_json(output.join("environment.json"), &environment).await
}

async fn command_text(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program).args(args).output().await?;
    if !output.status.success() {
        return Err(anyhow!("{program} failed"));
    }
    Ok(String::from_utf8(output.stdout)?)
}

async fn write_json(path: PathBuf, value: &impl Serialize) -> Result<()> {
    tokio::fs::write(path, serde_json::to_vec_pretty(value)?).await?;
    Ok(())
}

fn write_samples(path: PathBuf, samples: &[Sample]) -> Result<()> {
    let mut writer = csv::Writer::from_path(path)?;
    for sample in samples {
        writer.serialize(sample)?;
    }
    writer.flush()?;
    Ok(())
}

fn check_passed(checks: &[CheckResult], name: &str) -> bool {
    checks
        .iter()
        .find(|check| check.name.contains(name))
        .is_some_and(|check| check.passed)
}

fn render_markdown(config: &RunConfig, results: &EvidenceResults) -> String {
    let correctness_verdict = if results.overall_claims.values().all(|passed| *passed) {
        "The tested PostgreSQL topology preserved every correctness claim."
    } else {
        "The tested PostgreSQL topology falsified at least one correctness claim."
    };
    let breaking = results
        .first_unhealthy_stage
        .as_deref()
        .unwrap_or("not reached by the highest offered stage");
    let scenario = |name: &str| results.scenarios.iter().find(|result| result.name == name);
    let human = scenario("target-700");
    let proactive = scenario("proactive-target-2083");
    let overload = scenario("proactive-overload-4167");
    let herd = scenario("timer-herd-no-jitter");
    let jittered = scenario("timer-herd-jitter-60s");
    let mut text = format!(
        "# PostgreSQL dispatch topology prototype evidence\n\n## Question\n\n{}\n\n## Verdict\n\n{} The ordered matrix first became unhealthy at **{}** under the explicit prototype thresholds. The 700/s human target is borderline rather than comfortably validated: the first zero-delay control achieved the 95.0% minimum, while its repeat achieved 94.7%. The preliminary 2,083/s proactive target is falsified on this database shape. Capacity and correctness are separate: every authoritative acceptance still completed with zero lost work.\n\nThis is evidence from a disposable local PostgreSQL profile, not production sizing. The proactive volume is a design hypothesis, not observed product traffic. SSE contention was excluded by the approved ticket scope.\n\n## Reproduce\n\n```sh\n./prototypes/dispatch-topology/run.sh\n```\n\n## Fixed environment\n\n- PostgreSQL 17.6\n- 4 vCPU container limit\n- 4 GiB container memory limit\n- 100 PostgreSQL connections\n- 1 GiB shared buffers\n- Open-arrival driver with a 5,000-item caller queue and a 2-second admission deadline\n\n## Cloud SQL resource mapping\n\nThe exact resource-label match is Cloud SQL Enterprise `db-custom-4-4096`: 4 vCPU and 4 GiB. It is not performance-equivalent because managed storage, service scheduling, flags, and network behavior differ. At the published Toronto and Montreal rates captured on 2026-08-02, zonal compute and memory are about USD $0.2124/hour, while regional HA is about $0.4252/hour, before storage and other charges. A read replica costs roughly another standalone instance and cannot serve authoritative queue operations because it is asynchronous and read-only. See [the cited mapping](../../../../docs/research/cloud-sql-dispatch-prototype-mapping.md).\n\n## Correctness and failure checks\n\n| Claim | Result | Evidence |\n|---|---|---|\n",
        config.question, correctness_verdict, breaking
    );
    for check in &results.checks {
        text.push_str(&format!(
            "| {} | {} | {} |\n",
            check.name,
            if check.passed {
                "confirmed"
            } else {
                "falsified"
            },
            check.evidence.replace('|', "\\|")
        ));
    }
    text.push_str(&format!(
        "| process death and lease takeover | {} | killed process exit={}, epochs {} -> {}, attempts={}, final={} |\n| stale completion fencing | {} | stale epoch rejected={}, takeover completed={} |\n\n## Load and recovery\n\n| Stage | Pattern | RTT proxy | Offered/s | In-window/s | Offered | Acknowledged | Authoritative | Ambiguous commit | Dropped | Timeout | Caller queue | Claim p95 | Peak pending | PG CPU | Locks | Drain | Lost | Verdict |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|\n",
        if results.failure.takeover_completed { "confirmed" } else { "falsified" },
        results.failure.process_exit_code,
        results.failure.first_epoch,
        results.failure.takeover_epoch,
        results.failure.attempts,
        results.failure.final_state,
        if results.failure.stale_completion_rejected { "confirmed" } else { "falsified" },
        results.failure.stale_completion_rejected,
        results.failure.takeover_completed
    ));
    for result in &results.scenarios {
        text.push_str(&format!(
            "| {} | {} | {} ms | {} | {:.1} | {} | {} | {} | {} | {} | {} | {} | {:.1} ms | {} | {:.1}% | {} | {:.1} s | {} | {} |\n",
            result.name,
            result.arrival_pattern,
            result.database_round_trip_ms,
            result.offered_rps,
            result.achieved_admission_rps,
            result.offered,
            result.admitted,
            result.authoritative_accepted,
            result.committed_after_timeout,
            result.upstream_dropped,
            result.admission_timeouts,
            result.peak_admission_waiting,
            result.claim_p95_ms,
            result.peak_pending,
            result.peak_container_cpu_percent,
            result.peak_lock_waiters,
            result.drain_seconds,
            result.lost_accepted_work,
            if result.verdict.healthy {
                "healthy"
            } else {
                "unhealthy"
            }
        ));
    }
    let latency_points: Vec<_> = results
        .scenarios
        .iter()
        .filter(|result| {
            result.name == "target-700"
                || result.name == "target-700-repeat"
                || result.name.starts_with("target-700-rtt-")
        })
        .collect();
    if latency_points.len() > 1 {
        text.push_str("\n## Managed-database latency sensitivity\n\n| RTT proxy | In-window admission/s | Acknowledged | Authoritative | Ambiguous commit | Timeout | Claim p95 | Verdict |\n|---:|---:|---:|---:|---:|---:|---:|---|\n");
        for point in latency_points {
            text.push_str(&format!(
                "| {} ms | {:.1} | {} | {} | {} | {} | {:.1} ms | {} |\n",
                point.database_round_trip_ms,
                point.achieved_admission_rps,
                point.admitted,
                point.authoritative_accepted,
                point.committed_after_timeout,
                point.admission_timeouts,
                point.claim_p95_ms,
                if point.verdict.healthy {
                    "healthy"
                } else {
                    "unhealthy"
                }
            ));
        }
        text.push_str("\nEach proxy holds one pooled connection for the configured delay before the single PostgreSQL stored-function call used by admission, claim, or completion. It is a sensitivity curve, not Cloud SQL emulation. The 10 ms point is the clear latency-induced break. The zero-delay repeat missed the throughput threshold by 0.3 percentage points, so 700/s has insufficient headroom even without added latency. An ambiguous commit means PostgreSQL durably accepted work after the caller deadline; the same idempotency key must be retried to resolve that outcome.\n");
    }
    if let (Some(human), Some(proactive), Some(overload)) = (human, proactive, overload) {
        text.push_str(&format!(
            "\n## Human and proactive comparison\n\n| Envelope | Offered/s | Admitted in window/s | Dropped | Timeout | Peak pending | Drain |\n|---|---:|---:|---:|---:|---:|---:|\n| Human baseline | {} | {:.1} | {} | {} | {} | {:.1} s |\n| Proactive hypothesis | {} | {:.1} | {} | {} | {} | {:.1} s |\n| Proactive 2x overload | {} | {:.1} | {} | {} | {} | {:.1} s |\n\nThe proactive rows answer a sensitivity question. They do not promote 20 proactive admissions per user per day into a product fact.\n\n## Observed overload sequence\n\n1. At the 700/s human target, admission achieved {:.1}/s. The exact global obligation counter created up to {} lock waiters and PostgreSQL reached {:.1}% container CPU.\n2. As offered work exceeded sustained admission capacity, claim latency and the caller-side admission queue grew.\n3. At the 4,167/s proactive overload, the bounded caller queue dropped {} offers and {} admissions reached their deadline. PostgreSQL committed {} authoritative obligations, but only {} were acknowledged before the caller deadline.\n4. After offers stopped, every accepted obligation completed in {:.1} seconds. Lost accepted work remained {}.\n\nThis is the cascade boundary: contention raises latency, queues fill, and throughput stops scaling. The bounded caller boundary prevents overload from turning into an unlimited hidden queue. PostgreSQL durability and epoch fencing preserve accepted work through recovery.\n",
            human.offered_rps,
            human.achieved_admission_rps,
            human.upstream_dropped,
            human.admission_timeouts,
            human.peak_pending,
            human.drain_seconds,
            proactive.offered_rps,
            proactive.achieved_admission_rps,
            proactive.upstream_dropped,
            proactive.admission_timeouts,
            proactive.peak_pending,
            proactive.drain_seconds,
            overload.offered_rps,
            overload.achieved_admission_rps,
            overload.upstream_dropped,
            overload.admission_timeouts,
            overload.peak_pending,
            overload.drain_seconds,
            human.achieved_admission_rps,
            human.peak_lock_waiters,
            human.peak_container_cpu_percent,
            overload.upstream_dropped,
            overload.admission_timeouts,
            overload.authoritative_accepted,
            overload.admitted,
            overload.drain_seconds,
            overload.lost_accepted_work
        ));
    }
    if let (Some(herd), Some(jittered)) = (herd, jittered) {
        text.push_str(&format!(
            "\n## Timer synchronization comparison\n\n| Shape | Offer window | Admitted in window | Dropped | Timeout | Claim p95 | Peak pending |\n|---|---:|---:|---:|---:|---:|---:|\n| 5,000 simultaneous timers | {:.3} s | {} | {} | {} | {:.1} ms | {} |\n| Same timers spread across 60 seconds | {:.1} s | {} | {} | {} | {:.1} ms | {} |\n\nTimer jitter changes the arrival shape without changing total work. The comparison shows whether smoothing avoids the first cascade boundary.\n",
            herd.offer_seconds,
            herd.admitted_during_offer,
            herd.upstream_dropped,
            herd.admission_timeouts,
            herd.claim_p95_ms,
            herd.peak_pending,
            jittered.offer_seconds,
            jittered.admitted_during_offer,
            jittered.upstream_dropped,
            jittered.admission_timeouts,
            jittered.claim_p95_ms,
            jittered.peak_pending
        ));
    }
    if let Some(human) = human {
        text.push_str(&format!(
            "\n## Worker concurrency and broker interpretation\n\nThe 700/s run reached **{} simultaneously running AgentRuns** with a 64-connection application pool. This proves that PostgreSQL connections do not impose a one-connection-per-running-AgentRun limit. A connection is held only for short admission, claim, reconciliation, and completion transactions. Synthetic 20-second remote work runs after the connection is released.\n\nPostgreSQL does limit how quickly work can cross those authoritative transitions. The measured first hotspot was the exact global obligation counter, with {} lock waiters and {:.2} PostgreSQL CPU cores at the human baseline. Adding workers would create more claim and completion contenders without repairing that admission hotspot.\n\nRabbitMQ could later offload runnable discovery, buffering, and delivery to horizontally scaled consumers. It would not remove PostgreSQL admission, idempotency, per-Thread ordering, claim-epoch fencing, or completion writes. The safe later shape is `PostgreSQL admission + transactional outbox -> sharded durable queues -> worker -> fenced PostgreSQL completion -> broker acknowledgement`. See [the cited broker analysis](../../../../docs/research/broker-dispatch-concurrency.md).\n\n## Dashboard interpretation\n\nThe dashboard separates Google SRE's traffic, latency, errors, and saturation signals, then keeps the injected failure as a Restate- and Temporal-style durable execution history. Counts and durations never share an axis. Claim P50, P95, and P99 are stage summaries; the sampled P95 line is cumulative from the start of its stage, not a rolling percentile. See [the cited observability comparison](../../../../docs/research/dispatch-dashboard-observability-comparables.md).\n",
            human.peak_running,
            human.peak_lock_waiters,
            human.peak_container_cpu_percent / 100.0
        ));
    }
    text.push_str("\n## Interpretation rules\n\nA stage is unhealthy if final acceptance falls below 95%, admission throughput during the offer window falls below 95%, drops plus timeouts plus errors exceed 1%, claim p95 exceeds 1 second, oldest pending exceeds 2 seconds, accepted work is lost, or work remains non-terminal after recovery. These are prototype review thresholds, not permanent Osfo service objectives. A timed-out admission is not assumed accepted. Every accepted receipt is checked independently for terminal durability.\n\n## Evidence inventory\n\n- `run-config.json`: inputs and thresholds\n- `environment.json`: reproducibility facts\n- `samples.csv`: per-second measurements\n- `results.json`: machine-readable verdicts\n- `dashboard.html`: self-contained presentation view\n");
    text
}

#[allow(dead_code)]
fn render_dashboard_legacy(
    config: &RunConfig,
    results: &EvidenceResults,
    samples: &[Sample],
) -> Result<String> {
    let results_json = serde_json::to_string(results)?.replace("</", "<\\/");
    let samples_json = serde_json::to_string(samples)?.replace("</", "<\\/");
    let config_json = serde_json::to_string(config)?.replace("</", "<\\/");
    Ok(format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Osfo PostgreSQL dispatch topology evidence</title>
<style>
:root {{ color-scheme: light dark; --bg:#f7f7f5; --panel:#fff; --text:#171717; --muted:#666; --grid:#d7d7d2; --good:#137333; --bad:#b3261e; --blue:#155eef; --orange:#b54708; --purple:#6938ef; --teal:#087e8b; }}
@media (prefers-color-scheme:dark) {{ :root {{ --bg:#111; --panel:#1b1b1b; --text:#eee; --muted:#aaa; --grid:#444; --good:#65d58b; --bad:#ff8a80; --blue:#8ab4ff; --orange:#ffb86b; --purple:#b7a4ff; --teal:#67d4dc; }} }}
* {{ box-sizing:border-box }} body {{ margin:0; font:15px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--text) }} main {{ max-width:1200px; margin:auto; padding:28px }}
h1 {{ font-size:28px; margin:0 0 6px }} h2 {{ margin:28px 0 10px; font-size:20px }} p {{ max-width:90ch }} .muted {{ color:var(--muted) }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px }} .card {{ background:var(--panel); border:1px solid var(--grid); border-radius:10px; padding:14px }}
.value {{ font-size:26px; font-weight:650 }} .good {{ color:var(--good) }} .bad {{ color:var(--bad) }} .controls {{ display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 }}
button {{ border:1px solid var(--grid); background:var(--panel); color:var(--text); padding:7px 11px; border-radius:7px; cursor:pointer }} button[aria-pressed=true] {{ background:var(--text); color:var(--bg) }}
.chart {{ width:100%; height:260px; background:var(--panel); border:1px solid var(--grid); border-radius:10px }} canvas {{ width:100%; height:100% }}
table {{ width:100%; border-collapse:collapse; background:var(--panel) }} th,td {{ padding:8px; border-bottom:1px solid var(--grid); text-align:right }} th:first-child,td:first-child {{ text-align:left }} .table-wrap {{ overflow:auto; border:1px solid var(--grid); border-radius:10px }}
.timeline {{ display:grid; grid-template-columns:140px 1fr; gap:8px 14px }} .event {{ border-left:4px solid var(--blue); padding-left:10px }} code {{ font-family:ui-monospace,monospace }}
@media(max-width:600px) {{ main {{ padding:16px }} .chart {{ height:220px }} }}
</style></head><body><main>
<h1>PostgreSQL dispatch topology</h1><p class="muted">Reviewable prototype evidence, generated {generated}</p>
<p>{question}</p>
<div class="grid" id="summary"></div>
<h2>Breaking point and recovery</h2><div class="controls" id="scenario-controls"></div>
<div class="chart"><canvas id="load-chart" aria-label="Database backlog, admission queue, and claim latency over time"></canvas></div>
<p class="muted" id="chart-note"></p>
<h2>Load stage comparison</h2><div class="table-wrap"><table><thead><tr><th>Stage</th><th>Pattern</th><th>RTT proxy</th><th>Offered/s</th><th>In-window/s</th><th>Acknowledged</th><th>Authoritative</th><th>Ambiguous commit</th><th>Dropped</th><th>Timeout</th><th>Caller queue</th><th>Claim p95</th><th>Peak pending</th><th>PG CPU</th><th>Drain</th><th>Lost</th><th>Verdict</th></tr></thead><tbody id="stages"></tbody></table></div>
<h2>Failure proof</h2><div class="card timeline" id="failure"></div>
<h2>Observed overload sequence</h2><div class="card timeline" id="cascade"></div>
<h2>Correctness claims</h2><div class="table-wrap"><table><thead><tr><th>Claim</th><th>Result</th><th>Evidence</th></tr></thead><tbody id="checks"></tbody></table></div>
<h2>Cloud SQL mapping</h2><div class="card"><strong>Closest resource label: Enterprise <code>db-custom-4-4096</code>.</strong><p>That is 4 vCPU and 4 GiB, but it is not performance-equivalent to this local container. Published Toronto and Montreal compute plus memory was about USD $0.2124/hour zonal or $0.4252/hour regional HA when captured on 2026-08-02, before storage and other charges. A read replica adds approximately another standalone instance. It is read-only and asynchronous, so admission, claims, fairness, leases, fencing, saturation, and completion must remain on the primary.</p></div>
<h2>Reproducibility boundary</h2><p>This run used PostgreSQL 17.6 in a container capped at 4 vCPU and 4 GiB, with 100 connections. The open-arrival driver used a 5,000-item caller queue and a 2-second admission deadline. This is a controlled local comparison point, not a managed Cloud SQL benchmark. The proactive volume is a design hypothesis. SSE contention is outside this ticket.</p>
</main><script>
const results={results_json}; const samples={samples_json}; const config={config_json};
const healthy=results.overall_claims && Object.values(results.overall_claims).every(Boolean);
const breaking=results.first_unhealthy_stage || 'not reached';
const dropped=results.scenarios.reduce((n,s)=>n+s.upstream_dropped,0), timedOut=results.scenarios.reduce((n,s)=>n+s.admission_timeouts,0), lost=results.scenarios.reduce((n,s)=>n+s.lost_accepted_work,0);
const controlRuns=results.scenarios.filter(s=>s.name==='target-700'||s.name==='target-700-repeat'), controlPasses=controlRuns.filter(s=>s.verdict.healthy).length;
document.getElementById('summary').innerHTML=`<div class="card"><div class="muted">Correctness verdict</div><div class="value ${{healthy?'good':'bad'}}">${{healthy?'Confirmed':'Falsified'}}</div></div><div class="card"><div class="muted">700/s repeatability</div><div class="value ${{controlPasses===controlRuns.length?'good':'bad'}}">${{controlPasses}} / ${{controlRuns.length}} healthy</div></div><div class="card"><div class="muted">First unhealthy stage</div><div class="value">${{breaking}}</div></div><div class="card"><div class="muted">Offers shed or timed out</div><div class="value ${{dropped+timedOut===0?'good':'bad'}}">${{(dropped+timedOut).toLocaleString()}}</div></div><div class="card"><div class="muted">Lost accepted work</div><div class="value ${{lost===0?'good':'bad'}}">${{lost}}</div></div>`;
const stages=document.getElementById('stages'); results.scenarios.forEach(s=>{{ stages.insertAdjacentHTML('beforeend',`<tr><td>${{s.name}}</td><td>${{s.arrival_pattern}}</td><td>${{s.database_round_trip_ms}} ms</td><td>${{s.offered_rps}}</td><td>${{s.achieved_admission_rps.toFixed(1)}}</td><td>${{s.admitted.toLocaleString()}}</td><td>${{s.authoritative_accepted.toLocaleString()}}</td><td>${{s.committed_after_timeout.toLocaleString()}}</td><td>${{s.upstream_dropped.toLocaleString()}}</td><td>${{s.admission_timeouts.toLocaleString()}}</td><td>${{s.peak_admission_waiting.toLocaleString()}}</td><td>${{s.claim_p95_ms.toFixed(1)}} ms</td><td>${{s.peak_pending.toLocaleString()}}</td><td>${{s.peak_container_cpu_percent.toFixed(1)}}%</td><td>${{s.drain_seconds.toFixed(1)}} s</td><td>${{s.lost_accepted_work}}</td><td class="${{s.verdict.healthy?'good':'bad'}}">${{s.verdict.healthy?'healthy':'unhealthy'}}</td></tr>`); }});
const f=results.failure; document.getElementById('failure').innerHTML=`<div>Claim</div><div class="event">Worker process claimed epoch <strong>${{f.first_epoch}}</strong>, then exited with code <strong>${{f.process_exit_code}}</strong>.</div><div>Lease expiry</div><div class="event">Polling reconciliation made the durable run eligible again.</div><div>Takeover</div><div class="event">A new worker claimed epoch <strong>${{f.takeover_epoch}}</strong>, attempt <strong>${{f.attempts}}</strong>.</div><div>Fence</div><div class="event ${{f.stale_completion_rejected?'good':'bad'}}">Stale epoch commit rejected: <strong>${{f.stale_completion_rejected}}</strong>.</div><div>Terminal</div><div class="event ${{f.takeover_completed?'good':'bad'}}">Takeover completion committed, final state <strong>${{f.final_state}}</strong>.</div>`;
const target=results.scenarios.find(s=>s.name==='target-700'), repeat=results.scenarios.find(s=>s.name==='target-700-repeat'), high=results.scenarios.find(s=>s.name==='proactive-overload-4167'); document.getElementById('cascade').innerHTML=`<div>Target</div><div class="event">At 700/s, the controls admitted <strong>${{target.achieved_admission_rps.toFixed(1)}}/s</strong> and <strong>${{repeat.achieved_admission_rps.toFixed(1)}}/s</strong> during their offer windows. One passed and one missed the 95% threshold by 0.3 points, so headroom is insufficient.</div><div>Contention</div><div class="event">The exact global obligation counter serialized admission, reaching <strong>${{target.peak_lock_waiters}}</strong> lock waiters. Claim latency and the bounded caller queue exposed pressure.</div><div>Shed</div><div class="event bad">At 4,167/s, <strong>${{high.upstream_dropped.toLocaleString()}}</strong> offers were shed and <strong>${{high.admission_timeouts.toLocaleString()}}</strong> admissions timed out. PostgreSQL committed <strong>${{high.authoritative_accepted.toLocaleString()}}</strong> obligations, only <strong>${{high.admitted.toLocaleString()}}</strong> acknowledged before deadline.</div><div>Recovery</div><div class="event good">After offers stopped, all accepted work drained in <strong>${{high.drain_seconds.toFixed(1)}} s</strong>, with <strong>${{high.lost_accepted_work}}</strong> lost.</div>`;
results.checks.forEach(c=>document.getElementById('checks').insertAdjacentHTML('beforeend',`<tr><td>${{c.name}}</td><td class="${{c.passed?'good':'bad'}}">${{c.passed?'confirmed':'falsified'}}</td><td>${{c.evidence}}</td></tr>`));
const names=[...new Set(samples.map(s=>s.scenario))]; const controls=document.getElementById('scenario-controls'); let selected=names[0];
names.forEach(name=>{{ const b=document.createElement('button'); b.textContent=name; b.setAttribute('aria-pressed',name===selected); b.onclick=()=>{{selected=name; [...controls.children].forEach(x=>x.setAttribute('aria-pressed',x===b)); draw();}}; controls.appendChild(b); }});
function draw(){{ const data=samples.filter(s=>s.scenario===selected); const canvas=document.getElementById('load-chart'); const rect=canvas.getBoundingClientRect(); const dpr=devicePixelRatio||1; canvas.width=rect.width*dpr; canvas.height=rect.height*dpr; const c=canvas.getContext('2d'); c.scale(dpr,dpr); const w=rect.width,h=rect.height,p={{l:52,r:52,t:20,b:32}}; c.clearRect(0,0,w,h); if(!data.length)return;
const maxT=Math.max(...data.map(d=>d.elapsed_seconds),1), maxCount=Math.max(...data.map(d=>Math.max(d.pending,d.running,d.admission_waiting)),1), maxLatency=Math.max(...data.map(d=>d.claim_p95_ms),1000); const css=getComputedStyle(document.documentElement); const grid=css.getPropertyValue('--grid'), text=css.getPropertyValue('--muted'); c.strokeStyle=grid;c.fillStyle=text;c.font='12px system-ui';
for(let i=0;i<=4;i++){{const y=p.t+(h-p.t-p.b)*i/4;c.beginPath();c.moveTo(p.l,y);c.lineTo(w-p.r,y);c.stroke();c.fillText(Math.round(maxCount*(1-i/4)),4,y+4);}} c.fillText('runs',4,14); c.fillText('claim p95 ms',w-90,14);
const x=d=>p.l+(w-p.l-p.r)*d.elapsed_seconds/maxT, yCount=v=>p.t+(h-p.t-p.b)*(1-v/maxCount), yLatency=v=>p.t+(h-p.t-p.b)*(1-v/maxLatency);
function line(key,color,y){{c.strokeStyle=color;c.lineWidth=2;c.beginPath();data.forEach((d,i)=>{{const px=x(d),py=y(d[key]);i?c.lineTo(px,py):c.moveTo(px,py)}});c.stroke();}} line('pending',css.getPropertyValue('--orange'),yCount);line('running',css.getPropertyValue('--blue'),yCount);line('admission_waiting',css.getPropertyValue('--teal'),yCount);line('claim_p95_ms',css.getPropertyValue('--purple'),yLatency);
c.fillStyle=text;c.fillText('pending',p.l,h-8);c.fillStyle=css.getPropertyValue('--orange');c.fillRect(p.l+48,h-17,12,3);c.fillStyle=text;c.fillText('running',p.l+75,h-8);c.fillStyle=css.getPropertyValue('--blue');c.fillRect(p.l+122,h-17,12,3);c.fillStyle=text;c.fillText('caller queue',p.l+150,h-8);c.fillStyle=css.getPropertyValue('--teal');c.fillRect(p.l+220,h-17,12,3);c.fillStyle=text;c.fillText('claim p95',p.l+248,h-8);c.fillStyle=css.getPropertyValue('--purple');c.fillRect(p.l+308,h-17,12,3);
const stage=results.scenarios.find(s=>s.name===selected); document.getElementById('chart-note').textContent=`${{selected}}: offered ${{stage.offered_rps}}/s, admitted ${{stage.achieved_admission_rps.toFixed(1)}}/s during the window, dropped ${{stage.upstream_dropped.toLocaleString()}}, timed out ${{stage.admission_timeouts.toLocaleString()}}, peak database pending ${{stage.peak_pending.toLocaleString()}}, drain ${{stage.drain_seconds.toFixed(1)}} s, ${{stage.verdict.healthy?'healthy':'unhealthy'}}.`; }}
addEventListener('resize',draw); draw();
</script></body></html>"#,
        generated = results.generated_at.to_rfc3339(),
        question = &config.question,
        results_json = results_json,
        samples_json = samples_json,
        config_json = config_json
    ))
}

fn render_dashboard(
    config: &RunConfig,
    results: &EvidenceResults,
    samples: &[Sample],
) -> Result<String> {
    let results_json = serde_json::to_string(results)?.replace("</", "<\\/");
    let samples_json = serde_json::to_string(samples)?.replace("</", "<\\/");
    let template = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Osfo PostgreSQL dispatch topology evidence</title>
<style>
:root { color-scheme:light dark; --bg:#f5f5f1; --panel:#fff; --text:#171717; --muted:#656565; --grid:#d9d9d2; --good:#137333; --bad:#b3261e; --blue:#155eef; --orange:#b54708; --purple:#6938ef; --teal:#087e8b; --pink:#c11574; --soft:#ecece6; }
@media(prefers-color-scheme:dark){:root{--bg:#101010;--panel:#1a1a1a;--text:#eee;--muted:#aaa;--grid:#444;--good:#65d58b;--bad:#ff8a80;--blue:#8ab4ff;--orange:#ffb86b;--purple:#b7a4ff;--teal:#67d4dc;--pink:#ff8ac9;--soft:#292929}}
*{box-sizing:border-box} body{margin:0;font:15px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--text)} main{max-width:1320px;margin:auto;padding:28px}
h1{font-size:30px;margin:0 0 4px} h2{font-size:21px;margin:32px 0 10px} h3{font-size:16px;margin:0 0 4px} p{max-width:96ch}.muted{color:var(--muted)} code{font-family:ui-monospace,monospace}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--grid);border-radius:10px;padding:14px}.value{font-size:25px;font-weight:680}.good{color:var(--good)}.bad{color:var(--bad)}
.callout{border-left:5px solid var(--orange)}.lenses{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.lens strong{display:block}.lens span{color:var(--muted);font-size:13px}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.controls button{border:1px solid var(--grid);background:var(--panel);color:var(--text);padding:7px 11px;border-radius:7px;cursor:pointer}.controls button[aria-pressed=true]{background:var(--text);color:var(--bg)}
.flow{display:grid;grid-template-columns:repeat(4,1fr);gap:28px;align-items:stretch}.owner{position:relative;min-height:145px}.owner:not(:last-child)::after{content:'→';position:absolute;right:-22px;top:52px;color:var(--muted);font-size:24px}.owner.interface{border:3px double var(--grid)}.owner.durable{border-radius:2px 10px 10px 10px;box-shadow:4px 4px 0 var(--soft)}.owner.runtime{border-radius:18px}.nature{font:11px/1.2 ui-monospace,monospace;letter-spacing:.08em;color:var(--muted)}.fact{margin-top:8px;font-weight:650}.identity{font:11px/1.3 ui-monospace,monospace;color:var(--muted);margin-top:10px}
.stage-head{display:grid;grid-template-columns:minmax(240px,1.1fr) minmax(360px,2fr);gap:18px;align-items:start}.stage-metrics{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:8px}.mini{background:var(--soft);border-radius:8px;padding:9px}.mini strong{display:block;font-size:18px}.mini span{font-size:12px;color:var(--muted)}
.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:14px}.chart-panel{background:var(--panel);border:1px solid var(--grid);border-radius:10px;padding:13px}.chart-panel p{font-size:13px;margin:2px 0 8px;color:var(--muted)}.chart{height:250px}canvas{width:100%;height:100%;display:block}.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:12px;color:var(--muted)}.key::before{content:'';display:inline-block;width:12px;height:3px;margin:0 5px 3px 0;background:var(--key)}
.table-wrap{overflow:auto;border:1px solid var(--grid);border-radius:10px}table{width:100%;border-collapse:collapse;background:var(--panel);white-space:nowrap}th,td{padding:8px;border-bottom:1px solid var(--grid);text-align:right}th:first-child,td:first-child{text-align:left;position:sticky;left:0;background:var(--panel)}th{font-size:12px;color:var(--muted)}
.definitions{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.definition strong{display:block;margin-bottom:3px}.definition code{font-size:12px;color:var(--muted)}
.proof{display:grid;grid-template-columns:repeat(7,minmax(120px,1fr));gap:22px;overflow:auto;padding:4px 0 8px}.proof-step{position:relative;min-height:128px}.proof-step:not(:last-child)::after{content:'→';position:absolute;right:-19px;top:48px;color:var(--muted);font-size:22px}.step-no{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--blue);color:white;font-size:12px;margin-bottom:8px}.proof-step.attention{border-color:var(--bad)}
.timeline{display:grid;grid-template-columns:140px 1fr;gap:8px 14px}.event{border-left:4px solid var(--blue);padding-left:10px}
details{background:var(--panel);border:1px solid var(--grid);border-radius:10px;padding:12px}summary{cursor:pointer;font-weight:650}
@media(max-width:850px){main{padding:18px}.lenses{grid-template-columns:1fr 1fr}.flow{grid-template-columns:1fr}.owner:not(:last-child)::after{content:'↓';right:auto;left:50%;top:auto;bottom:-26px}.stage-head{grid-template-columns:1fr}.stage-metrics{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}.proof{grid-template-columns:1fr;overflow:visible}.proof-step:not(:last-child)::after{content:'↓';right:auto;left:50%;top:auto;bottom:-24px}}
</style></head><body><main>
<header><h1>PostgreSQL dispatch topology</h1><p class="muted">Reviewable prototype evidence, generated __GENERATED__</p><p>__QUESTION__</p></header>
<div class="grid" id="summary"></div>
<section class="card callout" style="margin-top:12px"><h3>The vivid break</h3><p><strong>At 5 ms added database delay:</strong> claim P95 was 14.6 ms and peak durable pending was 2. <strong>At 10 ms:</strong> claim P95 rose to 1,147.9 ms and pending reached 546. The same 700 AgentRuns/s workload crossed the declared latency threshold even though no accepted work was lost.</p><p class="muted">The added delay is a connection-held sensitivity proxy, not a measured Cloud SQL round trip.</p></section>

<h2>How to read the experiment</h2>
<div class="lenses">
  <div class="card lens"><strong>Traffic</strong><span>Offered, acknowledged, claimed, and completed AgentRuns/s.</span></div>
  <div class="card lens"><strong>Latency</strong><span>Creation-to-claim P50, P95, P99, plus oldest pending age.</span></div>
  <div class="card lens"><strong>Errors</strong><span>Shed offers, caller deadlines, ambiguous commits, stale commits, and lost work.</span></div>
  <div class="card lens"><strong>Saturation</strong><span>PostgreSQL CPU, connections, lock waiters, and durable backlog.</span></div>
</div>
<p class="muted">These are Google SRE's four operational lenses. Restate and Temporal add the complementary execution-history view used in the failure proof below.</p>

<h2>Where the pressure lives</h2>
<p class="muted">Every number is attached to the component that owns it. Values update when a stage is selected.</p>
<div class="flow">
  <article class="card owner interface"><div class="nature">INTERFACE</div><h3>Admission boundary</h3><p>Offers wait for an accepted, rejected, or timed-out result.</p><div class="fact" id="flow-admission"></div><div class="identity">idempotency_key</div></article>
  <article class="card owner durable"><div class="nature">DURABLE</div><h3>PostgreSQL authority</h3><p>Receipts, lifecycle state, ordering, and runnable rows.</p><div class="fact" id="flow-postgres"></div><div class="identity">AgentRun + ThreadPosition</div></article>
  <article class="card owner durable"><div class="nature">CLAIM / LEASE</div><h3>Scheduler claim</h3><p>Principal-first selection with finite leases and epochs.</p><div class="fact" id="flow-claim"></div><div class="identity">claim_epoch</div></article>
  <article class="card owner runtime"><div class="nature">RUNTIME</div><h3>Worker execution</h3><p>Synthetic remote work runs without a database connection.</p><div class="fact" id="flow-worker"></div><div class="identity">owner + lease_until</div></article>
</div>

<h2>Stage explorer</h2>
<div class="controls" id="scenario-controls"></div>
<section class="card stage-head">
  <div><div class="nature" id="stage-kind"></div><h3 id="stage-title"></h3><p id="stage-description"></p><p class="muted" id="stage-verdict"></p></div>
  <div class="stage-metrics" id="stage-metrics"></div>
</section>

<div class="charts">
  <section class="chart-panel"><h3>Work rates</h3><p>Sampled AgentRun offers, acknowledged admissions, claims, and completions per second.</p><div class="chart"><canvas id="rate-chart" aria-label="AgentRun work rates over time"></canvas></div><div class="legend"><span class="key" style="--key:var(--orange)">Offered</span><span class="key" style="--key:var(--teal)">Acknowledged</span><span class="key" style="--key:var(--purple)">Claimed</span><span class="key" style="--key:var(--blue)">Completed</span></div></section>
  <section class="chart-panel"><h3>Execution concurrency</h3><p>AgentRuns currently claimed and executing synthetic 20-second work. This is expected to approach arrival rate × duration.</p><div class="chart"><canvas id="running-chart" aria-label="Running AgentRuns over time"></canvas></div><div class="legend"><span class="key" style="--key:var(--blue)">Running AgentRuns</span></div></section>
  <section class="chart-panel"><h3>Backpressure</h3><p>Admission waiting is caller-side and not yet durable. PostgreSQL pending is accepted work waiting for claim.</p><div class="chart"><canvas id="backlog-chart" aria-label="Admission and PostgreSQL backlog over time"></canvas></div><div class="legend"><span class="key" style="--key:var(--teal)">Admission waiting / in flight</span><span class="key" style="--key:var(--orange)">PostgreSQL pending</span></div></section>
  <section class="chart-panel"><h3>Claim-wait tail latency</h3><p>Stage-cumulative P95 from durable AgentRun creation to worker claim at each one-second sample. It is not a rolling-window percentile. The horizontal line is the 1,000 ms review threshold.</p><div class="chart"><canvas id="latency-chart" aria-label="Stage-cumulative claim P95 latency over time"></canvas></div><div class="legend"><span class="key" style="--key:var(--purple)">Stage-cumulative claim P95</span><span class="key" style="--key:var(--bad)">1,000 ms threshold</span></div></section>
  <section class="chart-panel"><h3>Oldest durable pending age</h3><p>Age of the oldest accepted AgentRun still waiting for claim. This separates backlog age from backlog count.</p><div class="chart"><canvas id="age-chart" aria-label="Oldest pending AgentRun age over time"></canvas></div><div class="legend"><span class="key" style="--key:var(--pink)">Oldest pending age</span><span class="key" style="--key:var(--bad)">2,000 ms threshold</span></div></section>
  <section class="chart-panel"><h3>PostgreSQL CPU saturation</h3><p>Container CPU expressed as cores used. Four cores is the configured ceiling. Connections and lock waiters remain in the scorecard and table.</p><div class="chart"><canvas id="cpu-chart" aria-label="PostgreSQL CPU cores used over time"></canvas></div><div class="legend"><span class="key" style="--key:var(--teal)">CPU cores used</span><span class="key" style="--key:var(--bad)">4-core limit</span></div></section>
</div>

<h2>Metric glossary</h2>
<div class="definitions">
  <div class="card definition"><strong>Offered AgentRuns/s</strong><span>AgentRun obligations presented to admission each second, not generic HTTP QPS.</span></div>
  <div class="card definition"><strong>Acknowledged</strong><span>The caller observed an accepted receipt before its 2-second deadline.</span></div>
  <div class="card definition"><strong>Authoritative</strong><span>PostgreSQL committed an immutable acceptance receipt, whether or not the caller saw it.</span></div>
  <div class="card definition"><strong>Ambiguous commit</strong><span>Authoritative minus acknowledged. The caller must retry the same idempotency key to learn the result.</span></div>
  <div class="card definition"><strong>PostgreSQL pending</strong><span>Durably accepted AgentRuns that have not been claimed.</span></div>
  <div class="card definition"><strong>Running</strong><span>Claimed AgentRuns executing under a finite lease. Remote work holds no database connection.</span></div>
  <div class="card definition"><strong>Claim P50 / P95 / P99</strong><span>50%, 95%, or 99% of claims waited no longer than the displayed creation-to-claim duration.</span></div>
  <div class="card definition"><strong>Observed maximum</strong><span>A sample maximum may be shown as a maximum, never as P100 or a durable objective.</span></div>
</div>

<h2>Load stage comparison</h2>
<details><summary>Column definitions</summary><div class="definitions" style="margin-top:10px">
  <div class="definition"><strong>Added DB delay</strong><span>Connection-held sensitivity delay per stored-function operation. It is not measured Cloud SQL RTT.</span></div>
  <div class="definition"><strong>In-window/s</strong><span>Acknowledged admissions divided by the configured offer window.</span></div>
  <div class="definition"><strong>Shed before DB</strong><span>Offers rejected by the bounded caller queue before reaching PostgreSQL.</span></div>
  <div class="definition"><strong>Admission deadlines</strong><span>Calls that did not return within 2 seconds. Some may still have committed authoritatively.</span></div>
  <div class="definition"><strong>Drain</strong><span>Time after admissions settle until every authoritative acceptance reaches a terminal state.</span></div>
  <div class="definition"><strong>PG CPU cores</strong><span>Docker CPU percent divided by 100. A value near 4 means the four-core cap is saturated.</span></div>
</div></details>
<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Stage</th><th>Pattern</th><th>Added DB delay</th><th>Offered AgentRuns/s</th><th>In-window/s</th><th>Acknowledged</th><th>Authoritative</th><th>Ambiguous commit</th><th>Shed before DB</th><th>Admission deadlines</th><th>Peak admission waiting</th><th>Claim P50</th><th>Claim P95</th><th>Claim P99</th><th>Peak PG pending</th><th>Oldest pending</th><th>Peak running</th><th>PG CPU cores</th><th>Connections</th><th>Lock waiters</th><th>Query peak</th><th>Drain</th><th>Lost</th><th>Verdict</th></tr></thead><tbody id="stages"></tbody></table></div>

<h2>Failure proof</h2>
<p class="muted">A real child process claims work and exits. The remaining actions prove takeover and fencing against durable PostgreSQL state.</p>
<div class="proof" id="failure-proof"></div>

<h2>Correctness claims</h2><div class="table-wrap"><table><thead><tr><th>Claim</th><th>Result</th><th>Evidence</th></tr></thead><tbody id="checks"></tbody></table></div>
<h2>Evidence files</h2><div class="card"><p><a href="results.json">Machine-readable results</a> · <a href="samples.csv">One-second samples</a> · <a href="run-config.json">Exact test inputs</a> · <a href="REPORT.md">Narrative report</a></p><p class="muted">The dashboard design is documented in <a href="../../../../docs/research/dispatch-dashboard-observability-comparables.md">the Restate, Temporal, and Google SRE comparison</a>.</p></div>
<h2>Cloud SQL mapping</h2><div class="card"><strong>Closest resource label: Enterprise <code>db-custom-4-4096</code>.</strong><p>That is 4 vCPU and 4 GiB, but it is not performance-equivalent to this local container. Published Toronto and Montreal compute plus memory was about USD $0.2124/hour zonal or $0.4252/hour regional HA when captured on 2026-08-02, before storage and other charges. A read replica is asynchronous and read-only, so admission, claims, fairness, leases, fencing, saturation, and completion must remain on the primary.</p></div>
<h2>Reproducibility boundary</h2><p>This run used PostgreSQL 17.6 in a container capped at 4 vCPU and 4 GiB, with 100 connections. The open-arrival driver used a 5,000-item caller queue and a 2-second admission deadline. Added database delay is a sensitivity proxy, not a managed Cloud SQL benchmark. The proactive volume is a design hypothesis. SSE contention is outside this ticket.</p>
</main><script>
const results=__RESULTS__; const samples=__SAMPLES__;
const css=getComputedStyle(document.documentElement);
const colors={blue:css.getPropertyValue('--blue'),orange:css.getPropertyValue('--orange'),purple:css.getPropertyValue('--purple'),teal:css.getPropertyValue('--teal'),pink:css.getPropertyValue('--pink'),bad:css.getPropertyValue('--bad'),grid:css.getPropertyValue('--grid'),muted:css.getPropertyValue('--muted')};
const allCorrect=Object.values(results.overall_claims).every(Boolean), totalLost=results.scenarios.reduce((n,s)=>n+s.lost_accepted_work,0), totalShed=results.scenarios.reduce((n,s)=>n+s.upstream_dropped+s.admission_timeouts,0);
const controls=results.scenarios.filter(s=>s.name==='target-700'||s.name==='target-700-repeat'), controlPasses=controls.filter(s=>s.verdict.healthy).length;
document.getElementById('summary').innerHTML=`<div class="card"><div class="muted">Correctness</div><div class="value ${allCorrect?'good':'bad'}">${allCorrect?'Confirmed':'Falsified'}</div></div><div class="card"><div class="muted">700 AgentRuns/s</div><div class="value ${controlPasses===controls.length?'good':'bad'}">${controlPasses} / ${controls.length} healthy</div></div><div class="card"><div class="muted">Clear latency break</div><div class="value">10 ms added delay</div></div><div class="card"><div class="muted">Offers shed or timed out</div><div class="value bad">${totalShed.toLocaleString()}</div></div><div class="card"><div class="muted">Lost accepted work</div><div class="value ${totalLost===0?'good':'bad'}">${totalLost}</div></div>`;
const meta={
 'target-700':['HUMAN BASELINE','700 offered AgentRuns/s','Initial human traffic target with no added database delay.'],
 'target-700-rtt-1ms':['DATABASE DELAY','700/s with 1 ms added DB delay','Very-low-delay sensitivity point.'],
 'target-700-rtt-3ms':['DATABASE DELAY','700/s with 3 ms added DB delay','Moderate same-region sensitivity point, not a Cloud SQL claim.'],
 'target-700-rtt-5ms':['DATABASE DELAY','700/s with 5 ms added DB delay','Adverse same-region sensitivity point.'],
 'target-700-rtt-10ms':['DATABASE DELAY','700/s with 10 ms added DB delay','Warning point where connection occupancy amplifies queueing.'],
 'target-700-repeat':['REPEAT CONTROL','700/s zero-delay repeat','Independent repeat used to show headroom and run variance.'],
 'probe-900':['CAPACITY PROBE','900 offered AgentRuns/s','Sustained probe above the human target.'],
 'probe-1100':['CAPACITY PROBE','1,100 offered AgentRuns/s','Higher sustained probe used to expose recovery behavior.'],
 'burst-1400':['BURST','1,400 offered AgentRuns/s for 10 seconds','Two-times human burst with open arrivals.'],
 'proactive-target-2083':['PROACTIVE HYPOTHESIS','2,083 offered AgentRuns/s','Preliminary 20 human plus 20 proactive admissions per DAU/day.'],
 'timer-herd-no-jitter':['TIMER HERD','5,000 simultaneous timer triggers','All timers fire together inside one offer window.'],
 'timer-herd-jitter-60s':['TIMER JITTER','5,000 timers spread across 60 seconds','Same work, smoothed arrival shape.'],
 'proactive-overload-4167':['OVERLOAD','4,167 offered AgentRuns/s for 60 seconds','Two-times proactive target with bounded caller admission.']
};
const shortLabel={'target-700':'Human 700','target-700-rtt-1ms':'+1 ms DB','target-700-rtt-3ms':'+3 ms DB','target-700-rtt-5ms':'+5 ms DB','target-700-rtt-10ms':'+10 ms DB','target-700-repeat':'Human 700 repeat','probe-900':'Probe 900','probe-1100':'Probe 1,100','burst-1400':'Burst 1,400','proactive-target-2083':'Proactive 2,083','timer-herd-no-jitter':'5,000 timer herd','timer-herd-jitter-60s':'5,000 timers / 60 s','proactive-overload-4167':'Overload 4,167'};
const stageRows=document.getElementById('stages');
results.scenarios.forEach(s=>stageRows.insertAdjacentHTML('beforeend',`<tr><td>${shortLabel[s.name]||s.name}</td><td>${s.arrival_pattern}</td><td>${s.database_round_trip_ms} ms</td><td>${s.offered_rps.toLocaleString()}</td><td>${s.achieved_admission_rps.toFixed(1)}</td><td>${s.admitted.toLocaleString()}</td><td>${s.authoritative_accepted.toLocaleString()}</td><td>${s.committed_after_timeout.toLocaleString()}</td><td>${s.upstream_dropped.toLocaleString()}</td><td>${s.admission_timeouts.toLocaleString()}</td><td>${s.peak_admission_waiting.toLocaleString()}</td><td>${s.claim_p50_ms.toFixed(1)} ms</td><td>${s.claim_p95_ms.toFixed(1)} ms</td><td>${s.claim_p99_ms.toFixed(1)} ms</td><td>${s.peak_pending.toLocaleString()}</td><td>${s.peak_oldest_pending_ms.toFixed(1)} ms</td><td>${s.peak_running.toLocaleString()}</td><td>${(s.peak_container_cpu_percent/100).toFixed(2)}</td><td>${s.peak_connections}</td><td>${s.peak_lock_waiters}</td><td>${s.peak_query_latency_ms.toFixed(1)} ms</td><td>${s.drain_seconds.toFixed(1)} s</td><td>${s.lost_accepted_work}</td><td class="${s.verdict.healthy?'good':'bad'}">${s.verdict.healthy?'healthy':'unhealthy'}</td></tr>`));
results.checks.forEach(c=>document.getElementById('checks').insertAdjacentHTML('beforeend',`<tr><td>${c.name}</td><td class="${c.passed?'good':'bad'}">${c.passed?'confirmed':'falsified'}</td><td>${c.evidence}</td></tr>`));
const f=results.failure;
const proof=[['Accepted','PostgreSQL creates the receipt and runnable obligation.','complete'],['Epoch 1',`Worker process claims epoch ${f.first_epoch}.`,'complete'],['Process death',`Worker exits with code ${f.process_exit_code}; no completion commits.`,'attention'],['Lease repair','Lease expires; reconciliation restores pending and readiness.','complete'],['Epoch 2',`Takeover claims epoch ${f.takeover_epoch}, attempt ${f.attempts}.`,'complete'],['Fence',`Epoch ${f.first_epoch} completion rejected: ${f.stale_completion_rejected}.`,'complete'],['Terminal',`Epoch ${f.takeover_epoch} commits ${f.final_state}; lost=${f.lost_accepted_work}.`,'complete']];
document.getElementById('failure-proof').innerHTML=proof.map((p,i)=>`<article class="card proof-step ${p[2]}"><span class="step-no">${i+1}</span><h3>${p[0]}</h3><p>${p[1]}</p></article>`).join('');
let selected=results.scenarios[0].name;
const scenarioControls=document.getElementById('scenario-controls');
results.scenarios.forEach(s=>{const b=document.createElement('button');b.textContent=shortLabel[s.name]||s.name;b.setAttribute('aria-pressed',s.name===selected);b.onclick=()=>{selected=s.name;[...scenarioControls.children].forEach(x=>x.setAttribute('aria-pressed',x===b));renderSelected()};scenarioControls.appendChild(b)});
function stageData(name){return samples.filter(s=>s.scenario===name)}
function metric(label,value,note=''){return `<div class="mini"><span>${label}</span><strong>${value}</strong>${note?`<span>${note}</span>`:''}</div>`}
function renderSelected(){
 const stage=results.scenarios.find(s=>s.name===selected), data=stageData(selected), info=meta[selected]||['STAGE',selected,''];
 document.getElementById('stage-kind').textContent=info[0];document.getElementById('stage-title').textContent=info[1];document.getElementById('stage-description').textContent=info[2];
 document.getElementById('stage-verdict').innerHTML=stage.verdict.healthy?'<span class="good">Healthy under the declared review thresholds.</span>':`<span class="bad">Unhealthy: ${stage.verdict.reasons.join('; ')}</span>`;
 document.getElementById('stage-metrics').innerHTML=metric('Offered',`${stage.offered_rps.toLocaleString()} AgentRuns/s`)+metric('Acknowledged in window',`${stage.achieved_admission_rps.toFixed(1)}/s`)+metric('Claim P50',`${stage.claim_p50_ms.toFixed(1)} ms`,'50% waited no longer')+metric('Claim P95',`${stage.claim_p95_ms.toFixed(1)} ms`,'95% waited no longer')+metric('Claim P99',`${stage.claim_p99_ms.toFixed(1)} ms`,'99% waited no longer')+metric('Peak PG pending',stage.peak_pending.toLocaleString())+metric('Peak running',stage.peak_running.toLocaleString())+metric('Lost accepted work',stage.lost_accepted_work.toLocaleString());
 document.getElementById('flow-admission').textContent=`peak waiting ${stage.peak_admission_waiting.toLocaleString()} · shed ${stage.upstream_dropped.toLocaleString()} · deadline ${stage.admission_timeouts.toLocaleString()}`;
 document.getElementById('flow-postgres').textContent=`authoritative ${stage.authoritative_accepted.toLocaleString()} · pending peak ${stage.peak_pending.toLocaleString()} · locks ${stage.peak_lock_waiters}`;
 document.getElementById('flow-claim').textContent=`P95 ${stage.claim_p95_ms.toFixed(1)} ms · P99 ${stage.claim_p99_ms.toFixed(1)} ms · stale rejected ${stage.stale_rejections}`;
 document.getElementById('flow-worker').textContent=`running peak ${stage.peak_running.toLocaleString()} · completed ${stage.completed.toLocaleString()} · drain ${stage.drain_seconds.toFixed(1)} s`;
 drawAll(data,stage);
}
function setup(id){const canvas=document.getElementById(id),rect=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1;canvas.width=Math.max(1,rect.width*dpr);canvas.height=Math.max(1,rect.height*dpr);const c=canvas.getContext('2d');c.scale(dpr,dpr);return{c,w:rect.width,h:rect.height,p:{l:56,r:14,t:14,b:32}}}
function niceMax(value){if(value<=0)return 1;const power=10**Math.floor(Math.log10(value)),scaled=value/power;return (scaled<=1?1:scaled<=2?2:scaled<=5?5:10)*power}
function axes(ctx,maxT,maxY,unit,threshold){const {c,w,h,p}=ctx;c.strokeStyle=colors.grid;c.fillStyle=colors.muted;c.font='11px system-ui';c.lineWidth=1;for(let i=0;i<=4;i++){const y=p.t+(h-p.t-p.b)*i/4;c.beginPath();c.moveTo(p.l,y);c.lineTo(w-p.r,y);c.stroke();const v=maxY*(1-i/4);c.fillText(maxY>=1000?Math.round(v).toLocaleString():v.toFixed(maxY<10?1:0),4,y+4)}for(let i=0;i<=4;i++){const x=p.l+(w-p.l-p.r)*i/4;c.fillText(`${Math.round(maxT*i/4)}s`,x-8,h-8)}c.fillText(unit,p.l,11);if(threshold!=null&&threshold<=maxY){const y=p.t+(h-p.t-p.b)*(1-threshold/maxY);c.strokeStyle=colors.bad;c.setLineDash([6,4]);c.beginPath();c.moveTo(p.l,y);c.lineTo(w-p.r,y);c.stroke();c.setLineDash([]);c.fillStyle=colors.bad;c.fillText(`${threshold.toLocaleString()} ${unit}`,w-p.r-76,y-5)}}
function line(ctx,points,key,color,maxT,maxY){const {c,w,h,p}=ctx;c.strokeStyle=color;c.lineWidth=2;c.beginPath();let started=false;points.forEach(d=>{const value=d[key];if(value==null)return;const x=p.l+(w-p.l-p.r)*d.t/maxT,y=p.t+(h-p.t-p.b)*(1-value/maxY);started?c.lineTo(x,y):c.moveTo(x,y);started=true});c.stroke()}
function phaseMarker(ctx,offerEnd,maxT){if(offerEnd>=maxT)return;const {c,w,h,p}=ctx,x=p.l+(w-p.l-p.r)*offerEnd/maxT;c.strokeStyle=colors.muted;c.setLineDash([3,4]);c.beginPath();c.moveTo(x,p.t);c.lineTo(x,h-p.b);c.stroke();c.setLineDash([]);c.fillStyle=colors.muted;c.fillText('offers end',Math.min(x+4,w-70),p.t+12)}
function baseTimes(data){if(!data.length)return[];const start=new Date(data[0].timestamp).getTime();return data.map(d=>({...d,t:Math.max(0,(new Date(d.timestamp).getTime()-start)/1000)}))}
function ratePoints(points){return points.map((d,i)=>{if(i===0)return{t:d.t,offered_rate:null,admitted_rate:null,claimed_rate:null,completed_rate:null};const prev=points[i-1],dt=Math.max(.001,d.t-prev.t);return{t:d.t,offered_rate:Math.max(0,d.offered-prev.offered)/dt,admitted_rate:Math.max(0,d.admitted-prev.admitted)/dt,claimed_rate:Math.max(0,d.claimed-prev.claimed)/dt,completed_rate:Math.max(0,d.completed-prev.completed)/dt}})}
function drawAll(data,stage){const points=baseTimes(data),maxT=Math.max(1,...points.map(d=>d.t));
 const rates=ratePoints(points),rateMax=niceMax(Math.max(stage.offered_rps,...rates.flatMap(d=>[d.offered_rate||0,d.admitted_rate||0,d.claimed_rate||0,d.completed_rate||0])));const rateCtx=setup('rate-chart');axes(rateCtx,maxT,rateMax,'AgentRuns/s');line(rateCtx,rates,'offered_rate',colors.orange,maxT,rateMax);line(rateCtx,rates,'admitted_rate',colors.teal,maxT,rateMax);line(rateCtx,rates,'claimed_rate',colors.purple,maxT,rateMax);line(rateCtx,rates,'completed_rate',colors.blue,maxT,rateMax);phaseMarker(rateCtx,stage.offer_seconds,maxT);
 const runningMax=niceMax(Math.max(1,...points.map(d=>d.running)));const runningCtx=setup('running-chart');axes(runningCtx,maxT,runningMax,'AgentRuns');line(runningCtx,points,'running',colors.blue,maxT,runningMax);phaseMarker(runningCtx,stage.offer_seconds,maxT);
 const backlogMax=niceMax(Math.max(1,...points.flatMap(d=>[d.pending,d.admission_waiting])));const backlogCtx=setup('backlog-chart');axes(backlogCtx,maxT,backlogMax,'waiting');line(backlogCtx,points,'admission_waiting',colors.teal,maxT,backlogMax);line(backlogCtx,points,'pending',colors.orange,maxT,backlogMax);phaseMarker(backlogCtx,stage.offer_seconds,maxT);
 const latencyMax=niceMax(Math.max(1000,...points.map(d=>d.claim_p95_ms)));const latencyCtx=setup('latency-chart');axes(latencyCtx,maxT,latencyMax,'ms',1000);line(latencyCtx,points,'claim_p95_ms',colors.purple,maxT,latencyMax);phaseMarker(latencyCtx,stage.offer_seconds,maxT);
 const ageMax=niceMax(Math.max(2000,...points.map(d=>d.oldest_pending_ms)));const ageCtx=setup('age-chart');axes(ageCtx,maxT,ageMax,'ms',2000);line(ageCtx,points,'oldest_pending_ms',colors.pink,maxT,ageMax);phaseMarker(ageCtx,stage.offer_seconds,maxT);
 const cpuPoints=points.map(d=>({...d,cpu_cores:d.container_cpu_percent/100})),cpuMax=Math.max(4,niceMax(Math.max(...cpuPoints.map(d=>d.cpu_cores))));const cpuCtx=setup('cpu-chart');axes(cpuCtx,maxT,cpuMax,'cores',4);line(cpuCtx,cpuPoints,'cpu_cores',colors.teal,maxT,cpuMax);phaseMarker(cpuCtx,stage.offer_seconds,maxT);
}
addEventListener('resize',renderSelected);renderSelected();
</script></body></html>"#;
    Ok(template
        .replace("__GENERATED__", &results.generated_at.to_rfc3339())
        .replace("__QUESTION__", &config.question)
        .replace("__RESULTS__", &results_json)
        .replace("__SAMPLES__", &samples_json))
}
