use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::ingress::PostgresMessageStore;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let database_url = std::env::var("OSFO_DATABASE_URL")
        .or_else(|_| std::env::var("OSFO_TEST_DATABASE_URL"))
        .context("OSFO_DATABASE_URL is required")?;
    let store = PostgresMessageStore::connect(&database_url, 1)?;
    store
        .initialize_empty_schema()
        .await
        .context("initialize empty AgentRun lifecycle schema")?;
    println!("Empty AgentRun lifecycle schema initialized");
    Ok(())
}
