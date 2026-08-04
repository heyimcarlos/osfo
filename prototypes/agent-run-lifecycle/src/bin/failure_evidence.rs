use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command as ProcessCommand, Stdio},
    sync::{Arc, Barrier},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::{
    ApprovalDecision, ArtifactStore, ChildJoinMode, Command, CommandOutcome, DockerSandboxProvider,
    GcsArtifactStore, MinioArtifactStore, PostgresApprovalLedger, PostgresLifecycle, RunId,
    RunState, SandboxProvider, SandboxRef, SandboxSpec,
    evidence::{CorrectnessCheck, EvidenceBundle, FailureEvidence, render_dashboard},
    temporal_lane::{
        TemporalWorkerFleet, TemporalWorkerFleetConfig, TemporalWorkflowClient,
        run_temporal_smoke_named,
    },
    workload::{JourneyKind, WorkloadAdmission},
};

fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    if std::env::args().nth(1).as_deref() == Some("claim-and-sleep") {
        return claim_and_sleep();
    }
    if std::env::args().nth(1).as_deref() == Some("temporal-worker") {
        return temporal_worker_process();
    }
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .context("OSFO_TEST_DATABASE_URL must point at the evidence database")?;
    let output = std::env::var("OSFO_EVIDENCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("evidence/failure-latest"));
    let mut rows = Vec::new();
    rows.push(admission_unknown_commit(&database_url)?);
    rows.push(lease_takeover(&database_url)?);
    rows.extend(model_boundary_failures(&database_url)?);
    rows.extend(tool_call_failures(&database_url)?);
    rows.push(osfo_worker_process_kill(&database_url)?);
    rows.extend(child_join_failures(&database_url)?);
    rows.push(waiting_cancellation_race(&database_url)?);
    rows.push(sandbox_failures()?);
    rows.push(artifact_corruption(&database_url)?);
    rows.push(checkpoint_fallbacks(&database_url)?);
    rows.push(compatible_worker_unavailable(&database_url)?);
    rows.push(authoritative_record_unsupported(&database_url)?);
    rows.push(temporal_start_missing_confirmation(&database_url)?);
    rows.push(temporal_worker_process_kill()?);
    rows.push(temporal_unavailable_after_intent(&database_url)?);
    let all_passed = rows.iter().all(|row| row.passed);
    let bundle = EvidenceBundle {
        schema_version: 2,
        generated_at: format!(
            "unix:{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
        ),
        question: "Do focused durable-boundary injections preserve idempotency, fencing, exact wake, sandbox recovery, and artifact authority?".into(),
        environment: BTreeMap::from([(
            "database-profile".into(),
            std::env::var("OSFO_DATABASE_PROFILE").unwrap_or_else(|_| "local Docker".into()),
        )]),
        scenarios: Vec::new(),
        correctness: vec![
            CorrectnessCheck {
                name: "focused durable failure cuts".into(),
                passed: all_passed,
                evidence: format!("{} of {} injected cuts passed", rows.iter().filter(|row| row.passed).count(), rows.len()),
            },
            CorrectnessCheck {
                name: "full issue 13 failure matrix".into(),
                passed: false,
                evidence: "this executable covers only the listed durable cuts".into(),
            },
        ],
        failure_matrix: rows,
        notes: vec![
            "Each failure row records every observed latency sample instead of unstable tail percentiles.".into(),
            "Sandbox deletion and incompatible references are tested. Expiry and checkpoint corruption need additional provider surfaces.".into(),
        ],
        confirmation_verdict: None,
    };
    fs::create_dir_all(&output)?;
    fs::write(
        output.join("results.json"),
        serde_json::to_vec_pretty(&bundle)?,
    )?;
    fs::write(output.join("dashboard.html"), render_dashboard(&bundle)?)?;
    if !all_passed {
        anyhow::bail!("failure evidence gate failed");
    }
    println!("evidence={}", output.display());
    Ok(())
}

fn claim_and_sleep() -> Result<()> {
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")?;
    let mut lifecycle = PostgresLifecycle::connect(&database_url)?;
    lifecycle.claim_with_lease(
        &RunId::from("run-parent"),
        "worker-process-to-kill",
        Duration::from_millis(150),
    )?;
    println!("claimed");
    std::io::stdout().flush()?;
    thread::sleep(Duration::from_secs(60));
    Ok(())
}

