use std::time::{Duration, Instant};

use anyhow::{Result, bail};

use crate::{
    ApprovalDecision, ArtifactStore, ChildJoinMode, Command, EmailMessage, PostgresApprovalLedger,
    PostgresLifecycle, RunId, RunState, SandboxProvider, SandboxSpec, SmtpSink,
    latency::LatencySample,
    temporal_lane::TemporalWorkflowClient,
    workload::{ClaimedWorkload, JourneyKind},
};

pub fn execute_temporal_journey(
    lifecycle: &mut PostgresLifecycle,
    temporal: &TemporalWorkflowClient,
    runtime: &tokio::runtime::Handle,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    let workflow_epoch = if claimed.journey_kind == JourneyKind::FullReferenceJourney {
        settle_children(lifecycle, claimed, &mut samples)?;
        timed(&mut samples, "claim_after_child_join", || {
            lifecycle.claim_with_lease(
                &claimed.run_id,
                "production-workflow-after-child",
                Duration::from_secs(30),
            )
        })?;
        claimed.claim_epoch + 1
    } else {
        claimed.claim_epoch
    };
    let workflow_id = format!("workflow-{}", claimed.run_id.as_str());
    let tool_id = format!("workflow-tool-{}", claimed.run_id.as_str());
    match claimed.journey_kind {
        JourneyKind::AwaitedWorkflow | JourneyKind::FullReferenceJourney => {
            timed(&mut samples, "workflow_start_intent_commit", || {
                lifecycle.execute(Command::StartAwaitedWorkflow {
                    parent_run_id: claimed.run_id.clone(),
                    parent_claim_epoch: workflow_epoch,
                    tool_call_id: tool_id,
                    workflow_instance_id: workflow_id.clone(),
                })
            })?;
            let report = timed(&mut samples, "temporal_workflow_service", || {
                runtime.block_on(temporal.run_load_named(workflow_id.clone()))
            })?;
            let outcome = serde_json::to_string(&report.steps)?;
            let delivery_id = format!("delivery-{workflow_id}");
            timed(&mut samples, "workflow_outcome_delivery_and_wake", || {
                lifecycle.execute(Command::DeliverWorkflowOutcome {
                    workflow_instance_id: workflow_id.clone(),
                    delivery_id,
                    outcome,
                })
            })?;
            let final_epoch = workflow_epoch + 1;
            timed(&mut samples, "claim_after_workflow", || {
                lifecycle.claim_with_lease(
                    &claimed.run_id,
                    "production-workflow-resume",
                    Duration::from_secs(30),
                )
            })?;
            timed(&mut samples, "terminal_commit", || {
                lifecycle.complete_run(&claimed.run_id, final_epoch, RunState::Succeeded)
            })?;
        }
        JourneyKind::DetachedWorkflow => {
            timed(&mut samples, "workflow_start_intent_commit", || {
                lifecycle.start_detached_workflow(
                    &claimed.run_id,
                    workflow_epoch,
                    &tool_id,
                    &workflow_id,
                )
            })?;
            timed(&mut samples, "terminal_commit", || {
                lifecycle.complete_run(&claimed.run_id, workflow_epoch, RunState::Succeeded)
            })?;
            let report = timed(&mut samples, "temporal_workflow_service", || {
                runtime.block_on(temporal.run_load_named(workflow_id.clone()))
            })?;
            timed(&mut samples, "detached_workflow_outcome_delivery", || {
                lifecycle.execute(Command::DeliverWorkflowOutcome {
                    workflow_instance_id: workflow_id.clone(),
                    delivery_id: format!("delivery-{workflow_id}"),
                    outcome: serde_json::to_string(&report.steps)?,
                })
            })?;
        }
        other => bail!("{other:?} is not a Temporal journey"),
    }
    Ok(samples)
}

pub fn execute_email_journey(
    lifecycle: &mut PostgresLifecycle,
    approvals: &mut PostgresApprovalLedger,
    smtp: &mut dyn SmtpSink,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = open_and_approve_email(approvals, claimed)?;
    let attempt_epoch = claimed.claim_epoch + 1;
    timed(&mut samples, "claim_after_approval", || {
        lifecycle.claim_with_lease(
            &claimed.run_id,
            "production-email-worker",
            Duration::from_secs(30),
        )
    })?;
    let resumed = ClaimedWorkload {
        claim_epoch: attempt_epoch,
        ..claimed.clone()
    };
    samples.extend(execute_approved_email(
        lifecycle, approvals, smtp, &resumed,
    )?);
    Ok(samples)
}

pub fn open_and_approve_email(
    approvals: &mut PostgresApprovalLedger,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    let tool_id = format!("email-tool-{}", claimed.run_id.as_str());
    let approval_id = format!("email-approval-{}", claimed.run_id.as_str());
    let decision_id = format!("email-decision-{}", claimed.run_id.as_str());
    timed(&mut samples, "tool_call_intent_commit", || {
        approvals.open_email_tool(&claimed.run_id, claimed.claim_epoch, &tool_id, &approval_id)
    })?;
    timed(&mut samples, "approval_commit_and_wake", || {
        approvals.decide(&approval_id, &decision_id, ApprovalDecision::Approved)
    })?;
    Ok(samples)
}

