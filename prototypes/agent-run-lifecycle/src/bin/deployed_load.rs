use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use futures_util::StreamExt;
use hdrhistogram::Histogram;
use reqwest::{Client, StatusCode, header};
use serde::{Deserialize, Serialize};
use tokio::{sync::Semaphore, task::JoinSet, time::Instant as TokioInstant};

use osfo_agent_run_lifecycle_prototype::ingress::RunEvidenceSnapshot;
use osfo_agent_run_lifecycle_prototype::load::{LinearRampSchedule, OpenLoopSchedule};
use osfo_agent_run_lifecycle_prototype::workload::JourneyKind;

#[derive(Clone)]
struct LoadConfig {
    base_url: String,
    stream_base_url: String,
    bearer_token: String,
    scenario: String,
    journey_profile: JourneyProfile,
    journey_override: Option<String>,
    arrival_pattern: ArrivalPattern,
    rate_per_second: f64,
    start_rate_per_second: Option<f64>,
    duration: Duration,
    idle_before: Duration,
    maximum_in_flight: usize,
    completion_timeout: Duration,
    ca_certificate_path: Option<PathBuf>,
    output_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
struct Sample {
    ordinal: u64,
    journey_kind: String,
    scheduled_at_unix_microseconds: u64,
    offered_at_unix_microseconds: u64,
    arrival_lag_microseconds: u64,
    admission_status: u16,
    admission_microseconds: u64,
    completion_microseconds: Option<u64>,
    authoritative_completion_microseconds: Option<u64>,
    run_id: Option<String>,
    idempotency_replay_checked: bool,
    idempotency_replay_passed: bool,
    evidence_checked: bool,
    evidence_passed: bool,
    evidence: Option<RunEvidenceSnapshot>,
    error_class: Option<String>,
}

#[derive(Debug, Serialize)]
struct LoadResult {
    schema_version: u32,
    scenario: String,
    started_at_unix_microseconds: u64,
    ended_at_unix_microseconds: u64,
    journey_profile: JourneyProfile,
    journey_override: Option<String>,
    arrival_pattern: ArrivalPattern,
    rate_per_second: f64,
    start_rate_per_second: Option<f64>,
    duration_seconds: f64,
    idle_before_seconds: f64,
    maximum_in_flight: usize,
    offered: u64,
    caller_drop: u64,
    accepted: u64,
    completed: u64,
    accepted_within_offer_window: u64,
    completed_within_offer_window: u64,
    authoritative_completed_within_offer_window: u64,
    rejected_or_failed: u64,
    duplicate_checks: u64,
    duplicate_checks_passed: u64,
    evidence_checks: u64,
    evidence_checks_passed: u64,
    amplification: AmplificationSummary,
    elapsed_seconds: f64,
    drain_seconds: f64,
    accepted_during_offer_per_second: f64,
    completed_during_offer_per_second: f64,
    authoritative_completed_during_offer_per_second: f64,
    accepted_per_second: f64,
    completed_per_second: f64,
    admission_latency: LatencySummary,
    completion_latency: LatencySummary,
    authoritative_completion_latency: LatencySummary,
    arrival_lag: LatencySummary,
    evidence_reconciliation_seconds: f64,
    correctness_passed: bool,
    errors: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
struct LatencySummary {
    sample_count: u64,
    p50_ms: f64,
    p90_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    maximum_ms: f64,
}

#[derive(Debug, Default, Serialize)]
struct AmplificationSummary {
    quick_replies_per_message: f64,
    agent_runs_per_message: f64,
    child_agent_runs_per_message: f64,
    awaited_child_agent_runs_per_message: f64,
    detached_child_agent_runs_per_message: f64,
    thread_events_per_message: f64,
    workflow_instances_per_message: f64,
    workflow_deliveries_per_message: f64,
    workflow_activities_per_message: f64,
    tool_calls_per_message: f64,
    approvals_per_message: f64,
    tool_attempts_per_message: f64,
    proactive_messages_per_message: f64,
    scheduled_reminders_per_message: f64,
    sandbox_jobs_per_message: f64,
    artifact_commits_per_message: f64,
}

#[derive(Debug, Deserialize)]
struct AdmissionReceipt {
    run_id: String,
    event_sequence: u64,
    idempotent_replay: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum JourneyProfile {
    Basic,
    Issue13,
    LunaDiscovery,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum ArrivalPattern {
    Uniform,
    LinearRamp,
    Burst,
    IdleToBurst,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let config = LoadConfig::from_environment()?;
    let result = run(config.clone()).await?;
    fs::create_dir_all(&config.output_dir)?;
    fs::write(
        config.output_dir.join("results.json"),
        serde_json::to_vec_pretty(&result)?,
    )?;
    if !result.correctness_passed {
        anyhow::bail!("deployed load correctness gate failed");
    }
    println!(
        "results={}",
        config.output_dir.join("results.json").display()
    );
    Ok(())
}

impl LoadConfig {
    fn from_environment() -> Result<Self> {
        let base_url = required("OSFO_LOAD_BASE_URL")?
            .trim_end_matches('/')
            .to_owned();
        let stream_base_url = std::env::var("OSFO_LOAD_STREAM_BASE_URL")
            .unwrap_or_else(|_| base_url.clone())
            .trim_end_matches('/')
            .to_owned();
        let bearer_token = required("OSFO_INGRESS_BEARER_TOKEN")?;
        let scenario = required("OSFO_LOAD_SCENARIO")?;
        let journey_profile = match std::env::var("OSFO_LOAD_JOURNEY_PROFILE")
            .unwrap_or_else(|_| "issue13".into())
            .as_str()
        {
            "basic" => JourneyProfile::Basic,
            "issue13" => JourneyProfile::Issue13,
            "luna-discovery" => JourneyProfile::LunaDiscovery,
            value => {
                anyhow::bail!(
                    "OSFO_LOAD_JOURNEY_PROFILE must be basic, issue13, or luna-discovery, got {value}"
                )
            }
        };
        let journey_override = std::env::var("OSFO_LOAD_JOURNEY_OVERRIDE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| JourneyKind::parse(&value).map(|kind| kind.as_str().to_owned()))
            .transpose()?;
        let arrival_pattern = match std::env::var("OSFO_LOAD_ARRIVAL_PATTERN")
            .unwrap_or_else(|_| "uniform".into())
            .as_str()
        {
            "uniform" => ArrivalPattern::Uniform,
            "linear-ramp" => ArrivalPattern::LinearRamp,
            "burst" => ArrivalPattern::Burst,
            "idle-to-burst" => ArrivalPattern::IdleToBurst,
            value => anyhow::bail!(
                "OSFO_LOAD_ARRIVAL_PATTERN must be uniform, linear-ramp, burst, or idle-to-burst, got {value}"
            ),
        };
        let rate_per_second = parse_positive_f64("OSFO_LOAD_RATE_PER_SECOND")?;
        let start_rate_per_second = std::env::var("OSFO_LOAD_START_RATE_PER_SECOND")
            .ok()
            .map(|value| {
                value
                    .parse::<f64>()
                    .context("OSFO_LOAD_START_RATE_PER_SECOND must be positive")
            })
            .transpose()?;
        let duration = Duration::from_secs(parse_positive_u64("OSFO_LOAD_DURATION_SECONDS")?);
        let idle_before = if matches!(arrival_pattern, ArrivalPattern::IdleToBurst) {
            Duration::from_secs(
                std::env::var("OSFO_LOAD_IDLE_SECONDS")
                    .unwrap_or_else(|_| "30".into())
                    .parse::<u64>()
                    .context("OSFO_LOAD_IDLE_SECONDS must be positive")?,
            )
        } else {
            Duration::ZERO
        };
        arrival_offsets(
            arrival_pattern,
            rate_per_second,
            duration,
            start_rate_per_second,
            idle_before,
        )?;
        let maximum_in_flight = std::env::var("OSFO_LOAD_MAXIMUM_IN_FLIGHT")
            .unwrap_or_else(|_| "2048".into())
            .parse::<usize>()
            .context("OSFO_LOAD_MAXIMUM_IN_FLIGHT must be positive")?;
        if maximum_in_flight == 0 {
            anyhow::bail!("OSFO_LOAD_MAXIMUM_IN_FLIGHT must be positive");
        }
        let completion_timeout = Duration::from_secs(
            std::env::var("OSFO_LOAD_COMPLETION_TIMEOUT_SECONDS")
                .unwrap_or_else(|_| "60".into())
                .parse::<u64>()
                .context("OSFO_LOAD_COMPLETION_TIMEOUT_SECONDS must be positive")?,
        );
        let ca_certificate_path = std::env::var("OSFO_LOAD_CA_CERT_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let output_dir = std::env::var("OSFO_LOAD_OUTPUT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("evidence/deployed-load-latest"));
        Ok(Self {
            base_url,
            stream_base_url,
            bearer_token,
            scenario,
            journey_profile,
            journey_override,
            arrival_pattern,
            rate_per_second,
            start_rate_per_second,
            duration,
            idle_before,
            maximum_in_flight,
            completion_timeout,
            ca_certificate_path,
            output_dir,
        })
    }
}

async fn run(config: LoadConfig) -> Result<LoadResult> {
    let offsets = arrival_offsets(
        config.arrival_pattern,
        config.rate_per_second,
        config.duration,
        config.start_rate_per_second,
        config.idle_before,
    )?;
    let total = offsets.len() as u64;
    let mut client_builder = Client::builder()
        .pool_max_idle_per_host(config.maximum_in_flight)
        .tcp_nodelay(true);
    if let Some(ca_certificate_path) = &config.ca_certificate_path {
        let certificate =
            reqwest::Certificate::from_pem(&fs::read(ca_certificate_path).with_context(|| {
                format!(
                    "read OSFO_LOAD_CA_CERT_PATH {}",
                    ca_certificate_path.display()
                )
            })?)?;
        client_builder = client_builder.add_root_certificate(certificate);
    }
    let client = client_builder.build()?;
    let mut authorization = header::HeaderValue::from_str(&config.bearer_token)?;
    authorization.set_sensitive(true);
    let authorization = Arc::new(authorization);
    let semaphore = Arc::new(Semaphore::new(config.maximum_in_flight));
    let started = Instant::now();
    let schedule_start = TokioInstant::now();
    let schedule_start_unix_microseconds = unix_microseconds();
    let mut tasks = JoinSet::new();
    let mut samples = Vec::with_capacity(total as usize);

    for (ordinal, target_offset) in offsets.into_iter().enumerate() {
        let ordinal = ordinal as u64;
        let scheduled = schedule_start + target_offset;
        let scheduled_at_unix_microseconds =
            schedule_start_unix_microseconds + target_offset.as_micros() as u64;
        tokio::time::sleep_until(scheduled).await;
        let Ok(permit) = semaphore.clone().try_acquire_owned() else {
            samples.push(caller_drop_sample(
                &config,
                ordinal,
                scheduled_at_unix_microseconds,
            ));
            continue;
        };
        let task_client = client.clone();
        let task_config = config.clone();
        let task_authorization = authorization.clone();
        tasks.spawn(async move {
            let _permit = permit;
            execute_message(
                &task_client,
                &task_config,
                task_authorization.as_ref(),
                ordinal,
                scheduled_at_unix_microseconds,
            )
            .await
        });
    }

    while let Some(task) = tasks.join_next().await {
        samples.push(task.context("load task panicked")?);
    }
    let elapsed_seconds = started.elapsed().as_secs_f64();
    let ended_at_unix_microseconds = unix_microseconds();
    let evidence_started = Instant::now();
    collect_evidence(&client, &config, authorization.as_ref(), &mut samples).await;
    let evidence_reconciliation_seconds = evidence_started.elapsed().as_secs_f64();
    samples.sort_by_key(|sample| sample.ordinal);
    let caller_drop = samples
        .iter()
        .filter(|sample| sample.error_class.as_deref() == Some("caller-capacity"))
        .count() as u64;
    write_raw_samples(&config.output_dir, &samples)?;
    Ok(summarize(
        &config,
        total,
        caller_drop,
        schedule_start_unix_microseconds,
        ended_at_unix_microseconds,
        elapsed_seconds,
        evidence_reconciliation_seconds,
        &samples,
    ))
}

async fn execute_message(
    client: &Client,
    config: &LoadConfig,
    authorization: &header::HeaderValue,
    ordinal: u64,
    scheduled_at_unix_microseconds: u64,
) -> Sample {
    let started = Instant::now();
    let journey_kind = config
        .journey_override
        .clone()
        .unwrap_or_else(|| journey_kind(config.journey_profile, ordinal).to_owned());
    let identity = format!("{}-{ordinal}", config.scenario);
    let thread_id = format!("thread-{identity}");
    let idempotency_key = format!("idem-{identity}");
    let offered_at_unix_microseconds = unix_microseconds();
    let arrival_lag_microseconds =
        offered_at_unix_microseconds.saturating_sub(scheduled_at_unix_microseconds);
    let response = client
        .post(format!(
            "{}/v1/threads/{thread_id}/messages",
            config.base_url
        ))
        .header("x-osfo-ingress-token", authorization.clone())
        .header("idempotency-key", &idempotency_key)
        .json(&serde_json::json!({
            "message_id": format!("message-{identity}"),
            "content": format!("deterministic deployed load message {ordinal}"),
            "journey_kind": journey_kind,
        }))
        .send()
        .await;
    let admission_microseconds = started.elapsed().as_micros() as u64;
    let Ok(response) = response else {
        return failed_sample(
            ordinal,
            journey_kind,
            scheduled_at_unix_microseconds,
            offered_at_unix_microseconds,
            admission_microseconds,
            0,
            "admission-transport",
        );
    };
    let admission_status = response.status();
    if admission_status != StatusCode::CREATED {
        return failed_sample(
            ordinal,
            journey_kind,
            scheduled_at_unix_microseconds,
            offered_at_unix_microseconds,
            admission_microseconds,
            admission_status.as_u16(),
            "admission-status",
        );
    }
    let receipt = match response.json::<AdmissionReceipt>().await {
        Ok(receipt) => receipt,
        Err(_) => {
            return failed_sample(
                ordinal,
                journey_kind,
                scheduled_at_unix_microseconds,
                offered_at_unix_microseconds,
                admission_microseconds,
                admission_status.as_u16(),
                "admission-body",
            );
        }
    };
    if receipt.idempotent_replay {
        return failed_sample(
            ordinal,
            journey_kind,
            scheduled_at_unix_microseconds,
            offered_at_unix_microseconds,
            admission_microseconds,
            admission_status.as_u16(),
            "unexpected-first-replay",
        );
    }
    let completed = await_completion(client, config, authorization, &thread_id, &receipt).await;
    let completion_microseconds = started.elapsed().as_micros() as u64;
    if !completed {
        return Sample {
            ordinal,
            journey_kind,
            scheduled_at_unix_microseconds,
            offered_at_unix_microseconds,
            arrival_lag_microseconds,
            admission_status: admission_status.as_u16(),
            admission_microseconds,
            completion_microseconds: None,
            authoritative_completion_microseconds: None,
            run_id: Some(receipt.run_id),
            idempotency_replay_checked: false,
            idempotency_replay_passed: false,
            evidence_checked: false,
            evidence_passed: false,
            evidence: None,
            error_class: Some("completion-timeout-or-stream".into()),
        };
    }

    let replay_checked = ordinal % 100 == 0;
    let replay_passed = if replay_checked {
        verify_idempotent_replay(
            client,
            config,
            authorization,
            &thread_id,
            &idempotency_key,
            ordinal,
            &journey_kind,
            &receipt.run_id,
        )
        .await
    } else {
        false
    };
    Sample {
        ordinal,
        journey_kind,
        scheduled_at_unix_microseconds,
        offered_at_unix_microseconds,
        arrival_lag_microseconds,
        admission_status: admission_status.as_u16(),
        admission_microseconds,
        completion_microseconds: Some(completion_microseconds),
        authoritative_completion_microseconds: None,
        run_id: Some(receipt.run_id),
        idempotency_replay_checked: replay_checked,
        idempotency_replay_passed: replay_passed,
        evidence_checked: false,
        evidence_passed: false,
        evidence: None,
        error_class: (replay_checked && !replay_passed).then(|| "idempotency-replay".into()),
    }
}

async fn collect_evidence(
    client: &Client,
    config: &LoadConfig,
    authorization: &header::HeaderValue,
    samples: &mut [Sample],
) {
    let jobs = samples
        .iter()
        .filter_map(|sample| {
            sample
                .run_id
                .as_ref()
                .map(|run_id| (sample.ordinal, sample.journey_kind.clone(), run_id.clone()))
        })
        .collect::<Vec<_>>();
    let results = futures_util::stream::iter(jobs)
        .map(|(ordinal, journey_kind, run_id)| async move {
            let evidence = fetch_run_evidence(client, config, authorization, &run_id).await;
            (ordinal, journey_kind, evidence)
        })
        .buffer_unordered(32)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|(ordinal, journey_kind, evidence)| (ordinal, (journey_kind, evidence)))
        .collect::<std::collections::HashMap<_, _>>();
    for sample in samples {
        let Some((journey_kind, evidence)) = results.get(&sample.ordinal) else {
            continue;
        };
        sample.evidence_checked = true;
        sample.authoritative_completion_microseconds = evidence
            .as_ref()
            .and_then(|snapshot| snapshot.root_terminal_at_unix_microseconds)
            .map(|terminal_at| terminal_at.saturating_sub(sample.offered_at_unix_microseconds));
        sample.evidence_passed = evidence
            .as_ref()
            .is_some_and(|snapshot| evidence_matches(journey_kind, snapshot));
        sample.evidence = evidence.clone();
        if !sample.evidence_passed && sample.error_class.is_none() {
            sample.error_class = Some(
                if sample.evidence.is_some() {
                    "database-evidence"
                } else {
                    "evidence-unavailable"
                }
                .into(),
            );
        }
    }
}

async fn fetch_run_evidence(
    client: &Client,
    config: &LoadConfig,
    authorization: &header::HeaderValue,
    run_id: &str,
) -> Option<RunEvidenceSnapshot> {
    for attempt in 0_u64..10 {
        let response = client
            .get(format!(
                "{}/v1/agent-runs/{run_id}/evidence",
                config.base_url
            ))
            .header("x-osfo-ingress-token", authorization.clone())
            .send()
            .await;
        if let Ok(response) = response
            && response.status().is_success()
            && let Ok(evidence) = response.json().await
        {
            return Some(evidence);
        }
        tokio::time::sleep(Duration::from_millis(100 * (attempt + 1))).await;
    }
    None
}

fn evidence_matches(journey_kind: &str, evidence: &RunEvidenceSnapshot) -> bool {
    let terminal = evidence.root_state == "succeeded"
        && evidence.terminal_agent_runs == evidence.total_agent_runs;
    match journey_kind {
        "basic-agent-run" => {
            terminal
                && evidence.total_agent_runs == 1
                && evidence.child_agent_runs == 0
                && evidence.thread_events == 2
                && evidence.workflow_instances == 0
                && evidence.tool_calls == 0
        }
        "child-fanout" => {
            terminal
                && evidence.total_agent_runs == 3
                && evidence.child_agent_runs == 2
                && evidence.thread_events == 2
        }
        "awaited-workflow" | "detached-workflow" => {
            terminal
                && evidence.total_agent_runs == 1
                && evidence.workflow_instances == 1
                && evidence.workflow_deliveries == 1
        }
        "sandbox-artifact" => terminal && evidence.interaction_records >= 4,
        "approval-smtp" => {
            terminal
                && evidence.tool_calls == 1
                && evidence.approvals == 1
                && evidence.tool_attempts == 1
        }
        "full-reference-journey" => {
            terminal
                && evidence.total_agent_runs == 3
                && evidence.child_agent_runs == 2
                && evidence.workflow_instances == 1
                && evidence.workflow_deliveries == 1
                && evidence.tool_calls == 1
                && evidence.approvals == 1
                && evidence.tool_attempts == 1
                && evidence.interaction_records >= 6
        }
        "measured-agent-decision" => terminal && evidence.decision_matches_actual,
        _ => false,
    }
}

async fn await_completion(
    client: &Client,
    config: &LoadConfig,
    authorization: &header::HeaderValue,
    thread_id: &str,
    receipt: &AdmissionReceipt,
) -> bool {
    let request = client
        .get(format!(
            "{}/v1/threads/{thread_id}/stream?after={}&until_run_id={}",
            config.stream_base_url, receipt.event_sequence, receipt.run_id
        ))
        .header("x-osfo-ingress-token", authorization.clone())
        .send();
    let Ok(Ok(response)) = tokio::time::timeout(config.completion_timeout, request).await else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let expected_run = format!("\"run_id\":\"{}\"", receipt.run_id);
    let mut stream = response.bytes_stream();
    let wait = async {
        let mut buffered = String::new();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                return false;
            };
            buffered.push_str(&String::from_utf8_lossy(&chunk));
            if buffered.contains("event: assistant.message.completed")
                && buffered.contains(&expected_run)
            {
                return true;
            }
            if buffered.len() > 64 * 1024 {
                buffered.drain(..32 * 1024);
            }
        }
        false
    };
    tokio::time::timeout(config.completion_timeout, wait)
        .await
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
async fn verify_idempotent_replay(
    client: &Client,
    config: &LoadConfig,
    authorization: &header::HeaderValue,
    thread_id: &str,
    idempotency_key: &str,
    ordinal: u64,
    journey_kind: &str,
    expected_run_id: &str,
) -> bool {
    let response = client
        .post(format!(
            "{}/v1/threads/{thread_id}/messages",
            config.base_url
        ))
        .header("x-osfo-ingress-token", authorization.clone())
        .header("idempotency-key", idempotency_key)
        .json(&serde_json::json!({
            "message_id": format!("message-{}-{ordinal}", config.scenario),
            "content": format!("deterministic deployed load message {ordinal}"),
            "journey_kind": journey_kind,
        }))
        .send()
        .await;
    let Ok(response) = response else {
        return false;
    };
    if response.status() != StatusCode::OK {
        return false;
    }
    response
        .json::<AdmissionReceipt>()
        .await
        .map(|receipt| receipt.idempotent_replay && receipt.run_id == expected_run_id)
        .unwrap_or(false)
}

fn summarize(
    config: &LoadConfig,
    offered: u64,
    caller_drop: u64,
    started_at_unix_microseconds: u64,
    ended_at_unix_microseconds: u64,
    elapsed_seconds: f64,
    evidence_reconciliation_seconds: f64,
    samples: &[Sample],
) -> LoadResult {
    let accepted = samples
        .iter()
        .filter(|sample| sample.admission_status == StatusCode::CREATED.as_u16())
        .count() as u64;
    let completed = samples
        .iter()
        .filter(|sample| sample.completion_microseconds.is_some())
        .count() as u64;
    let duplicate_checks = samples
        .iter()
        .filter(|sample| sample.idempotency_replay_checked)
        .count() as u64;
    let duplicate_checks_passed = samples
        .iter()
        .filter(|sample| sample.idempotency_replay_passed)
        .count() as u64;
    let evidence_checks = samples
        .iter()
        .filter(|sample| sample.evidence_checked)
        .count() as u64;
    let evidence_checks_passed = samples
        .iter()
        .filter(|sample| sample.evidence_passed)
        .count() as u64;
    let errors = samples
        .iter()
        .filter_map(|sample| sample.error_class.clone())
        .fold(Vec::<String>::new(), |mut errors, error| {
            if !errors.contains(&error) {
                errors.push(error);
            }
            errors
        });
    let rejected_or_failed = offered.saturating_sub(caller_drop + completed);
    let full_offer_window = config.idle_before + config.duration;
    let offer_window_end = started_at_unix_microseconds + full_offer_window.as_micros() as u64;
    let accepted_within_offer_window = samples
        .iter()
        .filter(|sample| {
            sample.admission_status == StatusCode::CREATED.as_u16()
                && sample.offered_at_unix_microseconds + sample.admission_microseconds
                    <= offer_window_end
        })
        .count() as u64;
    let completed_within_offer_window = samples
        .iter()
        .filter(|sample| {
            sample.completion_microseconds.is_some_and(|latency| {
                sample.offered_at_unix_microseconds + latency <= offer_window_end
            })
        })
        .count() as u64;
    let authoritative_completed_within_offer_window = samples
        .iter()
        .filter(|sample| {
            sample
                .authoritative_completion_microseconds
                .is_some_and(|latency| {
                    sample.offered_at_unix_microseconds + latency <= offer_window_end
                })
        })
        .count() as u64;
    let offer_seconds = config.duration.as_secs_f64();
    LoadResult {
        schema_version: 1,
        scenario: config.scenario.clone(),
        started_at_unix_microseconds,
        ended_at_unix_microseconds,
        journey_profile: config.journey_profile,
        journey_override: config.journey_override.clone(),
        arrival_pattern: config.arrival_pattern,
        rate_per_second: config.rate_per_second,
        start_rate_per_second: config.start_rate_per_second,
        duration_seconds: config.duration.as_secs_f64(),
        idle_before_seconds: config.idle_before.as_secs_f64(),
        maximum_in_flight: config.maximum_in_flight,
        offered,
        caller_drop,
        accepted,
        completed,
        accepted_within_offer_window,
        completed_within_offer_window,
        authoritative_completed_within_offer_window,
        rejected_or_failed,
        duplicate_checks,
        duplicate_checks_passed,
        evidence_checks,
        evidence_checks_passed,
        amplification: amplification(samples),
        elapsed_seconds,
        drain_seconds: (elapsed_seconds - full_offer_window.as_secs_f64()).max(0.0),
        accepted_during_offer_per_second: accepted_within_offer_window as f64 / offer_seconds,
        completed_during_offer_per_second: completed_within_offer_window as f64 / offer_seconds,
        authoritative_completed_during_offer_per_second: authoritative_completed_within_offer_window
            as f64
            / offer_seconds,
        accepted_per_second: accepted as f64 / elapsed_seconds,
        completed_per_second: completed as f64 / elapsed_seconds,
        admission_latency: latency(samples.iter().map(|sample| sample.admission_microseconds)),
        completion_latency: latency(
            samples
                .iter()
                .filter_map(|sample| sample.completion_microseconds),
        ),
        authoritative_completion_latency: latency(
            samples
                .iter()
                .filter_map(|sample| sample.authoritative_completion_microseconds),
        ),
        arrival_lag: latency(samples.iter().map(|sample| sample.arrival_lag_microseconds)),
        evidence_reconciliation_seconds,
        correctness_passed: caller_drop == 0
            && accepted == offered
            && completed == accepted
            && duplicate_checks == duplicate_checks_passed
            && evidence_checks == accepted
            && evidence_checks == evidence_checks_passed
            && errors.is_empty(),
        errors,
    }
}

fn arrival_offsets(
    pattern: ArrivalPattern,
    rate_per_second: f64,
    duration: Duration,
    start_rate_per_second: Option<f64>,
    idle_before: Duration,
) -> Result<Vec<Duration>> {
    match pattern {
        ArrivalPattern::Uniform => {
            let schedule =
                OpenLoopSchedule::new(rate_per_second, duration, Duration::from_millis(1))?;
            Ok((0..schedule.offered_count())
                .map(|ordinal| schedule.target_offset(ordinal))
                .collect())
        }
        ArrivalPattern::LinearRamp => {
            let start_rate_per_second = start_rate_per_second
                .context("OSFO_LOAD_START_RATE_PER_SECOND is required for a linear-ramp pattern")?;
            let schedule = LinearRampSchedule::new(
                start_rate_per_second,
                rate_per_second,
                duration,
                Duration::from_millis(1),
            )?;
            Ok((0..schedule.offered_count())
                .map(|ordinal| schedule.target_offset(ordinal))
                .collect())
        }
        ArrivalPattern::Burst | ArrivalPattern::IdleToBurst => {
            if matches!(pattern, ArrivalPattern::IdleToBurst) && idle_before.is_zero() {
                anyhow::bail!("OSFO_LOAD_IDLE_SECONDS must be positive for idle-to-burst")
            }
            let offered_count = (rate_per_second * duration.as_secs_f64()).round() as usize;
            if offered_count == 0 {
                anyhow::bail!("burst schedule must offer at least one arrival")
            }
            Ok(vec![idle_before; offered_count])
        }
    }
}

fn amplification(samples: &[Sample]) -> AmplificationSummary {
    let evidence = samples
        .iter()
        .filter_map(|sample| sample.evidence.as_ref())
        .collect::<Vec<_>>();
    if evidence.is_empty() {
        return AmplificationSummary::default();
    }
    let denominator = evidence.len() as f64;
    let average = |select: fn(&RunEvidenceSnapshot) -> u64| {
        evidence.iter().map(|item| select(item)).sum::<u64>() as f64 / denominator
    };
    AmplificationSummary {
        quick_replies_per_message: evidence.iter().filter(|item| item.quick_reply).count() as f64
            / denominator,
        agent_runs_per_message: average(|item| item.total_agent_runs),
        child_agent_runs_per_message: average(|item| item.child_agent_runs),
        awaited_child_agent_runs_per_message: average(|item| item.awaited_child_agent_runs),
        detached_child_agent_runs_per_message: average(|item| item.detached_child_agent_runs),
        thread_events_per_message: average(|item| item.thread_events),
        workflow_instances_per_message: average(|item| item.workflow_instances),
        workflow_deliveries_per_message: average(|item| item.workflow_deliveries),
        workflow_activities_per_message: average(|item| item.workflow_activities),
        tool_calls_per_message: average(|item| item.tool_calls),
        approvals_per_message: average(|item| item.approvals),
        tool_attempts_per_message: average(|item| item.tool_attempts),
        proactive_messages_per_message: average(|item| item.proactive_messages),
        scheduled_reminders_per_message: average(|item| item.scheduled_reminders),
        sandbox_jobs_per_message: average(|item| item.sandbox_jobs),
        artifact_commits_per_message: average(|item| item.artifact_commits),
    }
}

fn latency(values: impl Iterator<Item = u64>) -> LatencySummary {
    let mut histogram =
        Histogram::<u64>::new_with_max(3_600_000_000, 3).expect("valid latency histogram bounds");
    for value in values {
        let _ = histogram.record(value.max(1));
    }
    if histogram.is_empty() {
        return LatencySummary::default();
    }
    LatencySummary {
        sample_count: histogram.len(),
        p50_ms: histogram.value_at_quantile(0.50) as f64 / 1_000.0,
        p90_ms: histogram.value_at_quantile(0.90) as f64 / 1_000.0,
        p95_ms: histogram.value_at_quantile(0.95) as f64 / 1_000.0,
        p99_ms: histogram.value_at_quantile(0.99) as f64 / 1_000.0,
        maximum_ms: histogram.max() as f64 / 1_000.0,
    }
}

fn write_raw_samples(output_dir: &PathBuf, samples: &[Sample]) -> Result<()> {
    fs::create_dir_all(output_dir)?;
    let mut csv = String::from(
        "ordinal,journey_kind,scheduled_at_unix_microseconds,offered_at_unix_microseconds,arrival_lag_microseconds,admission_status,admission_microseconds,completion_microseconds,authoritative_completion_microseconds,run_id,idempotency_replay_checked,idempotency_replay_passed,evidence_checked,evidence_passed,total_agent_runs,child_agent_runs,thread_events,workflow_instances,tool_calls,approvals,tool_attempts,error_class\n",
    );
    for sample in samples {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            sample.ordinal,
            sample.journey_kind,
            sample.scheduled_at_unix_microseconds,
            sample.offered_at_unix_microseconds,
            sample.arrival_lag_microseconds,
            sample.admission_status,
            sample.admission_microseconds,
            sample
                .completion_microseconds
                .map(|value| value.to_string())
                .unwrap_or_default(),
            sample
                .authoritative_completion_microseconds
                .map(|value| value.to_string())
                .unwrap_or_default(),
            sample.run_id.as_deref().unwrap_or_default(),
            sample.idempotency_replay_checked,
            sample.idempotency_replay_passed,
            sample.evidence_checked,
            sample.evidence_passed,
            sample
                .evidence
                .as_ref()
                .map(|item| item.total_agent_runs)
                .unwrap_or(0),
            sample
                .evidence
                .as_ref()
                .map(|item| item.child_agent_runs)
                .unwrap_or(0),
            sample
                .evidence
                .as_ref()
                .map(|item| item.thread_events)
                .unwrap_or(0),
            sample
                .evidence
                .as_ref()
                .map(|item| item.workflow_instances)
                .unwrap_or(0),
            sample
                .evidence
                .as_ref()
                .map(|item| item.tool_calls)
                .unwrap_or(0),
            sample
                .evidence
                .as_ref()
                .map(|item| item.approvals)
                .unwrap_or(0),
            sample
                .evidence
                .as_ref()
                .map(|item| item.tool_attempts)
                .unwrap_or(0),
            sample.error_class.as_deref().unwrap_or_default(),
        ));
    }
    fs::write(output_dir.join("raw_samples.csv"), csv)?;
    Ok(())
}

fn failed_sample(
    ordinal: u64,
    journey_kind: String,
    scheduled_at_unix_microseconds: u64,
    offered_at_unix_microseconds: u64,
    admission_microseconds: u64,
    admission_status: u16,
    error_class: &str,
) -> Sample {
    Sample {
        ordinal,
        journey_kind,
        scheduled_at_unix_microseconds,
        offered_at_unix_microseconds,
        arrival_lag_microseconds: offered_at_unix_microseconds
            .saturating_sub(scheduled_at_unix_microseconds),
        admission_status,
        admission_microseconds,
        completion_microseconds: None,
        authoritative_completion_microseconds: None,
        run_id: None,
        idempotency_replay_checked: false,
        idempotency_replay_passed: false,
        evidence_checked: false,
        evidence_passed: false,
        evidence: None,
        error_class: Some(error_class.into()),
    }
}

fn caller_drop_sample(
    config: &LoadConfig,
    ordinal: u64,
    scheduled_at_unix_microseconds: u64,
) -> Sample {
    let offered_at_unix_microseconds = unix_microseconds();
    failed_sample(
        ordinal,
        config
            .journey_override
            .clone()
            .unwrap_or_else(|| journey_kind(config.journey_profile, ordinal).to_owned()),
        scheduled_at_unix_microseconds,
        offered_at_unix_microseconds,
        0,
        0,
        "caller-capacity",
    )
}

fn journey_kind(profile: JourneyProfile, ordinal: u64) -> &'static str {
    if matches!(profile, JourneyProfile::Basic) {
        return "basic-agent-run";
    }
    if matches!(profile, JourneyProfile::LunaDiscovery) {
        return "measured-agent-decision";
    }
    let slot = ((ordinal % 100) * 37 + 13) % 100;
    match slot {
        0..=89 => "basic-agent-run",
        90..=93 => "child-fanout",
        94..=95 => "awaited-workflow",
        96 => "detached-workflow",
        97 => "sandbox-artifact",
        98 => "approval-smtp",
        _ => "full-reference-journey",
    }
}

