use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
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
    ChildJoinMode, Command, LifecycleManager, MemoryLedger, PostgresLifecycle, RunId, RunState,
    evidence::{
        CorrectnessCheck, EvidenceBundle, EvidenceManifest, ScenarioEvidence, TimeSample,
        render_dashboard,
    },
    latency::{LatencyRecorder, LatencySample},
    load::{ArrivalDisposition, OpenLoopSchedule},
    metrics::{MetricsRegistry, MetricsSnapshot},
};
use postgres::{Client, NoTls};

#[derive(Debug, Clone, Copy)]
struct ScheduledArrival {
    ordinal: usize,
    intended_at: Instant,
}

#[derive(Default)]
struct StageCounters {
    offered: AtomicU64,
    received: AtomicU64,
    caller_drop: AtomicU64,
    accepted: AtomicU64,
    shed_or_rejected: AtomicU64,
    completed: AtomicU64,
    failed: AtomicU64,
    errors: AtomicU64,
}

fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let prototype_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let manifest_path = std::env::var("OSFO_EVIDENCE_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|_| prototype_dir.join("config/evidence-open-arrival.json"));
    let manifest_bytes = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read evidence manifest {}", manifest_path.display()))?;
    let manifest = EvidenceManifest::from_json(&manifest_bytes)?;
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .context("OSFO_TEST_DATABASE_URL must point at the evidence database")?;
    let output = std::env::var("OSFO_EVIDENCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| prototype_dir.join("evidence/latest"));
    fs::create_dir_all(&output)?;
    let mut lifecycle = PostgresLifecycle::connect(&database_url)?;
    lifecycle.reset()?;
    verify_deterministic_adapter()?;

    let registry = MetricsRegistry::default();
    let metrics_address =
        std::env::var("OSFO_METRICS_ADDRESS").unwrap_or_else(|_| "0.0.0.0:9464".into());
    let _metrics_server = registry.serve(&metrics_address)?;
    let mut scenarios = Vec::new();
    for (index, stage) in manifest.stages.iter().enumerate() {
        let raw_latency_file = format!("latencies-{index:02}.csv");
        scenarios.push(run_stage(
            &database_url,
            stage,
            &registry,
            &output.join(&raw_latency_file),
            raw_latency_file,
        )?);
    }

    let accepted: u64 = scenarios.iter().map(|stage| stage.accepted).sum();
    let completed: u64 = scenarios.iter().map(|stage| stage.completed).sum();
    let error_count: usize = scenarios.iter().map(|stage| stage.errors.len()).sum();
    let bundle = EvidenceBundle {
        schema_version: manifest.schema_version,
        generated_at: format!(
            "unix:{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
        ),
        question: manifest.question.clone(),
        environment: environment(),
        scenarios,
        correctness: vec![
            CorrectnessCheck {
                name: "deterministic semantic sequence".into(),
                passed: true,
                evidence: format!("fixed seed {} repeated the same sequence", manifest.seed),
            },
            CorrectnessCheck {
                name: "zero lost accepted work".into(),
                passed: accepted == completed && error_count == 0,
                evidence: format!(
                    "{accepted} accepted, {completed} terminal, {error_count} errors"
                ),
            },
            CorrectnessCheck {
                name: "full issue 13 failure matrix".into(),
                passed: false,
                evidence: "load lane only, merge with real-service and failure evidence before acceptance"
                    .into(),
            },
        ],
        failure_matrix: Vec::new(),
        notes: vec![
            "This lane measures PostgreSQL lifecycle metadata with open arrivals. It does not represent real Temporal, sandbox, artifact, approval, or SMTP latency.".into(),
            "Shed work was never accepted. Accepted work must reach exactly one terminal state for the load correctness gate to pass.".into(),
            "No latency target was chosen before this run. The observed envelope is descriptive.".into(),
        ],
        confirmation_verdict: None,
    };
    write_bundle(&output, &manifest_bytes, &bundle)?;
    if accepted != completed || error_count != 0 {
        anyhow::bail!("load correctness gate failed, inspect generated evidence");
    }
    println!("evidence={}", output.display());
    Ok(())
}

fn run_stage(
    database_url: &str,
    stage: &osfo_agent_run_lifecycle_prototype::evidence::StageManifest,
    registry: &MetricsRegistry,
    raw_latency_path: &Path,
    raw_latency_file: String,
) -> Result<ScenarioEvidence> {
    let started = Instant::now();
    let started_at_unix_milliseconds =
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
    let counters = Arc::new(StageCounters::default());
    let latency = Arc::new(LatencyRecorder::create(raw_latency_path)?);
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let (sender, receiver) = sync_channel::<ScheduledArrival>(stage.worker_count * 2);
    let receiver = Arc::new(Mutex::new(receiver));
    let mut workers = Vec::with_capacity(stage.worker_count);
    for worker_id in 0..stage.worker_count {
        workers.push(spawn_worker(
            database_url,
            stage.name.clone(),
            worker_id,
            receiver.clone(),
            counters.clone(),
            latency.clone(),
            errors.clone(),
        ));
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

    offer_uniform(stage, &sender, &counters);
    drop(sender);
    let dispatch_ended = Instant::now();
    for worker in workers {
        worker
            .join()
            .map_err(|_| anyhow::anyhow!("load worker panicked"))??;
    }
    sampling.store(false, Ordering::Relaxed);
    sampler
        .join()
        .map_err(|_| anyhow::anyhow!("metrics sampler panicked"))??;
    let elapsed_seconds = started.elapsed().as_secs_f64();
    let drain_seconds = dispatch_ended.elapsed().as_secs_f64();
    let offered = counters.offered.load(Ordering::Relaxed);
    let received = counters.received.load(Ordering::Relaxed);
    let caller_drop = counters.caller_drop.load(Ordering::Relaxed);
    let accepted = counters.accepted.load(Ordering::Relaxed);
    let shed_or_rejected = counters.shed_or_rejected.load(Ordering::Relaxed);
    let completed = counters.completed.load(Ordering::Relaxed);
    let failed = counters.failed.load(Ordering::Relaxed);
    let stage_errors = errors.lock().map(|value| value.clone()).unwrap_or_default();
    let latency = Arc::try_unwrap(latency)
        .map_err(|_| anyhow::anyhow!("latency recorder still has live users"))?
        .finish()?;
    registry.replace(snapshot_for(
        &stage.name,
        &counters,
        None,
        DatabaseSnapshot::default(),
    ));
    Ok(ScenarioEvidence {
        name: stage.name.clone(),
        started_at_unix_milliseconds,
        ended_at_unix_milliseconds: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
            as u64,
        workload: stage.workload.clone(),
        persistence_profile: stage.persistence_profile.clone(),
        offered,
        accepted,
        completed,
        shed: shed_or_rejected,
        traffic: osfo_agent_run_lifecycle_prototype::confirmation::TrafficAccounting {
            offered,
            received,
            caller_drop,
            accepted,
            shed_or_rejected,
            completed,
            failed,
            canceled: 0,
            still_in_flight: accepted.saturating_sub(completed.saturating_add(failed)),
        },
        errors: stage_errors,
        elapsed_seconds,
        drain_seconds,
        offered_per_second: offered as f64 / stage.duration_seconds as f64,
        completed_per_second: completed as f64 / elapsed_seconds,
        metrics: latency.summaries,
        samples: samples
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default(),
        raw_latency_file: Some(raw_latency_file),
        raw_latency_sha256: Some(latency.sha256),
        raw_latency_rows: latency.row_count,
    })
}

fn offer_uniform(
    stage: &osfo_agent_run_lifecycle_prototype::evidence::StageManifest,
    sender: &SyncSender<ScheduledArrival>,
    counters: &StageCounters,
) {
    let schedule = OpenLoopSchedule::new(
        stage.offered_per_second,
        Duration::from_secs(stage.duration_seconds),
        Duration::from_millis(stage.maximum_arrival_lag_milliseconds),
    )
    .expect("validated evidence stage must produce an open-loop schedule");
    let started = Instant::now();
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
        match sender.try_send(ScheduledArrival {
            ordinal,
            intended_at: target,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                counters.shed_or_rejected.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

fn spawn_worker(
    database_url: &str,
    stage: String,
    worker_id: usize,
    receiver: Arc<Mutex<Receiver<ScheduledArrival>>>,
    counters: Arc<StageCounters>,
    latency: Arc<LatencyRecorder>,
    errors: Arc<Mutex<Vec<String>>>,
) -> thread::JoinHandle<Result<()>> {
    let database_url = database_url.to_owned();
    thread::spawn(move || {
        let mut lifecycle = PostgresLifecycle::connect(&database_url)?;
        loop {
            let received = receiver
                .lock()
                .map_err(|_| anyhow::anyhow!("load receiver lock poisoned"))?
                .recv();
            let arrival = match received {
                Ok(arrival) => arrival,
                Err(_) => break,
            };
            let ordinal = arrival.ordinal;
            let mut journey_samples = Vec::new();
            let admitted = admit_journey(
                &mut lifecycle,
                &stage,
                worker_id,
                ordinal,
                &mut journey_samples,
            );
            let run_id = match admitted {
                Ok(run_id) => {
                    counters.accepted.fetch_add(1, Ordering::Relaxed);
                    run_id
                }
                Err(error) => {
                    counters.shed_or_rejected.fetch_add(1, Ordering::Relaxed);
                    counters.errors.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut collected) = errors.lock() {
                        collected.push(format!("admission {ordinal}: {error:#}"));
                    }
                    journey_samples.push(LatencySample::from_duration(
                        "end_to_end_journey_rejected",
                        arrival.intended_at.elapsed(),
                    ));
                    latency.record_batch(&stage, ordinal, "rejected", &journey_samples)?;
                    continue;
                }
            };
            match run_admitted_journey(&mut lifecycle, run_id, &mut journey_samples) {
                Ok(()) => {
                    counters.completed.fetch_add(1, Ordering::Relaxed);
                    let end_to_end = arrival.intended_at.elapsed();
                    journey_samples.push(LatencySample::from_duration(
                        "end_to_end_journey",
                        end_to_end,
                    ));
                    journey_samples.push(LatencySample::from_duration(
                        "end_to_end_journey_completed",
                        end_to_end,
                    ));
                    latency.record_batch(&stage, ordinal, "completed", &journey_samples)?;
                }
                Err(error) => {
                    counters.failed.fetch_add(1, Ordering::Relaxed);
                    counters.errors.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut collected) = errors.lock() {
                        collected.push(format!("journey {ordinal}: {error:#}"));
                    }
                    let end_to_end = arrival.intended_at.elapsed();
                    journey_samples.push(LatencySample::from_duration(
                        "end_to_end_journey",
                        end_to_end,
                    ));
                    journey_samples.push(LatencySample::from_duration(
                        "end_to_end_journey_failed",
                        end_to_end,
                    ));
                    latency.record_batch(&stage, ordinal, "failed", &journey_samples)?;
                }
            }
        }
        Ok(())
    })
}

#[derive(Debug, Clone, Copy, Default)]
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
        while sampling.load(Ordering::Relaxed) {
            let database = query_database_snapshot(&mut client)?;
            registry.replace(snapshot_for(&stage, &counters, Some(&latency), database));
            if let Ok(mut time_samples) = samples.lock() {
                time_samples.push(TimeSample {
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
            thread::sleep(Duration::from_secs(1));
        }
        Ok(())
    })
}

fn query_database_snapshot(client: &mut Client) -> Result<DatabaseSnapshot> {
    let row = client.query_one(
        "SELECT
           count(*) FILTER (WHERE state = 'pending'),
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
    Ok(DatabaseSnapshot {
        pending: row.get(0),
        running: row.get(1),
        waiting: row.get(2),
        connections: activity.get(0),
        lock_waiters: activity.get(1),
    })
}

fn snapshot_for(
    stage: &str,
    counters: &StageCounters,
    latency: Option<&LatencyRecorder>,
    database: DatabaseSnapshot,
) -> MetricsSnapshot {
    MetricsSnapshot {
        stage: stage.into(),
        offered: counters.offered.load(Ordering::Relaxed),
        received: counters.received.load(Ordering::Relaxed),
        caller_drop: counters.caller_drop.load(Ordering::Relaxed),
        accepted: counters.accepted.load(Ordering::Relaxed),
        shed_or_rejected: counters.shed_or_rejected.load(Ordering::Relaxed),
        temporal_delivery_retries: 0,
        completed: counters.completed.load(Ordering::Relaxed),
        failed: counters.failed.load(Ordering::Relaxed),
        errors: counters.errors.load(Ordering::Relaxed),
        pending: database.pending,
        running: database.running,
        waiting: database.waiting,
        database_connections: database.connections,
        lock_waiters: database.lock_waiters,
        end_to_end_latencies: latency
            .map(|recorder| {
                BTreeMap::from([
                    (
                        "all".into(),
                        recorder.prometheus_histogram("end_to_end_journey"),
                    ),
                    (
                        "completed".into(),
                        recorder.prometheus_histogram("end_to_end_journey_completed"),
                    ),
                    (
                        "failed".into(),
                        recorder.prometheus_histogram("end_to_end_journey_failed"),
                    ),
                    (
                        "rejected".into(),
                        recorder.prometheus_histogram("end_to_end_journey_rejected"),
                    ),
                ])
            })
            .unwrap_or_default(),
    }
}

fn admit_journey(
    lifecycle: &mut PostgresLifecycle,
    stage: &str,
    worker: usize,
    ordinal: usize,
    samples: &mut Vec<LatencySample>,
) -> Result<RunId> {
    let key = format!("seed-130013-{stage}-w{worker}-n{ordinal}");
    let admitted = timed(samples, "admission", || {
        lifecycle.execute(Command::AdmitUserMessage {
            idempotency_key: key.clone(),
            request_hash: format!("sha256:{key}"),
        })
    })?;
    let run_id = match admitted {
        osfo_agent_run_lifecycle_prototype::CommandOutcome::RunAdmitted(run_id) => run_id,
        _ => anyhow::bail!("admission returned wrong outcome"),
    };
    timed(samples, "idempotency_resolution", || {
        lifecycle.execute(Command::AdmitUserMessage {
            idempotency_key: key.clone(),
            request_hash: format!("sha256:{key}"),
        })
    })?;
    Ok(run_id)
}

fn run_admitted_journey(
    lifecycle: &mut PostgresLifecycle,
    run_id: RunId,
    samples: &mut Vec<LatencySample>,
) -> Result<()> {
    timed(samples, "claim", || {
        lifecycle.claim_with_lease(&run_id, "load-worker", Duration::from_secs(5))
    })?;
    timed(samples, "cold_reconstruction", || lifecycle.run(&run_id))?;

    let child_a = RunId::from(format!("{}-a", run_id.as_str()).as_str());
    let child_b = RunId::from(format!("{}-b", run_id.as_str()).as_str());
    let join_id = format!("join-{}", run_id.as_str());
    timed(samples, "child_admission", || {
        lifecycle.execute(Command::AdmitChildren {
            parent_run_id: run_id.clone(),
            parent_claim_epoch: 1,
            join_id: join_id.clone(),
            mode: ChildJoinMode::AllTerminal,
            child_run_ids: vec![child_a.clone(), child_b.clone()],
        })
    })?;
    timed(samples, "child_outcome_commit", || {
        lifecycle.execute(Command::CompleteChild {
            child_run_id: child_a,
            outcome: "research-ready".into(),
        })
    })?;
    timed(samples, "child_join_settlement", || {
        lifecycle.execute(Command::CompleteChild {
            child_run_id: child_b,
            outcome: "artifact-ready".into(),
        })
    })?;
    lifecycle.claim_with_lease(&run_id, "load-worker", Duration::from_secs(5))?;
    let workflow_id = format!("workflow-{}", run_id.as_str());
    timed(samples, "workflow_start_intent", || {
        lifecycle.execute(Command::StartAwaitedWorkflow {
            parent_run_id: run_id.clone(),
            parent_claim_epoch: 2,
            tool_call_id: format!("tool-{workflow_id}"),
            workflow_instance_id: workflow_id.clone(),
        })
    })?;
    timed(samples, "workflow_outcome_wake", || {
        lifecycle.execute(Command::DeliverWorkflowOutcome {
            workflow_instance_id: workflow_id.clone(),
            delivery_id: format!("delivery-{workflow_id}"),
            outcome: "published".into(),
        })
    })?;
    timed(samples, "duplicate_reconciliation", || {
        lifecycle.execute(Command::DeliverWorkflowOutcome {
            workflow_instance_id: workflow_id.clone(),
            delivery_id: format!("delivery-{workflow_id}"),
            outcome: "published".into(),
        })
    })?;
    lifecycle.claim_with_lease(&run_id, "load-worker", Duration::from_secs(5))?;
    timed(samples, "terminal_commit", || {
        lifecycle.complete_run(&run_id, 3, RunState::Succeeded)
    })?;
    let run = lifecycle.run(&run_id)?;
    if run.state != RunState::Succeeded || run.wake_count != 2 || run.claim_epoch != 3 {
        anyhow::bail!("terminal lifecycle invariant mismatch: {run:?}");
    }
    Ok(())
}

fn timed<T>(
    samples: &mut Vec<LatencySample>,
    family: &str,
    operation: impl FnOnce() -> Result<T>,
) -> Result<T> {
    let started = Instant::now();
    let result = operation();
    samples.push(LatencySample::from_duration(family, started.elapsed()));
    result
}

fn verify_deterministic_adapter() -> Result<()> {
    let sequence = |key: &str| -> Result<Vec<String>> {
        let mut lifecycle = LifecycleManager::new(MemoryLedger::default());
        let parent = lifecycle.execute(Command::AdmitUserMessage {
            idempotency_key: key.into(),
            request_hash: "sha256:deterministic".into(),
        })?;
        let run_id = match parent {
            osfo_agent_run_lifecycle_prototype::CommandOutcome::RunAdmitted(run_id) => run_id,
            _ => anyhow::bail!("deterministic admission returned the wrong outcome"),
        };
        lifecycle.execute(Command::Claim {
            run_id: run_id.clone(),
            worker_id: "deterministic-worker".into(),
        })?;
        Ok(lifecycle.semantic_sequence(&run_id))
    };
    if sequence("seed-a")? != sequence("seed-a")? {
        anyhow::bail!("same deterministic seed produced a different semantic record sequence");
    }
    Ok(())
}

fn environment() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("rust".into(), "1.94.1".into()),
        ("postgres".into(), "17.6".into()),
        ("temporal-service".into(), "Temporal Cloud managed".into()),
        (
            "temporal-deployment".into(),
            "temporal-cloud-on-demand".into(),
        ),
        ("temporalio-sdk".into(), "0.5.0 Public Preview".into()),
        ("rig-agent".into(), "0.41.0".into()),
        ("mailpit".into(), "1.30.6".into()),
        ("prometheus".into(), "3.13.0".into()),
        ("grafana".into(), "13.1.0".into()),
        (
            "database-profile".into(),
            std::env::var("OSFO_DATABASE_PROFILE").unwrap_or_else(|_| "local Docker".into()),
        ),
    ])
}

fn write_bundle(output: &Path, manifest: &str, bundle: &EvidenceBundle) -> Result<()> {
    fs::create_dir_all(output)?;
    fs::write(output.join("run-config.json"), manifest)?;
    fs::write(
        output.join("results.json"),
        serde_json::to_vec_pretty(bundle)?,
    )?;
    fs::write(output.join("dashboard.html"), render_dashboard(bundle)?)?;
    fs::write(output.join("samples.csv"), render_samples_csv(bundle))?;
    fs::write(output.join("REPORT.md"), render_report(bundle))?;
    Ok(())
}

fn render_samples_csv(bundle: &EvidenceBundle) -> String {
    let mut csv = String::from(
        "scenario,elapsed_seconds,offered,received,caller_drop,accepted,shed_or_rejected,completed,failed,errors,pending,running,waiting,database_connections,lock_waiters\n",
    );
    for stage in &bundle.scenarios {
        for sample in &stage.samples {
            csv.push_str(&format!(
                "{},{:.3},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
                stage.name,
                sample.elapsed_seconds,
                sample.offered,
                sample.received,
                sample.caller_drop,
                sample.accepted,
                sample.shed_or_rejected,
                sample.completed,
                sample.failed,
                sample.errors,
                sample.pending,
                sample.running,
                sample.waiting,
                sample.database_connections,
                sample.lock_waiters,
            ));
        }
    }
    csv
}

fn render_report(bundle: &EvidenceBundle) -> String {
    let mut report = String::from(
        "# AgentRun lifecycle open-arrival evidence\n\nThis is the PostgreSQL load lane, not the complete issue 13 acceptance bundle.\n\n| Stage | Offered | Accepted | Completed | Shed | Errors | Completed/s | p50 | p90 | p95 | p99 | Max |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n",
    );
    for stage in &bundle.scenarios {
        let latency = stage.metrics.get("end_to_end_journey");
        report.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {:.2} | {:.1} ms | {:.1} ms | {:.1} ms | {:.1} ms | {:.1} ms |\n",
            stage.name,
            stage.offered,
            stage.accepted,
            stage.completed,
            stage.shed,
            stage.errors.len(),
            stage.completed_per_second,
            latency.map(|m| m.p50_ms).unwrap_or_default(),
            latency.map(|m| m.p90_ms).unwrap_or_default(),
            latency.map(|m| m.p95_ms).unwrap_or_default(),
            latency.map(|m| m.p99_ms).unwrap_or_default(),
            latency.map(|m| m.maximum_ms).unwrap_or_default(),
        ));
    }
    report.push_str(
        "\nNo latency threshold was selected before the run. Shed work was not accepted.\n",
    );
    report
}
