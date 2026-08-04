use std::time::Duration;

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::temporal_lane::{
    TemporalWorkerFleet, TemporalWorkerFleetConfig,
};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let address = required_environment("TEMPORAL_ADDRESS")?;
    let task_queue = required_environment("TEMPORAL_TASK_QUEUE")?;
    let fleet_id = std::env::var("OSFO_TEMPORAL_WORKER_FLEET_ID")
        .unwrap_or_else(|_| "osfo-temporal-cloud-worker".into());
    let slots = parse_positive_usize("OSFO_TEMPORAL_WORKER_SLOTS", 32)?;
    let metrics_address =
        std::env::var("OSFO_TEMPORAL_METRICS_ADDRESS").unwrap_or_else(|_| "0.0.0.0:9465".into());

    let fleet = TemporalWorkerFleet::start(
        &address,
        TemporalWorkerFleetConfig {
            fleet_id: fleet_id.clone(),
            metrics_address,
            task_queue: task_queue.clone(),
            workflow_slots: slots,
            activity_slots: slots,
        },
    )
    .await
    .context("start Temporal Cloud worker fleet")?;
    println!(
        "Temporal Cloud worker ready: fleet={fleet_id} task_queue={task_queue} slots={slots} metrics={}",
        fleet.metrics_address()
    );

    shutdown_signal().await?;
    fleet
        .shutdown()
        .await
        .context("stop Temporal Cloud worker fleet")
}

fn required_environment(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        anyhow::bail!("{name} must not be empty");
    }
    Ok(value)
}

fn parse_positive_usize(name: &str, default: usize) -> Result<usize> {
    let value = std::env::var(name)
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()
        .with_context(|| format!("{name} must be a positive integer"))?
        .unwrap_or(default);
    if value == 0 {
        anyhow::bail!("{name} must be positive");
    }
    Ok(value)
}

async fn shutdown_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .context("install SIGTERM handler")?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result.context("wait for Ctrl-C")?,
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await.context("wait for Ctrl-C")?;
    tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(())
}