pub fn execute_approved_email(
    lifecycle: &mut PostgresLifecycle,
    approvals: &mut PostgresApprovalLedger,
    smtp: &mut dyn SmtpSink,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    let tool_id = format!("email-tool-{}", claimed.run_id.as_str());
    let attempt_epoch = claimed.claim_epoch;
    let attempt_id = format!("email-attempt-{}", claimed.run_id.as_str());
    timed(&mut samples, "tool_call_attempt_commit", || {
        approvals.begin_attempt(&claimed.run_id, attempt_epoch, &tool_id, &attempt_id)
    })?;
    timed(&mut samples, "smtp_tool_call_execution", || {
        smtp.send(&EmailMessage {
            from: "osfo@example.invalid".into(),
            to: "fixture@example.invalid".into(),
            subject: format!("Approved fixture {}", claimed.ordinal),
            body: "Mailpit only. No real email was sent.".into(),
        })
    })?;
    timed(&mut samples, "tool_call_outcome_commit", || {
        approvals.complete_attempt(
            &claimed.run_id,
            attempt_epoch,
            &tool_id,
            &attempt_id,
            "smtp-accepted",
        )
    })?;
    timed(&mut samples, "terminal_commit", || {
        lifecycle.complete_run(&claimed.run_id, attempt_epoch, RunState::Succeeded)
    })?;
    Ok(samples)
}

pub fn open_and_settle_child_join(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    settle_children(lifecycle, claimed, &mut samples)?;
    Ok(samples)
}

pub fn complete_child_journey(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = consume_child_outcomes(lifecycle, claimed)?;
    timed(&mut samples, "terminal_commit", || {
        lifecycle.complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Succeeded)
    })?;
    Ok(samples)
}

pub fn consume_child_outcomes(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    commit_step(
        lifecycle,
        claimed,
        claimed.claim_epoch,
        "child-consumption",
        "ChildOutcomesConsumed:v1:all-terminal",
        "child_outcome_consumption_commit",
        &mut samples,
    )?;
    Ok(samples)
}

pub fn open_and_deliver_awaited_workflow(
    lifecycle: &mut PostgresLifecycle,
    temporal: &TemporalWorkflowClient,
    runtime: &tokio::runtime::Handle,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    let workflow_id = format!("workflow-{}", claimed.run_id.as_str());
    timed(&mut samples, "workflow_start_intent_commit", || {
        lifecycle.execute(Command::StartAwaitedWorkflow {
            parent_run_id: claimed.run_id.clone(),
            parent_claim_epoch: claimed.claim_epoch,
            tool_call_id: format!("workflow-tool-{}", claimed.run_id.as_str()),
            workflow_instance_id: workflow_id.clone(),
        })
    })?;
    let report = timed(&mut samples, "temporal_workflow_service", || {
        runtime.block_on(temporal.run_load_named(workflow_id.clone()))
    })?;
    timed(&mut samples, "workflow_outcome_delivery_and_wake", || {
        lifecycle.execute(Command::DeliverWorkflowOutcome {
            workflow_instance_id: workflow_id.clone(),
            delivery_id: format!("delivery-{workflow_id}"),
            outcome: serde_json::to_string(&report.steps)?,
        })
    })?;
    Ok(samples)
}

pub fn complete_after_awaited_workflow(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    timed(&mut samples, "terminal_commit", || {
        lifecycle.complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Succeeded)
    })?;
    Ok(samples)
}

pub fn execute_sandbox_artifact_journey(
    lifecycle: &mut PostgresLifecycle,
    sandbox_provider: &mut dyn SandboxProvider,
    artifact_store: &mut dyn ArtifactStore,
    claimed: &ClaimedWorkload,
    sandbox_image: &str,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    let sandbox = timed(&mut samples, "sandbox_create", || {
        sandbox_provider.create(SandboxSpec {
            sandbox_id: format!("load-{}", claimed.run_id.as_str()),
            image: sandbox_image.into(),
            cpu_limit: 0.5,
            memory_bytes: 64 * 1024 * 1024,
            process_limit: 32,
        })
    })?;
    if claimed.persistence_profile == "checkpoint-and-sandbox-restore" {
        timed(&mut samples, "sandbox_stop", || {
            sandbox_provider.stop(&sandbox)
        })?;
        let resumed = timed(&mut samples, "sandbox_resume", || {
            sandbox_provider.resume(&sandbox)
        })?;
        if !resumed {
            bail!("compatible sandbox was not resumable");
        }
    }
    let result = (|| {
        let execution = timed(&mut samples, "sandbox_command", || {
            sandbox_provider.execute(
                &sandbox,
                "printf 'briefing\\n' > /workspace/briefing.txt",
                Duration::from_secs(3),
            )
        })?;
        if !execution.success {
            bail!("sandbox command failed: {}", execution.stderr);
        }
        let exported = timed(&mut samples, "artifact_export", || {
            sandbox_provider.export(&sandbox, "briefing.txt")
        })?;
        let key = format!("load/{}/briefing.txt", claimed.run_id.as_str());
        let artifact = timed(&mut samples, "artifact_verification_and_commit", || {
            artifact_store.put_immutable(&key, &exported.bytes)
        })?;
        let artifact_record = format!("ArtifactRef:v1:{}", serde_json::to_string(&artifact)?);
        commit_step(
            lifecycle,
            claimed,
            claimed.claim_epoch,
            "artifact-ref",
            &artifact_record,
            "artifact_ref_commit",
            &mut samples,
        )?;
        timed(&mut samples, "terminal_commit", || {
            lifecycle.complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Succeeded)
        })?;
        Result::<()>::Ok(())
    })();
    let delete = timed(&mut samples, "sandbox_teardown", || {
        sandbox_provider.delete(&sandbox)
    });
    match (result, delete) {
        (Ok(()), Ok(())) => Ok(samples),
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
    }
}

