use std::{fs, path::PathBuf, time::SystemTime};

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::temporal_lane::TemporalWorkflowClient;

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let address = required_environment("TEMPORAL_ADDRESS")?;
    let task_queue = required_environment("TEMPORAL_TASK_QUEUE")?;
    let client_id = std::env::var("OSFO_TEMPORAL_CLIENT_ID")
        .unwrap_or_else(|_| "osfo-deployed-smoke-client".into());
    let workflow_id =
        std::env::var("OSFO_TEMPORAL_SMOKE_WORKFLOW_ID").unwrap_or_else(|_| unique_workflow_id());
    let output = std::env::var("OSFO_TEMPORAL_SMOKE_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("evidence/temporal-cloud-smoke.json"));

    let client = TemporalWorkflowClient::connect(&address, &client_id, &task_queue)
        .await
        .context("connect Temporal Cloud client")?;
    let report = client
        .run_load_named(workflow_id)
        .await
        .context("run workflow on deployed Temporal worker fleet")?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output, serde_json::to_vec_pretty(&report)?)?;
    println!("results={}", output.display());
    Ok(())
}

fn required_environment(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        anyhow::bail!("{name} must not be empty");
    }
    Ok(value)
}

fn unique_workflow_id() -> String {
    let unix_nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("osfo-deployed-temporal-smoke-{unix_nanos}")
}