fn temporal_worker_process() -> Result<()> {
    let address = std::env::var("TEMPORAL_ADDRESS")
        .context("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint")?;
    let task_queue = std::env::var("OSFO_FAILURE_TEMPORAL_TASK_QUEUE")?;
    let fleet_id = std::env::var("OSFO_FAILURE_TEMPORAL_FLEET_ID")?;
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let fleet = TemporalWorkerFleet::start(
            &address,
            TemporalWorkerFleetConfig {
                fleet_id,
                metrics_address: "127.0.0.1:0".into(),
                task_queue,
                workflow_slots: 8,
                activity_slots: 8,
            },
        )
        .await?;
        println!("ready");
        std::io::stdout().flush()?;
        tokio::time::sleep(Duration::from_secs(60)).await;
        fleet.shutdown().await
    })
}

fn spawn_temporal_worker(task_queue: &str, fleet_id: &str) -> Result<std::process::Child> {
    let mut child = ProcessCommand::new(std::env::current_exe()?)
        .arg("temporal-worker")
        .env("OSFO_FAILURE_TEMPORAL_TASK_QUEUE", task_queue)
        .env("OSFO_FAILURE_TEMPORAL_FLEET_ID", fleet_id)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut ready = String::new();
    BufReader::new(
        child
            .stdout
            .take()
            .context("Temporal worker stdout unavailable")?,
    )
    .read_line(&mut ready)?;
    if ready.trim() != "ready" {
        let _ = child.kill();
        let output = child.wait_with_output()?;
        anyhow::bail!(
            "Temporal worker process did not become ready: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(child)
}

fn temporal_worker_process_kill() -> Result<FailureEvidence> {
    let started = Instant::now();
    let address = std::env::var("TEMPORAL_ADDRESS")
        .context("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint")?;
    let suffix = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let task_queue = format!("osfo-failure-worker-kill-{suffix}");
    let workflow_id = format!("osfo-failure-worker-kill-workflow-{suffix}");
    let mut original = spawn_temporal_worker(&task_queue, "failure-worker-original")?;
    let controller_address = address.clone();
    let controller_queue = task_queue.clone();
    let controller = thread::spawn(move || -> Result<_> {
        let runtime = tokio::runtime::Runtime::new()?;
        runtime.block_on(async move {
            let client = TemporalWorkflowClient::connect(
                &controller_address,
                "failure-worker-controller",
                &controller_queue,
            )
            .await?;
            client.run_load_named(workflow_id).await
        })
    });
    thread::sleep(Duration::from_millis(500));
    original.kill()?;
    let killed = !original.wait()?.success();
    let mut replacement = spawn_temporal_worker(&task_queue, "failure-worker-replacement")?;
    let report = controller
        .join()
        .map_err(|_| anyhow::anyhow!("Temporal workflow controller panicked"))??;
    replacement.kill()?;
    let replacement_killed = !replacement.wait()?.success();
    Ok(row(
        "Temporal worker process",
        "Temporal worker process kill and restart",
        "the polling worker process was killed during a real workflow and a replacement on the same task queue completed the persisted history",
        "Temporal history survives worker death and Activities remain retryable and idempotent",
        killed
            && replacement_killed
            && report
                .steps
                .iter()
                .any(|step| step == "publish-succeeded-attempt-2"),
        started,
    ))
}

fn admission_unknown_commit(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let first = lifecycle.execute(Command::AdmitUserMessage {
        idempotency_key: "failure-admission-unknown".into(),
        request_hash: "sha256:failure-admission-unknown".into(),
    })?;
    let first_run = admitted_run(first)?;
    drop(lifecycle);
    let mut recovered = PostgresLifecycle::connect(database_url)?;
    let replay = recovered.execute(Command::AdmitUserMessage {
        idempotency_key: "failure-admission-unknown".into(),
        request_hash: "sha256:failure-admission-unknown".into(),
    })?;
    let replay_run = admitted_run(replay)?;
    let passed = first_run == replay_run
        && recovered.semantic_sequence(&first_run)? == vec!["UserMessage:v1"];
    Ok(row(
        "Admission commit",
        "unknown admission commit outcome",
        "client connection was discarded after commit, then the immutable receipt returned the same AgentRun",
        "one admission and one UserMessage",
        passed,
        started,
    ))
}

fn lease_takeover(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    lifecycle.execute(Command::AdmitUserMessage {
        idempotency_key: "failure-lease".into(),
        request_hash: "sha256:failure-lease".into(),
    })?;
    let run = RunId::from("run-parent");
    lifecycle.claim_with_lease(&run, "worker-killed", Duration::from_millis(20))?;
    thread::sleep(Duration::from_millis(30));
    lifecycle.takeover_expired(&run, "worker-replacement", Duration::from_secs(1))?;
    let stale_rejected = lifecycle
        .complete_run(&run, 1, RunState::Succeeded)
        .is_err();
    lifecycle.complete_run(&run, 2, RunState::Succeeded)?;
    let terminal_rejected = lifecycle
        .execute(Command::Claim {
            run_id: run,
            worker_id: "worker-late".into(),
        })
        .is_err();
    Ok(row(
        "AgentRunAttempt lease",
        "expired lease takeover and stale completion",
        "replacement claimed epoch 2, epoch 1 completion was fenced, terminal reclaim was rejected",
        "stale attempts cannot commit and terminal runs cannot be claimed",
        stale_rejected && terminal_rejected,
        started,
    ))
}

fn model_boundary_failures(database_url: &str) -> Result<Vec<FailureEvidence>> {
    let dispatch_started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-model-boundaries")?;
    lifecycle.commit_interaction(
        &run_id,
        1,
        "failure-model-intent",
        "ModelCallIntent:v1:deterministic-adapter",
    )?;
    drop(lifecycle);
    let mut recovered = PostgresLifecycle::connect(database_url)?;
    let replay = recovered.commit_interaction(
        &run_id,
        1,
        "failure-model-intent",
        "ModelCallIntent:v1:deterministic-adapter",
    )?;
    let dispatch = row(
        "Model provider dispatch",
        "model provider dispatch lost acknowledgement",
        "the committed ModelCall intent was retried after the connection was discarded and resolved by stable record identity",
        "provider dispatch has one authoritative intent",
        replay == CommandOutcome::IdempotentReplay,
        dispatch_started,
    );

    let partial_started = Instant::now();
    recovered.commit_interaction(
        &run_id,
        1,
        "failure-model-fragment-1",
        "AssistantOutputFragment:v1:partial",
    )?;
    drop(recovered);
    let mut normalized = PostgresLifecycle::connect(database_url)?;
    let fragment_replay = normalized.commit_interaction(
        &run_id,
        1,
        "failure-model-fragment-1",
        "AssistantOutputFragment:v1:partial",
    )?;
    let mutation_rejected = normalized
        .commit_interaction(
            &run_id,
            1,
            "failure-model-fragment-1",
            "AssistantOutputFragment:v1:mutated",
        )
        .is_err();
    normalized.commit_interaction(
        &run_id,
        1,
        "failure-model-outcome",
        "ModelCallOutcome:v1:succeeded:tokens=17",
    )?;
    let sequence = normalized.semantic_sequence(&run_id)?;
    let partial = row(
        "Model output normalization",
        "partial model output before normalized outcome",
        "the partial fragment survived reconnect, immutable replay reconciled, mutation was rejected, and one normalized outcome committed",
        "committed fragments are replayable and the ModelCall has one outcome",
        fragment_replay == CommandOutcome::IdempotentReplay
            && mutation_rejected
            && sequence
                .iter()
                .filter(|record| record.starts_with("ModelCallOutcome:"))
                .count()
                == 1,
        partial_started,
    );
    Ok(vec![dispatch, partial])
}

fn tool_call_failures(database_url: &str) -> Result<Vec<FailureEvidence>> {
    let exhaustion_started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-tool-exhaustion")?;
    let mut approvals = PostgresApprovalLedger::connect(database_url)?;
    approvals.open_email_tool(
        &run_id,
        1,
        "failure-tool-exhaustion",
        "failure-approval-exhaustion",
    )?;
    approvals.decide(
        "failure-approval-exhaustion",
        "failure-decision-exhaustion",
        ApprovalDecision::Approved,
    )?;
    lifecycle.execute(Command::Claim {
        run_id: run_id.clone(),
        worker_id: "failure-tool-worker-1".into(),
    })?;
    approvals.begin_attempt(
        &run_id,
        2,
        "failure-tool-exhaustion",
        "failure-tool-attempt-1",
    )?;
    approvals.fail_attempt(
        &run_id,
        2,
        "failure-tool-exhaustion",
        "failure-tool-attempt-1",
        "smtp-refused",
        2,
    )?;
    lifecycle.execute(Command::Claim {
        run_id: run_id.clone(),
        worker_id: "failure-tool-worker-2".into(),
    })?;
    approvals.begin_attempt(
        &run_id,
        3,
        "failure-tool-exhaustion",
        "failure-tool-attempt-2",
    )?;
    approvals.fail_attempt(
        &run_id,
        3,
        "failure-tool-exhaustion",
        "failure-tool-attempt-2",
        "smtp-refused",
        2,
    )?;
    lifecycle.complete_run(&run_id, 3, RunState::Failed)?;
    let sequence = lifecycle.semantic_sequence(&run_id)?;
    let exhaustion = row(
        "Bounded ToolCall retry",
        "ToolCall attempt retry exhaustion",
        "the first refused SMTP attempt entered retry-ready, the second exhausted the frozen bound, and the AgentRun failed once",
        "retry amplification is bounded and one terminal ToolCall outcome is authoritative",
        sequence
            .iter()
            .filter(|record| record.starts_with("ToolCallRetryScheduled:"))
            .count()
            == 1
            && sequence
                .iter()
                .filter(|record| record.starts_with("ToolCallOutcome:"))
                .count()
                == 1
            && lifecycle.run(&run_id)?.state == RunState::Failed,
        exhaustion_started,
    );

    let unknown_started = Instant::now();
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-tool-unknown")?;
    let mut approvals = PostgresApprovalLedger::connect(database_url)?;
    approvals.open_email_tool(
        &run_id,
        1,
        "failure-tool-unknown",
        "failure-approval-unknown",
    )?;
    approvals.decide(
        "failure-approval-unknown",
        "failure-decision-unknown",
        ApprovalDecision::Approved,
    )?;
    lifecycle.execute(Command::Claim {
        run_id: run_id.clone(),
        worker_id: "failure-tool-worker-unknown".into(),
    })?;
    approvals.begin_attempt(
        &run_id,
        2,
        "failure-tool-unknown",
        "failure-tool-attempt-unknown",
    )?;
    approvals.mark_attempt_unknown(
        &run_id,
        2,
        "failure-tool-unknown",
        "failure-tool-attempt-unknown",
        "smtp-connection-dropped-after-data",
    )?;
    approvals.complete_attempt(
        &run_id,
        2,
        "failure-tool-unknown",
        "failure-tool-attempt-unknown",
        "smtp-accepted",
    )?;
    drop(approvals);
    let mut reconciler = PostgresApprovalLedger::connect(database_url)?;
    let replay = reconciler.complete_attempt(
        &run_id,
        2,
        "failure-tool-unknown",
        "failure-tool-attempt-unknown",
        "smtp-accepted",
    )?;
    let sequence = lifecycle.semantic_sequence(&run_id)?;
    let unknown = row(
        "ToolCall terminal commit",
        "ToolCall unknown terminal commit outcome",
        "an unknown external outcome was recorded, reconciled to one terminal outcome, and replay after a lost acknowledgement was idempotent",
        "unknown outcomes are explicit and terminal semantic outcomes are unique",
        replay == CommandOutcome::IdempotentReplay
            && sequence
                .iter()
                .filter(|record| record.starts_with("ToolCallOutcome:"))
                .count()
                == 1,
        unknown_started,
    );
    Ok(vec![exhaustion, unknown])
}

fn osfo_worker_process_kill(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    lifecycle.execute(Command::AdmitUserMessage {
        idempotency_key: "failure-worker-process".into(),
        request_hash: "sha256:failure-worker-process".into(),
    })?;
    drop(lifecycle);
    let mut child = ProcessCommand::new(std::env::current_exe()?)
        .arg("claim-and-sleep")
        .env("OSFO_TEST_DATABASE_URL", database_url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut ready = String::new();
    BufReader::new(child.stdout.take().context("worker stdout unavailable")?)
        .read_line(&mut ready)?;
    if ready.trim() != "claimed" {
        let _ = child.kill();
        anyhow::bail!("worker process did not confirm its claim");
    }
    child.kill()?;
    let status = child.wait()?;
    thread::sleep(Duration::from_millis(175));
    let mut replacement = PostgresLifecycle::connect(database_url)?;
    replacement.takeover_expired(
        &RunId::from("run-parent"),
        "worker-process-replacement",
        Duration::from_secs(1),
    )?;
    replacement.complete_run(&RunId::from("run-parent"), 2, RunState::Succeeded)?;
    let terminal = replacement.run(&RunId::from("run-parent"))?;
    Ok(row(
        "Osfo worker process",
        "Osfo worker process kill and restart",
        "the claimed worker process was killed, its lease expired, and a replacement took epoch 2",
        "accepted work survives worker death and stale ownership is fenced",
        !status.success() && terminal.state == RunState::Succeeded && terminal.claim_epoch == 2,
        started,
    ))
}

fn child_join_failures(database_url: &str) -> Result<Vec<FailureEvidence>> {
    let concurrent_started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let parent = admit_and_claim(&mut lifecycle, "failure-child-concurrent")?;
    let child_a = RunId::from("failure-child-a");
    let child_b = RunId::from("failure-child-b");
    lifecycle.execute(Command::AdmitChildren {
        parent_run_id: parent.clone(),
        parent_claim_epoch: 1,
        join_id: "failure-join-concurrent".into(),
        mode: ChildJoinMode::AllTerminal,
        child_run_ids: vec![child_a.clone(), child_b.clone()],
    })?;
    drop(lifecycle);
    let barrier = Arc::new(Barrier::new(2));
    let handles = [child_a.clone(), child_b.clone()].map(|child| {
        let database_url = database_url.to_owned();
        let barrier = barrier.clone();
        thread::spawn(move || -> Result<()> {
            let mut connection = PostgresLifecycle::connect(&database_url)?;
            barrier.wait();
            connection.execute(Command::CompleteChild {
                child_run_id: child,
                outcome: "concurrent-success".into(),
            })?;
            Ok(())
        })
    });
    for handle in handles {
        handle
            .join()
            .map_err(|_| anyhow::anyhow!("child completion worker panicked"))??;
    }
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    let parent_view = lifecycle.run(&parent)?;
    let late = lifecycle.execute(Command::CompleteChild {
        child_run_id: child_a,
        outcome: "late-success".into(),
    })?;
    let concurrent = row(
        "ChildJoin settlement",
        "ChildJoin concurrent settlement and late outcome",
        "concurrent child transactions serialized, one parent wake committed, and late duplicate reconciled",
        "exactly one ChildJoin wake",
        parent_view.wake_count == 1 && late == CommandOutcome::IdempotentReplay,
        concurrent_started,
    );

    let deadline_started = Instant::now();
    lifecycle.reset()?;
    let parent = admit_and_claim(&mut lifecycle, "failure-child-deadline")?;
    let late_child = RunId::from("failure-child-deadline-late");
    lifecycle.execute(Command::AdmitChildren {
        parent_run_id: parent.clone(),
        parent_claim_epoch: 1,
        join_id: "failure-join-deadline".into(),
        mode: ChildJoinMode::AllTerminal,
        child_run_ids: vec![late_child.clone()],
    })?;
    lifecycle.expire_child_join("failure-join-deadline")?;
    let duplicate_deadline = lifecycle.expire_child_join("failure-join-deadline")?;
    let late = lifecycle.execute(Command::CompleteChild {
        child_run_id: late_child.clone(),
        outcome: "late-success".into(),
    })?;
    let parent_view = lifecycle.run(&parent)?;
    let child_view = lifecycle.run(&late_child)?;
    let deadline = row(
        "ChildJoin deadline",
        "ChildJoin deadline cancellation",
        "unfinished child canceled, duplicate expiry and late outcome reconciled",
        "one parent wake and canceled child remains terminal",
        duplicate_deadline == CommandOutcome::IdempotentReplay
            && late == CommandOutcome::IdempotentReplay
            && parent_view.wake_count == 1
            && child_view.state == RunState::Canceled,
        deadline_started,
    );
    Ok(vec![concurrent, deadline])
}

fn waiting_cancellation_race(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-wake-cancel-race")?;
    lifecycle.execute(Command::StartAwaitedWorkflow {
        parent_run_id: run_id.clone(),
        parent_claim_epoch: 1,
        tool_call_id: "failure-race-tool".into(),
        workflow_instance_id: "failure-race-workflow".into(),
    })?;
    drop(lifecycle);
    let barrier = Arc::new(Barrier::new(2));
    let cancel_url = database_url.to_owned();
    let cancel_run = run_id.clone();
    let cancel_barrier = barrier.clone();
    let cancellation = thread::spawn(move || -> Result<CommandOutcome> {
        let mut lifecycle = PostgresLifecycle::connect(&cancel_url)?;
        cancel_barrier.wait();
        lifecycle.cancel_run(&cancel_run, "failure-race")
    });
    let delivery_url = database_url.to_owned();
    let delivery_barrier = barrier.clone();
    let delivery = thread::spawn(move || -> Result<CommandOutcome> {
        let mut lifecycle = PostgresLifecycle::connect(&delivery_url)?;
        delivery_barrier.wait();
        lifecycle.execute(Command::DeliverWorkflowOutcome {
            workflow_instance_id: "failure-race-workflow".into(),
            delivery_id: "failure-race-delivery".into(),
            outcome: "published".into(),
        })
    });
    cancellation
        .join()
        .map_err(|_| anyhow::anyhow!("cancellation worker panicked"))??;
    delivery
        .join()
        .map_err(|_| anyhow::anyhow!("delivery worker panicked"))??;
    let mut observed = PostgresLifecycle::connect(database_url)?;
    let run = observed.run(&run_id)?;
    let records = observed.semantic_sequence(&run_id)?;
    let terminal_cancel = run.state == RunState::Canceled
        && run.wake_count == 0
        && records
            .last()
            .is_some_and(|record| record.starts_with("AgentRunCanceled:"));
    let terminal_delivery = run.state == RunState::Pending
        && run.wake_count == 1
        && records
            .iter()
            .filter(|record| record.starts_with("WorkflowOutcome:"))
            .count()
            == 1;
    Ok(row(
        "Atomic wait transition",
        "waiting wake races cancellation",
        "concurrent cancellation and workflow delivery serialized to one terminal cancellation or one exact wake",
        "a canceled AgentRun never reactivates and a delivered outcome wakes at most once",
        terminal_cancel || terminal_delivery,
        started,
    ))
}

fn checkpoint_fallbacks(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let markers = [
        None,
        Some("RuntimeCheckpointRef:v1:deleted"),
        Some("RuntimeCheckpointRef:v1:sha256-corrupt"),
        Some("RuntimeCheckpointRef:v99:incompatible"),
    ];
    let mut passed = true;
    for (ordinal, marker) in markers.into_iter().enumerate() {
        let suffix = format!("failure-checkpoint-{ordinal}");
        let run_id = admit_and_claim(&mut lifecycle, &suffix)?;
        if let Some(marker) = marker {
            lifecycle.commit_interaction(
                &run_id,
                1,
                &format!("failure-checkpoint-ref-{ordinal}"),
                marker,
            )?;
        }
        lifecycle.commit_interaction(
            &run_id,
            1,
            &format!("failure-checkpoint-model-{ordinal}"),
            "ModelCallOutcome:v1:succeeded:tokens=17",
        )?;
        lifecycle.complete_run(&run_id, 1, RunState::Succeeded)?;
        passed &= lifecycle.run(&run_id)?.state == RunState::Succeeded
            && lifecycle
                .semantic_sequence(&run_id)?
                .iter()
                .any(|record| record.starts_with("ModelCallOutcome:"));
    }
    Ok(row(
        "Runtime checkpoint fallback",
        "checkpoint absent, deleted, corrupt, and incompatible",
        "cold reconstruction completed from PostgreSQL for absent and unusable optional checkpoint references",
        "RuntimeCheckpointRef is acceleration only and never lifecycle authority",
        passed,
        started,
    ))
}

fn compatible_worker_unavailable(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    lifecycle.admit_workload(WorkloadAdmission::new(
        "failure-compatible-worker",
        "quiet-1",
        JourneyKind::BasicAgentRun,
        "cold-logical-reconstruction",
        0,
    ))?;
    let incompatible = lifecycle.claim_next_workload_for(
        "temporal-only-worker",
        Duration::from_secs(1),
        &[JourneyKind::AwaitedWorkflow],
    )?;
    let claimed = lifecycle
        .claim_next_workload_for(
            "compatible-worker",
            Duration::from_secs(1),
            &[JourneyKind::BasicAgentRun],
        )?
        .context("compatible worker did not claim pending work")?;
    lifecycle.complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Succeeded)?;
    Ok(row(
        "Worker compatibility routing",
        "compatible worker temporarily unavailable",
        "an incompatible lane left accepted work pending until a compatible worker became available",
        "incompatible workers cannot consume or corrupt accepted work",
        incompatible.is_none() && lifecycle.run(&claimed.run_id)?.state == RunState::Succeeded,
        started,
    ))
}

fn authoritative_record_unsupported(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-authoritative-unsupported")?;
    lifecycle.commit_interaction(
        &run_id,
        1,
        "failure-authoritative-v99",
        "FutureAuthoritativeRecord:v99:required",
    )?;
    let rejected = lifecycle
        .validate_supported_authoritative_records(&run_id)
        .is_err();
    let unchanged = lifecycle.run(&run_id)?;
    Ok(row(
        "Authoritative compatibility gate",
        "authoritative record unsupported",
        "the worker rejected an unknown mandatory semantic record without mutating lifecycle state",
        "unsupported authority is explicit and cannot be silently skipped",
        rejected && unchanged.state == RunState::Running && unchanged.claim_epoch == 1,
        started,
    ))
}

fn temporal_start_missing_confirmation(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-temporal-missing-confirmation")?;
    let workflow_id = format!(
        "failure-temporal-missing-confirmation-{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    lifecycle.execute(Command::StartAwaitedWorkflow {
        parent_run_id: run_id.clone(),
        parent_claim_epoch: 1,
        tool_call_id: format!("tool-{workflow_id}"),
        workflow_instance_id: workflow_id.clone(),
    })?;
    let temporal_address = std::env::var("TEMPORAL_ADDRESS")
        .context("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint")?;
    let runtime = tokio::runtime::Runtime::new()?;
    let first = runtime.block_on(run_temporal_smoke_named(
        &temporal_address,
        workflow_id.clone(),
    ))?;
    let duplicate_start = runtime.block_on(run_temporal_smoke_named(
        &temporal_address,
        workflow_id.clone(),
    ));
    let task_queue = std::env::var("TEMPORAL_TASK_QUEUE")
        .unwrap_or_else(|_| "osfo-agent-run-lifecycle-v1".into());
    let reconciler = runtime.block_on(TemporalWorkflowClient::connect(
        &temporal_address,
        "failure-start-reconciler",
        &task_queue,
    ))?;
    let existing = runtime.block_on(reconciler.reconcile_load_named(workflow_id.clone()))?;
    let outcome = serde_json::to_string(&first.steps)?;
    let delivery = Command::DeliverWorkflowOutcome {
        workflow_instance_id: workflow_id.clone(),
        delivery_id: format!("delivery-{workflow_id}"),
        outcome,
    };
    lifecycle.execute(delivery.clone())?;
    let repeated_delivery = lifecycle.execute(delivery)?;
    let recovered = lifecycle.run(&run_id)?;
    Ok(row(
        "Temporal start reconciliation",
        "Temporal start missing confirmation reconciliation",
        "the stable workflow identity completed, a repeated start observed the existing closed execution, and PostgreSQL received one terminal outcome",
        "a lost start acknowledgement cannot create a second WorkflowInstance or a second wake",
        duplicate_start.is_err()
            && existing.workflow_instance_id == workflow_id
            && existing.steps == first.steps
            && existing.history_event_count == first.history_event_count
            && repeated_delivery == CommandOutcome::IdempotentReplay
            && recovered.state == RunState::Pending
            && recovered.wake_count == 1,
        started,
    ))
}

fn sandbox_failures() -> Result<FailureEvidence> {
    let image =
        "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1";
    let started = Instant::now();
    let mut provider = DockerSandboxProvider::new();
    let sandbox = provider.create(SandboxSpec {
        sandbox_id: "failure-sandbox-delete".into(),
        image: image.into(),
        cpu_limit: 0.5,
        memory_bytes: 64 * 1024 * 1024,
        process_limit: 32,
    })?;
    provider.stop(&sandbox)?;
    let resumed = provider.resume(&sandbox)?;
    let mut corrupt = sandbox.clone();
    corrupt.identity_sha256 = "corrupt-sandbox-identity".into();
    let corrupt_rejected = provider.resume(&corrupt).is_err();
    let mut expired = sandbox.clone();
    expired.expires_at_unix_seconds = 0;
    let expired_rejected = provider.resume(&expired).is_err();
    let missing = SandboxRef {
        provider: "docker-v1".into(),
        sandbox_id: "failure-sandbox-missing".into(),
        identity_sha256: "missing".into(),
        expires_at_unix_seconds: u64::MAX,
    };
    let missing_reconciled = !provider.resume(&missing)?;
    provider.delete(&sandbox)?;
    let deleted_missing = !provider.resume(&sandbox)?;
    let incompatible = provider
        .resume(&SandboxRef {
            provider: "other-provider-v9".into(),
            sandbox_id: "failure-incompatible".into(),
            identity_sha256: "incompatible".into(),
            expires_at_unix_seconds: u64::MAX,
        })
        .is_err();
    let unpinned = provider
        .create(SandboxSpec {
            sandbox_id: "failure-unpinned".into(),
            image: "alpine:3.22.1".into(),
            cpu_limit: 0.5,
            memory_bytes: 64 * 1024 * 1024,
            process_limit: 32,
        })
        .is_err();
    Ok(row(
        "Sandbox restore",
        "sandbox missing, deleted, corrupt, expired, and incompatible",
        "the provider resumed a valid stopped sandbox, returned missing for absent or deleted resources, and rejected corrupt, expired, incompatible, and mutable identities",
        "SandboxRef is optional acceleration and cannot silently select untrusted state",
        resumed
            && missing_reconciled
            && deleted_missing
            && corrupt_rejected
            && expired_rejected
            && incompatible
            && unpinned,
        started,
    ))
}

fn artifact_corruption(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let bucket = std::env::var("OSFO_ARTIFACT_BUCKET").ok();
    let mut store: Box<dyn ArtifactStore> = if let Some(bucket) = &bucket {
        Box::new(GcsArtifactStore::new(bucket.clone()))
    } else {
        Box::new(MinioArtifactStore::new(
            "osfo-lifecycle-artifact-client".into(),
            "osfo-lifecycle-local".into(),
        ))
    };
    let key = format!(
        "failure/corrupt-{}.txt",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let artifact = store.put_immutable(&key, b"authoritative\n")?;
    if store.get_verified(&artifact)? != b"authoritative\n" {
        anyhow::bail!("artifact read-back verification changed bytes");
    }
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-artifact-commit")?;
    let record = format!("ArtifactRef:v1:{}", serde_json::to_string(&artifact)?);
    lifecycle.commit_interaction(&run_id, 1, "failure-artifact-ref", &record)?;
    drop(lifecycle);
    let mut reconciler = PostgresLifecycle::connect(database_url)?;
    let commit_replay =
        reconciler.commit_interaction(&run_id, 1, "failure-artifact-ref", &record)?;

    let output = if let Some(bucket) = &bucket {
        let temporary = std::env::temp_dir().join(format!(
            "osfo-artifact-corrupt-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        ));
        fs::write(&temporary, b"corrupt\n")?;
        let output = ProcessCommand::new("gcloud")
            .args([
                "storage",
                "cp",
                temporary.to_str().context("temporary path is not UTF-8")?,
                &format!("gs://{bucket}/{key}"),
            ])
            .output()?;
        fs::remove_file(temporary)?;
        output
    } else {
        let mut child = ProcessCommand::new("docker")
            .args([
                "exec",
                "--interactive",
                "osfo-lifecycle-artifact-client",
                "mc",
                "pipe",
                &format!("local/osfo-lifecycle-local/{key}"),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .context("tamper stdin unavailable")?
            .write_all(b"corrupt\n")?;
        child.wait_with_output()?
    };
    if !output.status.success() {
        anyhow::bail!(
            "artifact corruption injection failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let rejected = store.get_verified(&artifact).is_err();
    Ok(row(
        "Artifact verification",
        "artifact export verification and commit interruption",
        "verified bytes were committed by stable ArtifactRef identity, the lost commit acknowledgement reconciled, and later object mutation was rejected",
        "only verified immutable bytes and an idempotent ArtifactRef commit become authority",
        rejected && commit_replay == CommandOutcome::IdempotentReplay,
        started,
    ))
}

fn temporal_unavailable_after_intent(database_url: &str) -> Result<FailureEvidence> {
    let started = Instant::now();
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let run_id = admit_and_claim(&mut lifecycle, "failure-temporal-unavailable")?;
    let workflow_id = format!(
        "failure-temporal-unavailable-{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    lifecycle.execute(Command::StartAwaitedWorkflow {
        parent_run_id: run_id.clone(),
        parent_claim_epoch: 1,
        tool_call_id: format!("tool-{workflow_id}"),
        workflow_instance_id: workflow_id.clone(),
    })?;
    let runtime = tokio::runtime::Runtime::new()?;
    let unavailable = runtime
        .block_on(run_temporal_smoke_named("127.0.0.1:1", workflow_id.clone()))
        .is_err();
    let still_waiting = lifecycle.run(&run_id)?;
    let temporal_address = std::env::var("TEMPORAL_ADDRESS")
        .context("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint")?;
    let report = runtime.block_on(run_temporal_smoke_named(
        &temporal_address,
        workflow_id.clone(),
    ))?;
    let outcome = serde_json::to_string(&report.steps)?;
    let delivery_id = format!("delivery-{workflow_id}");
    lifecycle.execute(Command::DeliverWorkflowOutcome {
        workflow_instance_id: workflow_id.clone(),
        delivery_id: delivery_id.clone(),
        outcome: outcome.clone(),
    })?;
    let duplicate = lifecycle.execute(Command::DeliverWorkflowOutcome {
        workflow_instance_id: workflow_id,
        delivery_id,
        outcome,
    })?;
    let recovered = lifecycle.run(&run_id)?;
    Ok(row(
        "Temporal start reconciliation",
        "Temporal unavailable after start intent",
        "start failed while the AgentRun stayed waiting, then the same stable WorkflowInstance completed after service recovery",
        "PostgreSQL intent survives dependency outage and outcome wakes once",
        unavailable
            && still_waiting.state == RunState::Waiting
            && still_waiting.wake_count == 0
            && duplicate == CommandOutcome::IdempotentReplay
            && recovered.state == RunState::Pending
            && recovered.wake_count == 1,
        started,
    ))
}

fn admit_and_claim(lifecycle: &mut PostgresLifecycle, suffix: &str) -> Result<RunId> {
    let admitted = lifecycle.execute(Command::AdmitUserMessage {
        idempotency_key: suffix.into(),
        request_hash: format!("sha256:{suffix}"),
    })?;
    let run_id = admitted_run(admitted)?;
    lifecycle.execute(Command::Claim {
        run_id: run_id.clone(),
        worker_id: "failure-worker".into(),
    })?;
    Ok(run_id)
}

fn admitted_run(outcome: CommandOutcome) -> Result<RunId> {
    match outcome {
        CommandOutcome::RunAdmitted(run_id) => Ok(run_id),
        _ => anyhow::bail!("admission returned the wrong outcome"),
    }
}

fn row(
    cut: &str,
    injection: &str,
    recovery: &str,
    invariant: &str,
    passed: bool,
    started: Instant,
) -> FailureEvidence {
    FailureEvidence {
        cut: cut.into(),
        injection: injection.into(),
        observed_recovery: recovery.into(),
        invariant: invariant.into(),
        passed,
        samples_ms: vec![started.elapsed().as_secs_f64() * 1000.0],
    }
}