fn unix_microseconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

fn required(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        anyhow::bail!("{name} must not be empty");
    }
    Ok(value)
}

fn parse_positive_f64(name: &str) -> Result<f64> {
    let value = required(name)?
        .parse::<f64>()
        .with_context(|| format!("{name} must be positive"))?;
    if !value.is_finite() || value <= 0.0 {
        anyhow::bail!("{name} must be positive");
    }
    Ok(value)
}

fn parse_positive_u64(name: &str) -> Result<u64> {
    let value = required(name)?
        .parse::<u64>()
        .with_context(|| format!("{name} must be positive"))?;
    if value == 0 {
        anyhow::bail!("{name} must be positive");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{ArrivalPattern, JourneyProfile, arrival_offsets, journey_kind};

    #[test]
    fn deployed_patterns_have_explicit_open_loop_offsets() {
        let uniform = arrival_offsets(
            ArrivalPattern::Uniform,
            4.0,
            Duration::from_secs(2),
            None,
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(uniform.len(), 8);
        assert_eq!(uniform[0], Duration::ZERO);
        assert_eq!(uniform[7], Duration::from_millis(1750));

        let ramp = arrival_offsets(
            ArrivalPattern::LinearRamp,
            2.0,
            Duration::from_secs(2),
            Some(1.0),
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(ramp.len(), 3);
        assert!(ramp[2] > Duration::from_secs(1));

        let burst = arrival_offsets(
            ArrivalPattern::Burst,
            4.0,
            Duration::from_secs(2),
            None,
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(burst, vec![Duration::ZERO; 8]);

        let idle_to_burst = arrival_offsets(
            ArrivalPattern::IdleToBurst,
            4.0,
            Duration::from_secs(2),
            None,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(idle_to_burst, vec![Duration::from_secs(5); 8]);
    }

    #[test]
    fn basic_profile_contains_only_basic_agent_runs() {
        for ordinal in 0..100 {
            assert_eq!(
                journey_kind(JourneyProfile::Basic, ordinal),
                "basic-agent-run"
            );
        }
    }

    #[test]
    fn deterministic_message_mix_matches_the_recorded_issue_13_distribution() {
        let mut counts = std::collections::BTreeMap::new();
        for ordinal in 0..100 {
            *counts
                .entry(journey_kind(JourneyProfile::Issue13, ordinal))
                .or_insert(0) += 1;
        }
        assert_eq!(counts["basic-agent-run"], 90);
        assert_eq!(counts["child-fanout"], 4);
        assert_eq!(counts["awaited-workflow"], 2);
        assert_eq!(counts["detached-workflow"], 1);
        assert_eq!(counts["sandbox-artifact"], 1);
        assert_eq!(counts["approval-smtp"], 1);
        assert_eq!(counts["full-reference-journey"], 1);
    }

    #[test]
    fn luna_discovery_profile_replays_measured_agent_decisions() {
        for ordinal in 0..84 {
            assert_eq!(
                journey_kind(JourneyProfile::LunaDiscovery, ordinal),
                "measured-agent-decision"
            );
        }
    }
}