pub fn execute_database_journey(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
) -> Result<Vec<LatencySample>> {
    let mut samples = Vec::new();
    match claimed.journey_kind {
        JourneyKind::BasicAgentRun => execute_basic(lifecycle, claimed, &mut samples)?,
        JourneyKind::ChildFanout => execute_child_fanout(lifecycle, claimed, &mut samples)?,
        other => bail!("{other:?} needs a real service dependency lane"),
    }
    Ok(samples)
}

fn execute_basic(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
    samples: &mut Vec<LatencySample>,
) -> Result<()> {
    commit_step(
        lifecycle,
        claimed,
        claimed.claim_epoch,
        "model-intent",
        "ModelCallIntent:v1:deterministic-adapter",
        "model_call_intent_commit",
        samples,
    )?;
    if claimed.persistence_profile != "per-step-checkpoint" {
        timed(samples, "model_response_terminal_commit", || {
            lifecycle.complete_basic_model_response(
                &claimed.run_id,
                claimed.claim_epoch,
                "model-fragment-1",
                "AssistantOutputFragment:v1:deterministic-output",
                "model-outcome",
                "ModelCallOutcome:v1:succeeded:tokens=17",
            )
        })?;
        return Ok(());
    }
    commit_step(
        lifecycle,
        claimed,
        claimed.claim_epoch,
        "model-fragment-1",
        "AssistantOutputFragment:v1:deterministic-output",
        "assistant_output_fragment_commit",
        samples,
    )?;
    commit_step(
        lifecycle,
        claimed,
        claimed.claim_epoch,
        "model-outcome",
        "ModelCallOutcome:v1:succeeded:tokens=17",
        "model_call_outcome_commit",
        samples,
    )?;
    timed(samples, "terminal_commit", || {
        lifecycle.complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Succeeded)
    })?;
    Ok(())
}

fn execute_child_fanout(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
    samples: &mut Vec<LatencySample>,
) -> Result<()> {
    settle_children(lifecycle, claimed, samples)?;
    let next_epoch = claimed.claim_epoch + 1;
    timed(samples, "claim_after_child_join", || {
        lifecycle.claim_with_lease(
            &claimed.run_id,
            "production-worker-child-resume",
            Duration::from_secs(30),
        )
    })?;
    commit_step(
        lifecycle,
        claimed,
        next_epoch,
        "child-consumption",
        "ChildOutcomesConsumed:v1:all-terminal",
        "child_outcome_consumption_commit",
        samples,
    )?;
    timed(samples, "terminal_commit", || {
        lifecycle.complete_run(&claimed.run_id, next_epoch, RunState::Succeeded)
    })?;
    Ok(())
}

fn settle_children(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
    samples: &mut Vec<LatencySample>,
) -> Result<()> {
    let child_a = RunId::from(format!("{}-a", claimed.run_id.as_str()).as_str());
    let child_b = RunId::from(format!("{}-b", claimed.run_id.as_str()).as_str());
    let join_id = format!("join-{}", claimed.run_id.as_str());
    timed(samples, "child_admission", || {
        lifecycle.execute(Command::AdmitChildren {
            parent_run_id: claimed.run_id.clone(),
            parent_claim_epoch: claimed.claim_epoch,
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
            outcome: "artifact-plan-ready".into(),
        })
    })?;
    Ok(())
}

fn commit_step(
    lifecycle: &mut PostgresLifecycle,
    claimed: &ClaimedWorkload,
    claim_epoch: u64,
    record_id: &str,
    semantic_record: &str,
    latency_family: &str,
    samples: &mut Vec<LatencySample>,
) -> Result<()> {
    timed(samples, latency_family, || {
        lifecycle.commit_interaction(&claimed.run_id, claim_epoch, record_id, semantic_record)
    })?;
    if claimed.persistence_profile == "per-step-checkpoint" {
        let checkpoint_id = format!("checkpoint-{record_id}");
        let checkpoint = format!("RuntimeCheckpointRef:v1:{record_id}:optional");
        timed(samples, "checkpoint_commit", || {
            lifecycle.commit_interaction(&claimed.run_id, claim_epoch, &checkpoint_id, &checkpoint)
        })?;
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
