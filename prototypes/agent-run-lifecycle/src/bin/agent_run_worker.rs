use std::time::Duration;

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::{
    ingress::{ClaimedMessageRun, PostgresMessageStore},
    reasoning_lane::measured_replay_decision,
    workload::JourneyKind,
};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let database_url = std::env::var("OSFO_DATABASE_URL")
        .or_else(|_| std::env::var("OSFO_TEST_DATABASE_URL"))
        .context("OSFO_DATABASE_URL is required")?;
    let pool_size = std::env::var("OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE")
        .unwrap_or_else(|_| "8".into())
        .parse::<usize>()
        .context("OSFO_AGENT_RUN_WORKER_DATABASE_POOL_SIZE must be positive")?;
    let worker_id = std::env::var("OSFO_AGENT_RUN_WORKER_ID")
        .unwrap_or_else(|_| "osfo-agent-run-worker-v1".into());
    let empty_poll = Duration::from_millis(
        std::env::var("OSFO_AGENT_RUN_EMPTY_POLL_MILLISECONDS")
            .unwrap_or_else(|_| "25".into())
            .parse::<u64>()
            .context("OSFO_AGENT_RUN_EMPTY_POLL_MILLISECONDS must be positive")?,
    );
    let concurrency = std::env::var("OSFO_AGENT_RUN_WORKER_CONCURRENCY")
        .unwrap_or_else(|_| pool_size.to_string())
        .parse::<usize>()
        .context("OSFO_AGENT_RUN_WORKER_CONCURRENCY must be positive")?;
    if concurrency == 0 {
        anyhow::bail!("OSFO_AGENT_RUN_WORKER_CONCURRENCY must be positive");
    }
    let store = PostgresMessageStore::connect(&database_url, pool_size)?;
    run(store, worker_id, empty_poll, concurrency).await
}

async fn run(
    store: PostgresMessageStore,
    worker_id: String,
    empty_poll: Duration,
    concurrency: usize,
) -> Result<()> {
    let mut shutdown = std::pin::pin!(shutdown_signal());
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        let available = concurrency.saturating_sub(tasks.len());
        let claims = if available == 0 {
            Vec::new()
        } else {
            match store
                .claim_batch(&worker_id, Duration::from_secs(30), available)
                .await
            {
                Ok(claims) => claims,
                Err(error) => {
                    eprintln!("AgentRun batch claim failed; retrying: {error}");
                    tokio::select! {
                        _ = &mut shutdown => break,
                        _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                    }
                    continue;
                }
            }
        };
        let claimed_work = !claims.is_empty();
        for claimed in claims {
            let slot_store = store.clone();
            tasks.spawn(async move { process_claim(slot_store, claimed).await });
        }

        if tasks.len() == concurrency {
            tokio::select! {
                _ = &mut shutdown => break,
                completed = tasks.join_next() => report_task(completed),
            }
        } else if claimed_work {
            continue;
        } else if tasks.is_empty() {
            tokio::select! {
                _ = &mut shutdown => break,
                _ = tokio::time::sleep(empty_poll) => {},
            }
        } else {
            tokio::select! {
                _ = &mut shutdown => break,
                completed = tasks.join_next() => report_task(completed),
                _ = tokio::time::sleep(empty_poll) => {},
            }
        }
    }
    while let Some(completed) = tasks.join_next().await {
        report_task(Some(completed));
    }
    Ok(())
}

fn report_task(completed: Option<Result<Result<()>, tokio::task::JoinError>>) {
    match completed {
        Some(Ok(Ok(()))) | None => {}
        Some(Ok(Err(error))) => {
            eprintln!("AgentRun execution failed; lease recovery will retry: {error}")
        }
        Some(Err(error)) => eprintln!("AgentRun execution task failed: {error}"),
    }
}

async fn process_claim(store: PostgresMessageStore, claimed: ClaimedMessageRun) -> Result<()> {
    if claimed.parent_run_id.is_some() {
        return store
            .complete_child(&claimed.run_id, claimed.claim_epoch, "succeeded")
            .await;
    }

    let (awaited_children, detached_children) = child_plan(
        claimed.journey_kind,
        claimed.workload_ordinal.saturating_sub(1),
    );
    if awaited_children > 0 && !store.child_fanout_started(&claimed.run_id).await? {
        store
            .begin_child_fanout(&claimed.run_id, claimed.claim_epoch, awaited_children)
            .await?;
        return Ok(());
    }
    if detached_children > 0 && !store.detached_children_started(&claimed.run_id).await? {
        store
            .begin_detached_children(&claimed.run_id, claimed.claim_epoch, detached_children)
            .await?;
    }

    let output = format!(
        "Osfo AgentRun {} completed the durable message path.",
        claimed.run_id.as_str()
    );
    store
        .commit_assistant_output(&claimed.run_id, claimed.claim_epoch, &output)
        .await?;
    Ok(())
}

fn child_plan(journey_kind: JourneyKind, workload_ordinal: u64) -> (usize, usize) {
    match journey_kind {
        JourneyKind::ChildFanout | JourneyKind::FullReferenceJourney => (2, 0),
        JourneyKind::MeasuredAgentDecision => {
            let decision = measured_replay_decision(workload_ordinal);
            (
                usize::from(decision.awaited_child_agent_runs),
                usize::from(decision.detached_child_agent_runs),
            )
        }
        _ => (0, 0),
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::child_plan;
    use osfo_agent_run_lifecycle_prototype::workload::JourneyKind;

    #[test]
    fn full_reference_journey_uses_real_osfo_child_agent_runs() {
        assert_eq!(child_plan(JourneyKind::ChildFanout, 0), (2, 0));
        assert_eq!(child_plan(JourneyKind::FullReferenceJourney, 0), (2, 0));
        assert_eq!(child_plan(JourneyKind::BasicAgentRun, 0), (0, 0));
    }

    #[test]
    fn measured_profile_replays_awaited_and_detached_children() {
        assert_eq!(child_plan(JourneyKind::MeasuredAgentDecision, 27), (1, 0));
        assert_eq!(child_plan(JourneyKind::MeasuredAgentDecision, 24), (0, 1));
        assert_eq!(child_plan(JourneyKind::MeasuredAgentDecision, 33), (4, 0));
    }
}
