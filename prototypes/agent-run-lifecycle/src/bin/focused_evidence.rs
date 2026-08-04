use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use futures_util::{StreamExt, stream::FuturesUnordered};
use osfo_agent_run_lifecycle_prototype::{
    ApprovalDecision, ChildJoinMode, Command, CommandOutcome, EmailMessage, MailpitSmtpSink,
    PostgresApprovalLedger, PostgresLifecycle, RunId, RunState, SmtpSink,
    evidence::{
        CorrectnessCheck, EvidenceBundle, FailureEvidence, ScenarioEvidence, render_dashboard,
        summarize_milliseconds,
    },
    rig_lane::run_rig_mock_conformance,
    temporal_lane::{TemporalSmokeReport, TemporalWorkerFleet, TemporalWorkerFleetConfig},
};

#[derive(Clone)]
struct PendingWorkflow {
    run_id: RunId,
    workflow_id: String,
    started: Instant,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .context("OSFO_TEST_DATABASE_URL must point at the evidence database")?;
    let temporal_address = std::env::var("TEMPORAL_ADDRESS")
        .context("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint")?;
    let output = std::env::var("OSFO_EVIDENCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("evidence/focused-latest"));
    let count = std::env::var("OSFO_FOCUSED_WORKFLOWS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(20);
    if count == 0 {
        anyhow::bail!("OSFO_FOCUSED_WORKFLOWS must be positive");
    }

    let setup_url = database_url.clone();
    let pending = tokio::task::spawn_blocking(move || setup_workflows(&setup_url, count)).await??;
    let temporal_metrics_address =
        std::env::var("OSFO_TEMPORAL_METRICS_ADDRESS").unwrap_or_else(|_| "0.0.0.0:9465".into());
    let temporal_fleet_id = std::env::var("OSFO_TEMPORAL_WORKER_FLEET_ID")
        .unwrap_or_else(|_| "osfo-focused-worker-fleet-v1".into());
    let temporal_slots = std::env::var("OSFO_TEMPORAL_WORKER_SLOTS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(100);
    let fleet = TemporalWorkerFleet::start(
        &temporal_address,
        TemporalWorkerFleetConfig {
            fleet_id: temporal_fleet_id.clone(),
            metrics_address: temporal_metrics_address,
            task_queue: std::env::var("TEMPORAL_TASK_QUEUE")
                .unwrap_or_else(|_| "osfo-agent-run-lifecycle-v1".into()),
            workflow_slots: temporal_slots,
            activity_slots: temporal_slots,
        },
    )
    .await?;
    let exported_temporal_metrics_address = fleet.metrics_address().to_string();
    let mut running = FuturesUnordered::new();
    for workflow in pending {
        let fleet = &fleet;
        running.push(async move {
            let service_started = Instant::now();
            let report = fleet.run_smoke_named(workflow.workflow_id.clone()).await?;
            Result::<_>::Ok((
                workflow,
                report,
                service_started.elapsed().as_secs_f64() * 1000.0,
            ))
        });
    }

    let mut reports = Vec::with_capacity(count);
    let mut service_samples = Vec::with_capacity(count);
    let mut journey_samples = Vec::with_capacity(count);
    while let Some(result) = running.next().await {
        let (workflow, report, service_ms) = result?;
        let delivery_url = database_url.clone();
        let delivery_workflow = workflow.clone();
        let delivery_report = report.clone();
        tokio::task::spawn_blocking(move || {
            deliver_workflow(&delivery_url, &delivery_workflow, &delivery_report)
        })
        .await??;
        service_samples.push(service_ms);
        journey_samples.push(workflow.started.elapsed().as_secs_f64() * 1000.0);
        reports.push(report);
    }
    drop(running);
    let cancellation_started = Instant::now();
    let cancellation_prefix = format!(
        "focused-cancellation-matrix-{temporal_fleet_id}-{}",
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let cancellation_checks = fleet
        .workflow_client()
        .run_cancellation_matrix(&cancellation_prefix)
        .await?;
    let cancellation_samples = vec![cancellation_started.elapsed().as_secs_f64() * 1000.0];
    fleet.shutdown().await?;
    reports.sort_by(|left, right| left.workflow_instance_id.cmp(&right.workflow_instance_id));

    let email_url = database_url.clone();
    let (email_total, email_smtp, email_checks) =
        tokio::task::spawn_blocking(move || run_email_batch(&email_url, count)).await??;
    let rig = run_rig_mock_conformance().await?;
    let all_temporal_checks = reports.iter().all(|report| {
        report.replay_passed
            && report.nondeterminism_negative_detected
            && report.wrong_order_approval_rejected
            && report.duplicate_approval_idempotent
            && report.post_settlement_approval_rejected
            && report
                .steps
                .iter()
                .any(|step| step.starts_with("artifact-committed:"))
            && report
                .steps
                .iter()
                .any(|step| step == "publish-succeeded-attempt-2")
    });
    let temporal_scenario = ScenarioEvidence {
        name: "temporal-timer-herd-retry-batch".into(),
        started_at_unix_milliseconds: 0,
        ended_at_unix_milliseconds: 0,
        workload: "real eight-step Temporal workflows with concurrent timers, approvals, sandbox artifacts, and injected first-attempt publish failures".into(),
        persistence_profile: "cold logical reconstruction plus immutable artifact".into(),
        offered: count as u64,
        accepted: count as u64,
        completed: reports.len() as u64,
        shed: 0,
        traffic: osfo_agent_run_lifecycle_prototype::confirmation::TrafficAccounting {
            offered: count as u64,
            received: count as u64,
            caller_drop: 0,
            accepted: count as u64,
            shed_or_rejected: 0,
            completed: reports.len() as u64,
            failed: 0,
            canceled: 0,
            still_in_flight: (count - reports.len()) as u64,
        },
        errors: Vec::new(),
        elapsed_seconds: journey_samples.iter().copied().fold(0.0, f64::max) / 1000.0,
        drain_seconds: 0.0,
        offered_per_second: 0.0,
        completed_per_second: reports.len() as f64
            / (journey_samples.iter().copied().fold(0.0, f64::max) / 1000.0),
        metrics: BTreeMap::from([
            (
                "temporal_workflow_service".into(),
                summarize_milliseconds(service_samples.clone()),
            ),
            (
                "end_to_end_journey".into(),
                summarize_milliseconds(journey_samples.clone()),
            ),
        ]),
        samples: Vec::new(),
        raw_latency_file: None,
        raw_latency_sha256: None,
        raw_latency_rows: 0,
    };
    let email_scenario = ScenarioEvidence {
        name: "approval-gated-mailpit-batch".into(),
        started_at_unix_milliseconds: 0,
        ended_at_unix_milliseconds: 0,
        workload: "bounded non-workflow SendEmail ToolCalls to Mailpit".into(),
        persistence_profile: "PostgreSQL authority".into(),
        offered: count as u64,
        accepted: count as u64,
        completed: count as u64,
        shed: 0,
        traffic: osfo_agent_run_lifecycle_prototype::confirmation::TrafficAccounting {
            offered: count as u64,
            received: count as u64,
            caller_drop: 0,
            accepted: count as u64,
            shed_or_rejected: 0,
            completed: count as u64,
            failed: 0,
            canceled: 0,
            still_in_flight: 0,
        },
        errors: Vec::new(),
        elapsed_seconds: email_total.iter().sum::<f64>() / 1000.0,
        drain_seconds: 0.0,
        offered_per_second: 0.0,
        completed_per_second: count as f64 / (email_total.iter().sum::<f64>() / 1000.0),
        metrics: BTreeMap::from([
            (
                "smtp_tool_call_execution".into(),
                summarize_milliseconds(email_smtp.clone()),
            ),
            (
                "end_to_end_journey".into(),
                summarize_milliseconds(email_total.clone()),
            ),
        ]),
        samples: Vec::new(),
        raw_latency_file: None,
        raw_latency_sha256: None,
        raw_latency_rows: 0,
    };
    let bundle = EvidenceBundle {
        schema_version: 2,
        generated_at: format!(
            "unix:{}",
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()
        ),
        question: "Do real concurrent Temporal workflows and approval-gated Mailpit ToolCalls preserve the Osfo authority boundary and exact wake semantics?".into(),
        environment: BTreeMap::from([
            (
                "database-profile".into(),
                std::env::var("OSFO_DATABASE_PROFILE")
                    .unwrap_or_else(|_| "local Docker PostgreSQL".into()),
            ),
            (
                "temporal-service".into(),
                "Temporal Cloud managed".into(),
            ),
            (
                "temporal-deployment".into(),
                "temporal-cloud-on-demand".into(),
            ),
            ("temporalio-sdk".into(), "0.5.0 Public Preview".into()),
            ("temporal-worker-fleet".into(), temporal_fleet_id),
            (
                "temporal-worker-fixed-slots".into(),
                temporal_slots.to_string(),
            ),
            (
                "temporal-sdk-metrics".into(),
                exported_temporal_metrics_address,
            ),
            ("sandbox".into(), "Docker Engine with pinned Alpine 3.22.1 digest".into()),
            (
                "artifact-store".into(),
                if std::env::var_os("OSFO_ARTIFACT_BUCKET").is_some() {
                    "regional Google Cloud Storage bucket".into()
                } else {
                    "MinIO RELEASE.2025-09-07T16-13-09Z".into()
                },
            ),
            ("smtp-sink".into(), "Mailpit 1.30.6".into()),
            ("rig-agent".into(), rig.rig_version.clone()),
        ]),
        scenarios: vec![temporal_scenario, email_scenario],
        correctness: vec![
            CorrectnessCheck {
                name: "real Temporal batch".into(),
                passed: reports.len() == count && all_temporal_checks,
                evidence: format!(
                    "{} workflows, {} total history events, all approval, retry, replay, nondeterminism, sandbox, and artifact checks passed",
                    reports.len(),
                    reports.iter().map(|report| report.history_event_count).sum::<usize>()
                ),
            },
            CorrectnessCheck {
                name: "approval-gated SMTP batch".into(),
                passed: email_checks,
                evidence: format!("{count} ToolCalls produced exactly {count} Mailpit messages"),
            },
            CorrectnessCheck {
                name: "authority-free Rig adapter".into(),
                passed: !rig.checkpoint_is_authority && rig.model_requests == 1,
                evidence: format!("Rig {} returned one deterministic mock result", rig.rig_version),
            },
            CorrectnessCheck {
                name: "full issue 13 failure matrix".into(),
                passed: false,
                evidence: "focused lane covers the listed rows only, remaining durable cuts require separate injection evidence".into(),
            },
        ],
        failure_matrix: vec![
            failure("Temporal approval", "wrong-order release update", "validator rejected every update", "wrong gate cannot settle", all_temporal_checks, &service_samples),
            failure("Temporal approval", "duplicate editorial update ID", "stable idempotent outcome returned", "one approval settlement", all_temporal_checks, &service_samples),
            failure("Temporal approval", "post-settlement update", "closed workflow rejected every update", "terminal history is immutable", all_temporal_checks, &service_samples),
            failure("Activity retry", "first publish attempt fails", "Temporal retried and attempt 2 succeeded", "one terminal workflow outcome", all_temporal_checks, &service_samples),
            failure("Timer herd", "timer herd with delayed callbacks", "concurrent durable timers and delayed terminal callbacks drained", "every workflow completed once after the herd", all_temporal_checks, &journey_samples),
            failure("Workflow callback", "dropped and replayed callback", "the first acknowledgement was treated as dropped and the same callback identity was replayed", "PostgreSQL committed one delivery and one wake", all_temporal_checks, &journey_samples),
            failure("Workflow cancellation", "cancellation at workflow boundaries", "cancellation before approval and during timer or Activity settled, while post-terminal cancellation could not change the result", "cancellation is durable and terminal history is immutable", cancellation_checks, &cancellation_samples),
            failure("Workflow replay", "pinned history replay", "all histories replayed", "deterministic worker code", all_temporal_checks, &service_samples),
            failure("Workflow replay", "intentional command-order change", "nondeterminism detected for every history", "bad deployment is rejected", all_temporal_checks, &service_samples),
            failure("Workflow delivery", "duplicate workflow progress and outcome delivery", "PostgreSQL reconciled duplicate typed progress and outcome deliveries", "progress committed once and parent woke exactly once for terminal outcome", all_temporal_checks, &journey_samples),
            failure("SMTP approval", "duplicate decision and terminal outcome", "both returned idempotent replay", "one ToolCall outcome and one Mailpit message", email_checks, &email_total),
        ],
        notes: vec![
            "Every sample is preserved because this focused batch is too small for stable tail percentiles.".into(),
            "The timer and retry batch is a focused real-service lane, not the open-arrival PostgreSQL capacity lane.".into(),
            "Mailpit is the only SMTP destination. This does not establish production ActionReceipt semantics.".into(),
            "Local Docker validates the provider seam and resource controls, not hostile-code isolation.".into(),
        ],
        confirmation_verdict: None,
    };
    write_bundle(
        &output,
        &bundle,
        &reports,
        &service_samples,
        &journey_samples,
        &email_total,
        &email_smtp,
    )?;
    if !all_temporal_checks || !email_checks {
        anyhow::bail!("focused correctness gate failed, inspect generated evidence");
    }
    println!("evidence={}", output.display());
    Ok(())
}

fn setup_workflows(database_url: &str, count: usize) -> Result<Vec<PendingWorkflow>> {
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    lifecycle.reset()?;
    let mut workflows = Vec::with_capacity(count);
    for ordinal in 0..count {
        let admitted = lifecycle.execute(Command::AdmitUserMessage {
            idempotency_key: format!("focused-temporal-{ordinal}"),
            request_hash: format!("sha256:focused-temporal-{ordinal}"),
        })?;
        let run_id = match admitted {
            CommandOutcome::RunAdmitted(run_id) => run_id,
            _ => anyhow::bail!("admission returned the wrong outcome"),
        };
        lifecycle.execute(Command::Claim {
            run_id: run_id.clone(),
            worker_id: "focused-worker-a".into(),
        })?;
        let child_a = RunId::from(format!("{}-focused-a", run_id.as_str()).as_str());
        let child_b = RunId::from(format!("{}-focused-b", run_id.as_str()).as_str());
        lifecycle.execute(Command::AdmitChildren {
            parent_run_id: run_id.clone(),
            parent_claim_epoch: 1,
            join_id: format!("focused-join-{ordinal}"),
            mode: ChildJoinMode::AllTerminal,
            child_run_ids: vec![child_a.clone(), child_b.clone()],
        })?;
        lifecycle.execute(Command::CompleteChild {
            child_run_id: child_a,
            outcome: "research-ready".into(),
        })?;
        lifecycle.execute(Command::CompleteChild {
            child_run_id: child_b,
            outcome: "artifact-plan-ready".into(),
        })?;
        lifecycle.execute(Command::Claim {
            run_id: run_id.clone(),
            worker_id: "focused-worker-b".into(),
        })?;
        let workflow_id = format!("focused-workflow-{ordinal:04}");
        lifecycle.execute(Command::StartAwaitedWorkflow {
            parent_run_id: run_id.clone(),
            parent_claim_epoch: 2,
            tool_call_id: format!("focused-workflow-tool-{ordinal:04}"),
            workflow_instance_id: workflow_id.clone(),
        })?;
        workflows.push(PendingWorkflow {
            run_id,
            workflow_id,
            started: Instant::now(),
        });
    }
    Ok(workflows)
}

fn deliver_workflow(
    database_url: &str,
    workflow: &PendingWorkflow,
    report: &TemporalSmokeReport,
) -> Result<()> {
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    let progress_id = format!("progress-{}", workflow.workflow_id);
    lifecycle.deliver_workflow_progress(
        &workflow.workflow_id,
        &progress_id,
        "WorkflowProgress:v1:artifact-exported",
    )?;
    if lifecycle.deliver_workflow_progress(
        &workflow.workflow_id,
        &progress_id,
        "WorkflowProgress:v1:artifact-exported",
    )? != CommandOutcome::IdempotentReplay
    {
        anyhow::bail!("duplicate workflow progress did not reconcile");
    }
    let outcome = serde_json::to_string(&report.steps)?;
    let delivery_id = format!("delivery-{}", workflow.workflow_id);
    lifecycle.execute(Command::DeliverWorkflowOutcome {
        workflow_instance_id: workflow.workflow_id.clone(),
        delivery_id: delivery_id.clone(),
        outcome: outcome.clone(),
    })?;
    if lifecycle.execute(Command::DeliverWorkflowOutcome {
        workflow_instance_id: workflow.workflow_id.clone(),
        delivery_id,
        outcome,
    })? != CommandOutcome::IdempotentReplay
    {
        anyhow::bail!("duplicate workflow outcome did not reconcile");
    }
    let waiting = lifecycle.run(&workflow.run_id)?;
    if waiting.state != RunState::Pending || waiting.wake_count != 2 {
        anyhow::bail!("workflow outcome did not wake the parent exactly once");
    }
    lifecycle.execute(Command::Claim {
        run_id: workflow.run_id.clone(),
        worker_id: "focused-worker-c".into(),
    })?;
    lifecycle.complete_run(&workflow.run_id, 3, RunState::Succeeded)?;
    Ok(())
}

fn run_email_batch(database_url: &str, count: usize) -> Result<(Vec<f64>, Vec<f64>, bool)> {
    let mut lifecycle = PostgresLifecycle::connect(database_url)?;
    let mut approvals = PostgresApprovalLedger::connect(database_url)?;
    let mut mailpit = MailpitSmtpSink::local();
    mailpit.reset()?;
    let mut totals = Vec::with_capacity(count);
    let mut smtp = Vec::with_capacity(count);
    let mut all_idempotent = true;
    for ordinal in 0..count {
        let started = Instant::now();
        let admitted = lifecycle.execute(Command::AdmitUserMessage {
            idempotency_key: format!("focused-email-{ordinal}"),
            request_hash: format!("sha256:focused-email-{ordinal}"),
        })?;
        let run_id = match admitted {
            CommandOutcome::RunAdmitted(run_id) => run_id,
            _ => anyhow::bail!("email admission returned the wrong outcome"),
        };
        lifecycle.execute(Command::Claim {
            run_id: run_id.clone(),
            worker_id: "email-worker-a".into(),
        })?;
        let tool_id = format!("focused-email-tool-{ordinal:04}");
        let approval_id = format!("focused-email-approval-{ordinal:04}");
        let decision_id = format!("focused-email-decision-{ordinal:04}");
        approvals.open_email_tool(&run_id, 1, &tool_id, &approval_id)?;
        approvals.decide(&approval_id, &decision_id, ApprovalDecision::Approved)?;
        all_idempotent &=
            approvals.decide(&approval_id, &decision_id, ApprovalDecision::Approved)?
                == CommandOutcome::IdempotentReplay;
        lifecycle.execute(Command::Claim {
            run_id: run_id.clone(),
            worker_id: "email-worker-b".into(),
        })?;
        let attempt_id = format!("focused-email-attempt-{ordinal:04}");
        approvals.begin_attempt(&run_id, 2, &tool_id, &attempt_id)?;
        let smtp_started = Instant::now();
        mailpit.send(&EmailMessage {
            from: "osfo@example.invalid".into(),
            to: "fixture@example.invalid".into(),
            subject: format!("Approved fixture {ordinal}"),
            body: "Mailpit only. No real email was sent.".into(),
        })?;
        smtp.push(smtp_started.elapsed().as_secs_f64() * 1000.0);
        approvals.complete_attempt(&run_id, 2, &tool_id, &attempt_id, "smtp-accepted")?;
        all_idempotent &=
            approvals.complete_attempt(&run_id, 2, &tool_id, &attempt_id, "smtp-accepted")?
                == CommandOutcome::IdempotentReplay;
        lifecycle.complete_run(&run_id, 2, RunState::Succeeded)?;
        totals.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let delivered = mailpit.message_count()?;
    Ok((totals, smtp, all_idempotent && delivered == count as u64))
}

fn failure(
    cut: &str,
    injection: &str,
    observed_recovery: &str,
    invariant: &str,
    passed: bool,
    samples: &[f64],
) -> FailureEvidence {
    FailureEvidence {
        cut: cut.into(),
        injection: injection.into(),
        observed_recovery: observed_recovery.into(),
        invariant: invariant.into(),
        passed,
        samples_ms: samples.to_vec(),
    }
}

fn write_bundle(
    output: &Path,
    bundle: &EvidenceBundle,
    reports: &[TemporalSmokeReport],
    service_samples: &[f64],
    journey_samples: &[f64],
    email_total: &[f64],
    email_smtp: &[f64],
) -> Result<()> {
    fs::create_dir_all(output)?;
    fs::write(
        output.join("results.json"),
        serde_json::to_vec_pretty(bundle)?,
    )?;
    fs::write(
        output.join("temporal-reports.json"),
        serde_json::to_vec_pretty(reports)?,
    )?;
    fs::write(output.join("dashboard.html"), render_dashboard(bundle)?)?;
    let mut csv = String::from("lane,ordinal,elapsed_ms\n");
    for (lane, values) in [
        ("temporal_service", service_samples),
        ("temporal_end_to_end", journey_samples),
        ("email_end_to_end", email_total),
        ("smtp_execution", email_smtp),
    ] {
        for (ordinal, value) in values.iter().enumerate() {
            csv.push_str(&format!("{lane},{ordinal},{value:.3}\n"));
        }
    }
    fs::write(output.join("all-samples.csv"), csv)?;
    Ok(())
}
