use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use futures_util::{StreamExt, stream::FuturesUnordered};
use osfo_agent_run_lifecycle_prototype::temporal_lane::TemporalWorkflowClient;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TemporalLoadSample {
    ordinal: usize,
    completion_latency_ms: f64,
    schedule_lag_ms: f64,
    completed: bool,
    semantic_checks_passed: bool,
    history_event_count: usize,
    worker_identities: Vec<String>,
    error_class: Option<String>,
}

impl TemporalLoadSample {
    #[cfg(test)]
    fn completed(
        ordinal: usize,
        completion_latency_ms: f64,
        history_event_count: usize,
        worker_identities: Vec<String>,
    ) -> Self {
        Self {
            ordinal,
            completion_latency_ms,
            schedule_lag_ms: 0.0,
            completed: true,
            semantic_checks_passed: true,
            history_event_count,
            worker_identities,
            error_class: None,
        }
    }

    #[cfg(test)]
    fn failed(ordinal: usize, completion_latency_ms: f64, error_class: &str) -> Self {
        Self {
            ordinal,
            completion_latency_ms,
            schedule_lag_ms: 0.0,
            completed: false,
            semantic_checks_passed: false,
            history_event_count: 0,
            worker_identities: Vec::new(),
            error_class: Some(error_class.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct LatencySummary {
    sample_count: usize,
    p50: f64,
    p90: f64,
    p95: f64,
    p99: f64,
    maximum: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TemporalLoadSummary {
    schema_version: u32,
    generated_at_unix_milliseconds: u128,
    temporal_service: String,
    temporal_sdk: String,
    arrival_pattern: String,
    offered: usize,
    completed: usize,
    failed: usize,
    offered_per_second: f64,
    completed_per_second: f64,
    offer_duration_seconds: f64,
    elapsed_seconds: f64,
    history_events: usize,
    worker_identities: Vec<String>,
    completion_latency_ms: LatencySummary,
    schedule_lag_ms: LatencySummary,
    error_classes: BTreeMap<String, usize>,
    correctness_passed: bool,
    samples: Vec<TemporalLoadSample>,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let address = required_environment("TEMPORAL_ADDRESS")?;
    let task_queue = required_environment("TEMPORAL_TASK_QUEUE")?;
    let rate = parse_positive_f64("OSFO_TEMPORAL_LOAD_RATE_PER_SECOND", 83.0)?;
    let duration_seconds = parse_positive_f64("OSFO_TEMPORAL_LOAD_DURATION_SECONDS", 15.0)?;
    let arrival_pattern =
        std::env::var("OSFO_TEMPORAL_LOAD_ARRIVAL_PATTERN").unwrap_or_else(|_| "uniform".into());
    arrival_offset_seconds(&arrival_pattern, 0, rate)?;
    let offered = std::env::var("OSFO_TEMPORAL_LOAD_COUNT")
        .ok()
        .map(|value| value.parse::<usize>())
        .transpose()
        .context("OSFO_TEMPORAL_LOAD_COUNT must be a positive integer")?
        .unwrap_or_else(|| (rate * duration_seconds).round() as usize);
    if offered == 0 {
        anyhow::bail!("Temporal load must offer at least one workflow");
    }
    let timeout_seconds = parse_positive_f64("OSFO_TEMPORAL_LOAD_TIMEOUT_SECONDS", 120.0)?;
    let output = std::env::var("OSFO_TEMPORAL_LOAD_OUTPUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("evidence/temporal-cloud-load/results.json"));
    let client_id = std::env::var("OSFO_TEMPORAL_CLIENT_ID")
        .unwrap_or_else(|_| "osfo-temporal-cloud-load-client".into());
    let workflow_prefix = std::env::var("OSFO_TEMPORAL_LOAD_WORKFLOW_PREFIX")
        .unwrap_or_else(|_| unique_workflow_prefix());
    let client = TemporalWorkflowClient::connect(&address, &client_id, &task_queue)
        .await
        .context("connect Temporal Cloud load client")?;

    let started = Instant::now();
    let mut tasks = FuturesUnordered::new();
    for ordinal in 0..offered {
        let offset = arrival_offset_seconds(&arrival_pattern, ordinal, rate)?;
        let scheduled = started + Duration::from_secs_f64(offset);
        tokio::time::sleep_until(scheduled).await;
        let schedule_lag_ms = scheduled.elapsed().as_secs_f64() * 1000.0;
        let workflow_id = format!("{workflow_prefix}-{ordinal:08}");
        let task_client = client.clone();
        tasks.push(tokio::spawn(async move {
            let outcome = tokio::time::timeout(
                Duration::from_secs_f64(timeout_seconds),
                task_client.run_load_named(workflow_id),
            )
            .await;
            let completion_latency_ms = scheduled.elapsed().as_secs_f64() * 1000.0;
            match outcome {
                Ok(Ok(report)) => {
                    let semantic_checks_passed = report.history_event_count > 0
                        && !report.worker_identities.is_empty()
                        && report.steps.iter().any(|step| step == "identity-validated")
                        && report.steps.iter().any(|step| step == "timer-fired")
                        && report
                            .steps
                            .iter()
                            .any(|step| step == "publish-succeeded-attempt-2")
                        && report
                            .steps
                            .iter()
                            .any(|step| step == "terminal-outcome-returned");
                    TemporalLoadSample {
                        ordinal,
                        completion_latency_ms,
                        schedule_lag_ms,
                        completed: true,
                        semantic_checks_passed,
                        history_event_count: report.history_event_count,
                        worker_identities: report.worker_identities,
                        error_class: (!semantic_checks_passed).then(|| "semantic-check".into()),
                    }
                }
                Ok(Err(_)) => TemporalLoadSample {
                    ordinal,
                    completion_latency_ms,
                    schedule_lag_ms,
                    completed: false,
                    semantic_checks_passed: false,
                    history_event_count: 0,
                    worker_identities: Vec::new(),
                    error_class: Some("temporal-service".into()),
                },
                Err(_) => TemporalLoadSample {
                    ordinal,
                    completion_latency_ms,
                    schedule_lag_ms,
                    completed: false,
                    semantic_checks_passed: false,
                    history_event_count: 0,
                    worker_identities: Vec::new(),
                    error_class: Some("completion-timeout".into()),
                },
            }
        }));
    }
    let offer_duration_seconds = started.elapsed().as_secs_f64();
    let mut samples = Vec::with_capacity(offered);
    while let Some(sample) = tasks.next().await {
        samples.push(sample.context("Temporal load task panicked")?);
    }
    samples.sort_by_key(|sample| sample.ordinal);
    let summary = summarize(
        &arrival_pattern,
        offered,
        started.elapsed().as_secs_f64(),
        samples,
    );
    let summary = TemporalLoadSummary {
        offer_duration_seconds,
        offered_per_second: offered as f64 / duration_seconds,
        ..summary
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output, serde_json::to_vec_pretty(&summary)?)?;
    println!("results={}", output.display());
    if !summary.correctness_passed {
        anyhow::bail!("Temporal Cloud load correctness failed, inspect generated evidence");
    }
    Ok(())
}

fn summarize(
    arrival_pattern: &str,
    offered: usize,
    elapsed_seconds: f64,
    samples: Vec<TemporalLoadSample>,
) -> TemporalLoadSummary {
    let completed = samples
        .iter()
        .filter(|sample| sample.completed && sample.semantic_checks_passed)
        .count();
    let failed = offered.saturating_sub(completed);
    let history_events = samples
        .iter()
        .map(|sample| sample.history_event_count)
        .sum();
    let worker_identities = samples
        .iter()
        .flat_map(|sample| sample.worker_identities.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let error_classes = samples
        .iter()
        .filter_map(|sample| sample.error_class.clone())
        .fold(BTreeMap::new(), |mut errors, error| {
            *errors.entry(error).or_insert(0) += 1;
            errors
        });
    let completion_latency_ms = summarize_latency(
        samples
            .iter()
            .map(|sample| sample.completion_latency_ms)
            .collect(),
    );
    let schedule_lag_ms = summarize_latency(
        samples
            .iter()
            .map(|sample| sample.schedule_lag_ms)
            .collect(),
    );
    TemporalLoadSummary {
        schema_version: 1,
        generated_at_unix_milliseconds: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        temporal_service: "Temporal Cloud".into(),
        temporal_sdk: "temporalio 0.5.0 Public Preview".into(),
        arrival_pattern: arrival_pattern.into(),
        offered,
        completed,
        failed,
        offered_per_second: offered as f64 / elapsed_seconds.max(f64::EPSILON),
        completed_per_second: completed as f64 / elapsed_seconds.max(f64::EPSILON),
        offer_duration_seconds: elapsed_seconds,
        elapsed_seconds,
        history_events,
        worker_identities,
        completion_latency_ms,
        schedule_lag_ms,
        error_classes,
        correctness_passed: offered > 0 && completed == offered && failed == 0,
        samples,
    }
}

fn summarize_latency(mut values: Vec<f64>) -> LatencySummary {
    values.sort_by(f64::total_cmp);
    LatencySummary {
        sample_count: values.len(),
        p50: percentile(&values, 0.50),
        p90: percentile(&values, 0.90),
        p95: percentile(&values, 0.95),
        p99: percentile(&values, 0.99),
        maximum: values.last().copied().unwrap_or_default(),
    }
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let rank = (quantile * values.len() as f64).ceil().max(1.0) as usize;
    values[rank.saturating_sub(1).min(values.len() - 1)]
}

fn arrival_offset_seconds(pattern: &str, ordinal: usize, rate: f64) -> Result<f64> {
    match pattern {
        "uniform" => Ok(ordinal as f64 / rate),
        "timer-herd" => Ok(0.0),
        _ => anyhow::bail!(
            "OSFO_TEMPORAL_LOAD_ARRIVAL_PATTERN must be uniform or timer-herd, got {pattern}"
        ),
    }
}

fn required_environment(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        anyhow::bail!("{name} must not be empty");
    }
    Ok(value)
}

fn parse_positive_f64(name: &str, default: f64) -> Result<f64> {
    let value = std::env::var(name)
        .ok()
        .map(|value| value.parse::<f64>())
        .transpose()
        .with_context(|| format!("{name} must be a positive number"))?
        .unwrap_or(default);
    if !value.is_finite() || value <= 0.0 {
        anyhow::bail!("{name} must be positive");
    }
    Ok(value)
}

fn unique_workflow_prefix() -> String {
    format!(
        "osfo-temporal-load-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_reconciles_workflows_and_latency_percentiles() {
        let samples = vec![
            TemporalLoadSample::completed(0, 10.0, 41, vec!["worker-a".into()]),
            TemporalLoadSample::completed(1, 20.0, 43, vec!["worker-b".into()]),
            TemporalLoadSample::failed(2, 30.0, "service"),
        ];

        let summary = summarize("uniform", 3, 1.0, samples);

        assert_eq!(summary.offered, 3);
        assert_eq!(summary.completed, 2);
        assert_eq!(summary.failed, 1);
        assert_eq!(summary.history_events, 84);
        assert_eq!(summary.worker_identities, vec!["worker-a", "worker-b"]);
        assert_eq!(summary.completion_latency_ms.p50, 20.0);
        assert_eq!(summary.completion_latency_ms.p95, 30.0);
        assert!(!summary.correctness_passed);
    }

    #[test]
    fn arrival_offsets_distinguish_uniform_from_timer_herd() {
        assert_eq!(arrival_offset_seconds("uniform", 2, 10.0).unwrap(), 0.2);
        assert_eq!(arrival_offset_seconds("timer-herd", 99, 10.0).unwrap(), 0.0);
        assert!(arrival_offset_seconds("unknown", 0, 10.0).is_err());
    }
}
