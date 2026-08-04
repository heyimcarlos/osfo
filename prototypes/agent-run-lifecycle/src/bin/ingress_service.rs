use std::time::Duration;

use anyhow::{Context, Result};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let database_url = std::env::var("OSFO_DATABASE_URL")
        .or_else(|_| std::env::var("OSFO_TEST_DATABASE_URL"))
        .context("OSFO_DATABASE_URL is required")?;
    let account_id =
        std::env::var("OSFO_INGRESS_ACCOUNT_ID").context("OSFO_INGRESS_ACCOUNT_ID is required")?;
    let bearer_token = std::env::var("OSFO_INGRESS_BEARER_TOKEN")
        .context("OSFO_INGRESS_BEARER_TOKEN is required")?;
    let pool_size = std::env::var("OSFO_INGRESS_DATABASE_POOL_SIZE")
        .unwrap_or_else(|_| "16".into())
        .parse::<u32>()
        .context("OSFO_INGRESS_DATABASE_POOL_SIZE must be a positive integer")?;
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "8080".into())
        .parse::<u16>()
        .context("PORT must be a valid TCP port")?;
    let app = osfo_agent_run_lifecycle_prototype::ingress_http::app(
        &database_url,
        &account_id,
        &bearer_token,
        pool_size,
    )
    .await?;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
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
    tokio::time::sleep(Duration::from_millis(50)).await;
}
