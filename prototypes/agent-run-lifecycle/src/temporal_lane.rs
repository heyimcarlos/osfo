use std::{
    collections::BTreeSet,
    net::SocketAddr,
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

use anyhow::Result;
use futures_util::stream;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use temporalio_client::{
    Client, ClientOptions, Connection, ConnectionOptions, TlsOptions, WorkflowCancelOptions,
    WorkflowExecuteUpdateOptions, WorkflowFetchHistoryOptions, WorkflowGetResultOptions,
    WorkflowHistory, WorkflowStartOptions,
};
use temporalio_common::{
    data_converters::DataConverter,
    protos::temporal::api::{
        common::v1::RetryPolicy,
        enums::v1::{WorkflowIdConflictPolicy, WorkflowIdReusePolicy},
        history::v1::history_event::Attributes,
    },
    telemetry::{
        PrometheusExporterOptions, TelemetryOptions, metrics::CoreMeter,
        start_prometheus_metric_exporter,
    },
    worker::WorkerTaskTypes,
};
use temporalio_macros::{activities, workflow, workflow_methods};
use temporalio_sdk::{
    ActivityOptions, SyncWorkflowContext, Worker, WorkerOptions, WorkflowContext,
    WorkflowContextView, WorkflowResult, WorkflowTermination,
    activities::{ActivityContext, ActivityError},
    interceptors::FailOnNondeterminismInterceptor,
    workflows::select,
};
use temporalio_sdk_core::{
    CoreRuntime, RuntimeOptions, TunerHolder, Url, WorkerConfig, WorkerVersioningStrategy,
    init_replay_worker,
    replay::{HistoryForReplay, ReplayWorkerInput},
};

use crate::{
    ArtifactStore, DockerSandboxProvider, GcsArtifactStore, MinioArtifactStore, SandboxProvider,
    SandboxSpec,
};

const TASK_QUEUE: &str = "osfo-agent-run-lifecycle-v1";

fn unique_workflow_start_options(task_queue: &str, workflow_id: String) -> WorkflowStartOptions {
    WorkflowStartOptions::new(task_queue, workflow_id)
        .id_reuse_policy(WorkflowIdReusePolicy::RejectDuplicate)
        .id_conflict_policy(WorkflowIdConflictPolicy::UseExisting)
        .build()
}

#[derive(Clone)]
struct TemporalConnectionProfile {
    target: Url,
    namespace: String,
    api_key: Option<String>,
}

impl std::fmt::Debug for TemporalConnectionProfile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TemporalConnectionProfile")
            .field("target", &self.target)
            .field("namespace", &self.namespace)
            .field("api_key_configured", &self.api_key.is_some())
            .finish()
    }
}

impl TemporalConnectionProfile {
    fn from_environment(address: &str) -> Result<Self> {
        let _ = dotenvy::dotenv();
        let namespace = std::env::var("TEMPORAL_NAMESPACE").unwrap_or_else(|_| "default".into());
        let api_key = std::env::var("TEMPORAL_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty());
        Self::new(address, &namespace, api_key)
    }

    fn new(address: &str, namespace: &str, api_key: Option<String>) -> Result<Self> {
        if address.trim().is_empty() || namespace.trim().is_empty() {
            anyhow::bail!("Temporal endpoint and namespace are required");
        }
        let api_key = api_key.filter(|value| !value.trim().is_empty());
        if api_key.is_none() {
            anyhow::bail!("Temporal Cloud API key is required");
        }
        if address.starts_with("http://") {
            anyhow::bail!("Temporal Cloud requires a TLS endpoint");
        }
        let target = if address.starts_with("http://") || address.starts_with("https://") {
            address.to_owned()
        } else {
            format!("https://{address}")
        };
        Ok(Self {
            target: Url::parse(&target)?,
            namespace: namespace.to_owned(),
            api_key,
        })
    }

    fn options(&self, identity: &str) -> Result<(ConnectionOptions, ClientOptions)> {
        let connection = ConnectionOptions::new(self.target.clone())
            .identity(identity.to_owned())
            .maybe_api_key(self.api_key.clone())
            .maybe_tls_options(self.api_key.as_ref().map(|_| TlsOptions::default()))
            .build();
        let client = ClientOptions::new(self.namespace.clone()).build();
        Ok((connection, client))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemporalSmokeReport {
    pub workflow_instance_id: String,
    pub worker_fleet_id: String,
    pub sdk_version: String,
    pub workflow_type_version: String,
    pub steps: Vec<String>,
    pub history_event_count: usize,
    pub replay_passed: bool,
    pub nondeterminism_negative_detected: bool,
    pub wrong_order_approval_rejected: bool,
    pub duplicate_approval_idempotent: bool,
    pub post_settlement_approval_rejected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SmokeInput {
    workflow_instance_id: String,
    input_version: String,
}

#[workflow]
#[derive(Default)]
struct AwaitedWorkflowV1 {
    editorial_approval_id: Option<String>,
    release_approval_id: Option<String>,
}

#[workflow_methods]
impl AwaitedWorkflowV1 {
    #[run]
    async fn run(
        ctx: &mut WorkflowContext<Self>,
        input: SmokeInput,
    ) -> WorkflowResult<Vec<String>> {
        let validated = select! {
            result = ctx.start_activity(
                SmokeActivities::validate_identity,
                input.clone(),
                ActivityOptions::start_to_close_timeout(Duration::from_secs(5)),
            ) => result?,
            _reason = ctx.cancelled() => return Err(WorkflowTermination::Cancelled),
        };
        select! {
            _ = ctx.wait_condition(|state| state.editorial_approval_id.is_some()) => {},
            _reason = ctx.cancelled() => return Err(WorkflowTermination::Cancelled),
        };
        select! {
            _ = ctx.timer(Duration::from_millis(20)) => {},
            _reason = ctx.cancelled() => return Err(WorkflowTermination::Cancelled),
        };
        let sandbox_steps = select! {
            result = ctx.start_activity(
                SmokeActivities::sandbox_and_artifact,
                input.clone(),
                ActivityOptions::start_to_close_timeout(Duration::from_secs(20)),
            ) => result?,
            _reason = ctx.cancelled() => return Err(WorkflowTermination::Cancelled),
        };
        select! {
            _ = ctx.wait_condition(|state| state.release_approval_id.is_some()) => {},
            _reason = ctx.cancelled() => return Err(WorkflowTermination::Cancelled),
        };
        let publish = select! {
            result = ctx.start_activity(
                SmokeActivities::publish,
                input,
                ActivityOptions::with_start_to_close_timeout(Duration::from_secs(5))
                    .retry_policy(RetryPolicy {
                        maximum_attempts: 3,
                        ..Default::default()
                    })
                    .build(),
            ) => result?,
            _reason = ctx.cancelled() => return Err(WorkflowTermination::Cancelled),
        };
        let mut steps = vec![validated, "editorial-approved".into(), "timer-fired".into()];
        steps.extend(sandbox_steps);
        steps.push("release-approved".into());
        steps.push(publish);
        steps.push("terminal-outcome-returned".into());
        Ok(steps)
    }

    #[update_validator(approve_editorial)]
    fn validate_editorial(
        &self,
        _ctx: &WorkflowContextView,
        _approval_id: &String,
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.editorial_approval_id.is_some() {
            Err("editorial approval gate is already settled".into())
        } else {
            Ok(())
        }
    }

    #[update]
    fn approve_editorial(
        &mut self,
        _ctx: &mut SyncWorkflowContext<Self>,
        approval_id: String,
    ) -> String {
        match &self.editorial_approval_id {
            Some(existing) => existing.clone(),
            None => {
                self.editorial_approval_id = Some(approval_id.clone());
                approval_id
            }
        }
    }

    #[update_validator(approve_release)]
    fn validate_release(
        &self,
        _ctx: &WorkflowContextView,
        _approval_id: &String,
    ) -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
        if self.editorial_approval_id.is_none() {
            Err("release approval arrived before editorial settlement".into())
        } else if self.release_approval_id.is_some() {
            Err("release approval gate is already settled".into())
        } else {
            Ok(())
        }
    }

    #[update]
    fn approve_release(
        &mut self,
        _ctx: &mut SyncWorkflowContext<Self>,
        approval_id: String,
    ) -> String {
        match &self.release_approval_id {
            Some(existing) => existing.clone(),
            None => {
                self.release_approval_id = Some(approval_id.clone());
                approval_id
            }
        }
    }
}

#[workflow]
#[derive(Default)]
struct AwaitedWorkflowV1Nondeterministic;

#[workflow_methods]
impl AwaitedWorkflowV1Nondeterministic {
    #[run(name = "AwaitedWorkflowV1")]
    async fn run(
        state: &mut WorkflowContext<Self>,
        _input: SmokeInput,
    ) -> WorkflowResult<Vec<String>> {
        state.timer(Duration::from_secs(1)).await;
        Ok(vec!["history-command-order-changed".into()])
    }
}

struct SmokeActivities;

#[activities]
impl SmokeActivities {
    #[activity]
    async fn validate_identity(
        _ctx: ActivityContext,
        input: SmokeInput,
    ) -> std::result::Result<String, ActivityError> {
        if input.workflow_instance_id.is_empty() || input.input_version != "v1" {
            return Err(temporalio_sdk::ApplicationFailure::non_retryable(
                "invalid WorkflowInstance identity or input version",
            )
            .into());
        }
        Ok("identity-validated".into())
    }

    #[activity]
    async fn sandbox_and_artifact(
        _ctx: ActivityContext,
        input: SmokeInput,
    ) -> std::result::Result<Vec<String>, ActivityError> {
        tokio::task::spawn_blocking(move || sandbox_and_artifact_inner(&input))
            .await
            .map_err(|error| temporalio_sdk::ApplicationFailure::non_retryable(error.to_string()))?
            .map_err(|error| {
                temporalio_sdk::ApplicationFailure::non_retryable(error.to_string()).into()
            })
    }

    #[activity]
    async fn publish(
        ctx: ActivityContext,
        _input: SmokeInput,
    ) -> std::result::Result<String, ActivityError> {
        if ctx.info().attempt == 1 {
            return Err(temporalio_sdk::ApplicationFailure::new(
                "injected retryable publish failure",
            )
            .into());
        }
        Ok(format!("publish-succeeded-attempt-{}", ctx.info().attempt))
    }
}

fn sandbox_and_artifact_inner(input: &SmokeInput) -> Result<Vec<String>> {
    if std::env::var("OSFO_SANDBOX_PROVIDER").as_deref() == Ok("disabled") {
        return Ok(vec!["sandbox-disabled-for-temporal-conformance".into()]);
    }
    let image = std::env::var("OSFO_SANDBOX_IMAGE").unwrap_or_else(|_| {
        "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"
            .into()
    });
    let sandbox_id = format!("temporal-{}", input.workflow_instance_id);
    let mut provider = DockerSandboxProvider::new();
    let sandbox = provider.create(SandboxSpec {
        sandbox_id,
        image,
        cpu_limit: 0.5,
        memory_bytes: 64 * 1024 * 1024,
        process_limit: 32,
    })?;
    let result = (|| {
        let execution = provider.execute(
            &sandbox,
            "printf 'briefing\\n' > /workspace/briefing.txt",
            Duration::from_secs(3),
        )?;
        if !execution.success {
            anyhow::bail!("sandbox artifact command failed: {}", execution.stderr);
        }
        let exported = provider.export(&sandbox, "briefing.txt")?;
        let key = format!("temporal/{}/briefing.txt", input.workflow_instance_id);
        let artifact = if let Ok(bucket) = std::env::var("OSFO_ARTIFACT_BUCKET") {
            GcsArtifactStore::new(bucket).put_immutable(&key, &exported.bytes)?
        } else {
            let client_container = std::env::var("MINIO_CLIENT_CONTAINER")
                .unwrap_or_else(|_| "osfo-lifecycle-artifact-client".into());
            let bucket =
                std::env::var("MINIO_BUCKET").unwrap_or_else(|_| "osfo-lifecycle-local".into());
            MinioArtifactStore::new(client_container, bucket)
                .put_immutable(&key, &exported.bytes)?
        };
        Ok(vec![
            "sandbox-created".into(),
            format!("artifact-committed:{}", artifact.sha256),
        ])
    })();
    let delete_result = provider.delete(&sandbox);
    match (result, delete_result) {
        (Ok(steps), Ok(())) => Ok(steps),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub async fn run_temporal_smoke(address: &str) -> Result<TemporalSmokeReport> {
    let workflow_id = format!(
        "osfo-smoke-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    );
    run_temporal_smoke_named(address, workflow_id).await
}

pub async fn run_temporal_smoke_named(
    address: &str,
    workflow_id: String,
) -> Result<TemporalSmokeReport> {
    let _ = dotenvy::dotenv();
    let base_task_queue =
        std::env::var("TEMPORAL_TASK_QUEUE").unwrap_or_else(|_| TASK_QUEUE.into());
    let task_queue = isolated_smoke_task_queue(&base_task_queue, &workflow_id);
    let fleet = TemporalWorkerFleet::start(
        address,
        TemporalWorkerFleetConfig {
            fleet_id: "single-smoke-worker".into(),
            metrics_address: "127.0.0.1:0".into(),
            task_queue,
            workflow_slots: 8,
            activity_slots: 8,
        },
    )
    .await?;
    let report = fleet.run_smoke_named(workflow_id).await;
    let shutdown = fleet.shutdown().await;
    match (report, shutdown) {
        (Ok(report), Ok(())) => Ok(report),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn isolated_smoke_task_queue(base_task_queue: &str, workflow_id: &str) -> String {
    let digest = Sha256::digest(workflow_id.as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let base = base_task_queue.chars().take(220).collect::<String>();
    format!("{base}-smoke-{suffix}")
}

#[derive(Debug, Clone)]
pub struct TemporalWorkerFleetConfig {
    pub fleet_id: String,
    pub metrics_address: String,
    pub task_queue: String,
    pub workflow_slots: usize,
    pub activity_slots: usize,
}

pub struct TemporalWorkerFleet {
    client: Client,
    fleet_id: String,
    task_queue: String,
    metrics_address: SocketAddr,
    metrics_abort: tokio::task::AbortHandle,
    shutdown: Box<dyn Fn() + Send + Sync>,
    worker_thread: thread::JoinHandle<Result<()>>,
}

#[derive(Clone)]
pub struct TemporalWorkflowClient {
    client: Client,
    fleet_id: String,
    task_queue: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemporalLoadReport {
    pub workflow_instance_id: String,
    pub worker_fleet_id: String,
    pub client_identity: String,
    pub worker_identities: Vec<String>,
    pub steps: Vec<String>,
    pub history_event_count: usize,
}

impl TemporalWorkerFleet {
    pub async fn start(address: &str, config: TemporalWorkerFleetConfig) -> Result<Self> {
        if config.fleet_id.trim().is_empty()
            || config.task_queue.trim().is_empty()
            || config.workflow_slots == 0
            || config.activity_slots == 0
        {
            anyhow::bail!("Temporal worker fleet ID and fixed slot counts are required");
        }
        let metrics_socket = config.metrics_address.parse::<SocketAddr>()?;
        let prometheus = start_prometheus_metric_exporter(
            PrometheusExporterOptions::builder()
                .socket_addr(metrics_socket)
                .counters_total_suffix(true)
                .unit_suffix(true)
                .build(),
        )?;
        let connection_profile = TemporalConnectionProfile::from_environment(address)?;
        let worker_connection_profile = connection_profile.clone();
        let worker_identity = config.fleet_id.clone();
        let task_queue = config.task_queue.clone();
        let workflow_slots = config.workflow_slots;
        let activity_slots = config.activity_slots;
        let meter = prometheus.meter.clone() as Arc<dyn CoreMeter>;
        type ShutdownHandle = Box<dyn Fn() + Send + Sync>;
        let (ready_sender, ready_receiver) = mpsc::sync_channel::<Result<ShutdownHandle>>(1);
        let worker_thread = thread::spawn(move || {
            let tokio_runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            tokio_runtime.block_on(async move {
                let telemetry = TelemetryOptions::builder().metrics(meter).build();
                let runtime = CoreRuntime::new_assume_tokio(
                    RuntimeOptions::builder()
                        .telemetry_options(telemetry)
                        .build()
                        .map_err(anyhow::Error::msg)?,
                )?;
                let (connection_options, client_options) =
                    worker_connection_profile.options(&worker_identity)?;
                let connection = match Connection::connect(connection_options).await {
                    Ok(connection) => connection,
                    Err(error) => {
                        let _ = ready_sender.send(Err(anyhow::anyhow!(error.to_string())));
                        return Err(error.into());
                    }
                };
                let client = Client::new(connection, client_options)?;
                let worker_options = WorkerOptions::new(task_queue)
                    .register_workflow::<AwaitedWorkflowV1>()?
                    .register_activities(SmokeActivities)
                    .client_identity_override(worker_identity)
                    .tuner(Arc::new(TunerHolder::fixed_size(
                        workflow_slots,
                        activity_slots,
                        activity_slots,
                        1,
                    )))
                    .build();
                let mut worker = match Worker::new(&runtime, client, worker_options) {
                    Ok(worker) => worker,
                    Err(error) => {
                        let message = error.to_string();
                        let _ = ready_sender.send(Err(anyhow::anyhow!(message.clone())));
                        return Err(anyhow::anyhow!(message));
                    }
                };
                let shutdown: ShutdownHandle = Box::new(worker.shutdown_handle());
                ready_sender
                    .send(Ok(shutdown))
                    .map_err(|_| anyhow::anyhow!("Temporal fleet starter stopped waiting"))?;
                worker.run().await
            })
        });
        let shutdown = tokio::task::spawn_blocking(move || {
            ready_receiver
                .recv_timeout(Duration::from_secs(30))
                .map_err(|_| anyhow::anyhow!("Temporal worker fleet did not become ready"))?
        })
        .await??;
        let (connection_options, client_options) = connection_profile.options(&config.fleet_id)?;
        let connection = Connection::connect(connection_options).await?;
        let client = Client::new(connection, client_options)?;
        Ok(Self {
            client,
            fleet_id: config.fleet_id,
            task_queue: config.task_queue,
            metrics_address: prometheus.bound_addr,
            metrics_abort: prometheus.abort_handle,
            shutdown,
            worker_thread,
        })
    }

    pub fn metrics_address(&self) -> SocketAddr {
        self.metrics_address
    }

    pub async fn run_smoke_named(&self, workflow_id: String) -> Result<TemporalSmokeReport> {
        execute_smoke_workflow(&self.client, workflow_id, &self.fleet_id, &self.task_queue).await
    }

    pub fn workflow_client(&self) -> TemporalWorkflowClient {
        TemporalWorkflowClient {
            client: self.client.clone(),
            fleet_id: self.fleet_id.clone(),
            task_queue: self.task_queue.clone(),
        }
    }

    pub async fn shutdown(self) -> Result<()> {
        (self.shutdown)();
        tokio::task::spawn_blocking(move || {
            self.worker_thread
                .join()
                .map_err(|_| anyhow::anyhow!("Temporal worker fleet thread panicked"))?
        })
        .await??;
        self.metrics_abort.abort();
        Ok(())
    }
}

impl TemporalWorkflowClient {
    pub async fn connect(address: &str, fleet_id: &str, task_queue: &str) -> Result<Self> {
        if fleet_id.trim().is_empty() || task_queue.trim().is_empty() {
            anyhow::bail!("Temporal workflow client identity and task queue are required");
        }
        let profile = TemporalConnectionProfile::from_environment(address)?;
        let (connection_options, client_options) = profile.options(fleet_id)?;
        let connection = Connection::connect(connection_options).await?;
        let client = Client::new(connection, client_options)?;
        Ok(Self {
            client,
            fleet_id: fleet_id.to_owned(),
            task_queue: task_queue.to_owned(),
        })
    }

    pub async fn run_load_named(&self, workflow_id: String) -> Result<TemporalLoadReport> {
        execute_load_workflow(&self.client, workflow_id, &self.fleet_id, &self.task_queue).await
    }

    pub async fn reconcile_load_named(&self, workflow_id: String) -> Result<TemporalLoadReport> {
        let handle = self
            .client
            .get_workflow_handle::<AwaitedWorkflowV1>(workflow_id.clone());
        let steps = handle
            .get_result(WorkflowGetResultOptions::default())
            .await?;
        let history = handle
            .fetch_history(WorkflowFetchHistoryOptions::default())
            .await?;
        let history_event_count = history.events().len();
        Ok(TemporalLoadReport {
            workflow_instance_id: workflow_id,
            worker_fleet_id: self.fleet_id.clone(),
            client_identity: self.fleet_id.clone(),
            worker_identities: worker_identities(&history),
            steps,
            history_event_count,
        })
    }

    pub async fn run_cancellation_matrix(&self, prefix: &str) -> Result<bool> {
        let before_id = format!("{prefix}-before-approval");
        let before = self
            .client
            .start_workflow(
                AwaitedWorkflowV1::run,
                SmokeInput {
                    workflow_instance_id: before_id.clone(),
                    input_version: "v1".into(),
                },
                unique_workflow_start_options(&self.task_queue, before_id),
            )
            .await?;
        before
            .cancel(
                WorkflowCancelOptions::builder()
                    .reason("issue-13-before-approval")
                    .request_id(format!("{prefix}-cancel-before"))
                    .build(),
            )
            .await?;
        let before_canceled = tokio::time::timeout(
            Duration::from_secs(30),
            before.get_result(WorkflowGetResultOptions::default()),
        )
        .await?
        .is_err();

        let during_id = format!("{prefix}-during-timer-or-activity");
        let during = self
            .client
            .start_workflow(
                AwaitedWorkflowV1::run,
                SmokeInput {
                    workflow_instance_id: during_id.clone(),
                    input_version: "v1".into(),
                },
                unique_workflow_start_options(&self.task_queue, during_id),
            )
            .await?;
        during
            .execute_update(
                AwaitedWorkflowV1::approve_editorial,
                format!("{prefix}-editorial"),
                WorkflowExecuteUpdateOptions::builder()
                    .update_id(format!("{prefix}-editorial"))
                    .build(),
            )
            .await?;
        during
            .cancel(
                WorkflowCancelOptions::builder()
                    .reason("issue-13-during-timer-or-activity")
                    .request_id(format!("{prefix}-cancel-during"))
                    .build(),
            )
            .await?;
        let during_canceled = tokio::time::timeout(
            Duration::from_secs(30),
            during.get_result(WorkflowGetResultOptions::default()),
        )
        .await?
        .is_err();

        let after_id = format!("{prefix}-after-terminal");
        let completed = self.run_load_named(after_id.clone()).await?;
        let after = self
            .client
            .get_workflow_handle::<AwaitedWorkflowV1>(after_id);
        let _ = after
            .cancel(
                WorkflowCancelOptions::builder()
                    .reason("issue-13-after-terminal")
                    .request_id(format!("{prefix}-cancel-after"))
                    .build(),
            )
            .await;
        let terminal_unchanged = after
            .get_result(WorkflowGetResultOptions::default())
            .await?
            == completed.steps;
        Ok(before_canceled && during_canceled && terminal_unchanged)
    }
}

async fn execute_load_workflow(
    workflow_client: &Client,
    workflow_id: String,
    worker_fleet_id: &str,
    task_queue: &str,
) -> Result<TemporalLoadReport> {
    let handle = workflow_client
        .start_workflow(
            AwaitedWorkflowV1::run,
            SmokeInput {
                workflow_instance_id: workflow_id.clone(),
                input_version: "v1".into(),
            },
            unique_workflow_start_options(task_queue, workflow_id.clone()),
        )
        .await?;
    handle
        .execute_update(
            AwaitedWorkflowV1::approve_editorial,
            format!("approval-editorial-{workflow_id}"),
            WorkflowExecuteUpdateOptions::builder()
                .update_id(format!("approval-editorial-{workflow_id}"))
                .build(),
        )
        .await?;
    handle
        .execute_update(
            AwaitedWorkflowV1::approve_release,
            format!("approval-release-{workflow_id}"),
            WorkflowExecuteUpdateOptions::builder()
                .update_id(format!("approval-release-{workflow_id}"))
                .build(),
        )
        .await?;
    let steps = handle
        .get_result(WorkflowGetResultOptions::default())
        .await?;
    let history = handle
        .fetch_history(WorkflowFetchHistoryOptions::default())
        .await?;
    let history_event_count = history.events().len();
    Ok(TemporalLoadReport {
        workflow_instance_id: workflow_id,
        worker_fleet_id: worker_fleet_id.into(),
        client_identity: worker_fleet_id.into(),
        worker_identities: worker_identities(&history),
        steps,
        history_event_count,
    })
}

fn worker_identities(history: &WorkflowHistory) -> Vec<String> {
    history
        .events()
        .iter()
        .filter_map(|event| match event.attributes.as_ref() {
            Some(Attributes::WorkflowTaskCompletedEventAttributes(attributes)) => {
                Some(attributes.identity.as_str())
            }
            Some(Attributes::ActivityTaskCompletedEventAttributes(attributes)) => {
                Some(attributes.identity.as_str())
            }
            _ => None,
        })
        .filter(|identity| !identity.is_empty())
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

async fn execute_smoke_workflow(
    workflow_client: &Client,
    workflow_id: String,
    worker_fleet_id: &str,
    task_queue: &str,
) -> Result<TemporalSmokeReport> {
    let report_workflow_id = workflow_id.clone();
    let handle = workflow_client
        .start_workflow(
            AwaitedWorkflowV1::run,
            SmokeInput {
                workflow_instance_id: workflow_id.clone(),
                input_version: "v1".into(),
            },
            unique_workflow_start_options(task_queue, workflow_id),
        )
        .await?;
    let wrong_order_approval_rejected = handle
        .execute_update(
            AwaitedWorkflowV1::approve_release,
            "approval-release-too-early".to_owned(),
            WorkflowExecuteUpdateOptions::builder()
                .update_id("approval-release-too-early".to_owned())
                .build(),
        )
        .await
        .is_err();
    if !wrong_order_approval_rejected {
        anyhow::bail!("Temporal accepted a release approval before editorial settlement");
    }
    let accepted = handle
        .execute_update(
            AwaitedWorkflowV1::approve_editorial,
            "approval-editorial-001".to_owned(),
            WorkflowExecuteUpdateOptions::builder()
                .update_id("approval-editorial-001".to_owned())
                .build(),
        )
        .await?;
    if accepted != "approval-editorial-001" {
        anyhow::bail!("Temporal approval update returned the wrong stable identity");
    }
    let duplicate_approval_idempotent = handle
        .execute_update(
            AwaitedWorkflowV1::approve_editorial,
            "approval-editorial-001".to_owned(),
            WorkflowExecuteUpdateOptions::builder()
                .update_id("approval-editorial-001".to_owned())
                .build(),
        )
        .await?
        == "approval-editorial-001";
    if !duplicate_approval_idempotent {
        anyhow::bail!("Temporal approval update was not idempotent by update ID");
    }
    let release = handle
        .execute_update(
            AwaitedWorkflowV1::approve_release,
            "approval-release-001".to_owned(),
            WorkflowExecuteUpdateOptions::builder()
                .update_id("approval-release-001".to_owned())
                .build(),
        )
        .await?;
    if release != "approval-release-001" {
        anyhow::bail!("Temporal release update returned the wrong stable identity");
    }
    let steps = handle
        .get_result(WorkflowGetResultOptions::default())
        .await?;
    let post_settlement_approval_rejected = handle
        .execute_update(
            AwaitedWorkflowV1::approve_editorial,
            "approval-editorial-after-close".to_owned(),
            WorkflowExecuteUpdateOptions::builder()
                .update_id("approval-editorial-after-close".to_owned())
                .build(),
        )
        .await
        .is_err();
    if !post_settlement_approval_rejected {
        anyhow::bail!("Temporal accepted an approval after workflow settlement");
    }
    let history = handle
        .fetch_history(WorkflowFetchHistoryOptions::default())
        .await?;
    let history_event_count = history.events().len();
    let mut replay = replay_worker(history.clone())?;
    replay.register_workflow::<AwaitedWorkflowV1>()?;
    replay.run().await?;
    let mut negative_replay = replay_worker(history)?;
    negative_replay.register_workflow::<AwaitedWorkflowV1Nondeterministic>()?;
    let nondeterminism_negative_detected = negative_replay.run().await.is_err();
    if !nondeterminism_negative_detected {
        anyhow::bail!("intentional Temporal nondeterminism was not detected");
    }
    Ok(TemporalSmokeReport {
        workflow_instance_id: report_workflow_id,
        worker_fleet_id: worker_fleet_id.into(),
        sdk_version: "0.5.0".into(),
        workflow_type_version: "osfo-awaited-workflow-v1".into(),
        steps,
        history_event_count,
        replay_passed: true,
        nondeterminism_negative_detected,
        wrong_order_approval_rejected,
        duplicate_approval_idempotent,
        post_settlement_approval_rejected,
    })
}

fn replay_worker(history: WorkflowHistory) -> Result<Worker> {
    let config = WorkerConfig::builder()
        .namespace("default")
        .task_queue("osfo-agent-run-lifecycle-replay")
        .max_outstanding_activities(8_usize)
        .max_outstanding_local_activities(8_usize)
        .max_outstanding_workflow_tasks(8_usize)
        .versioning_strategy(WorkerVersioningStrategy::None {
            build_id: "osfo-agent-run-lifecycle-v1".into(),
        })
        .task_types(WorkerTaskTypes::workflow_only())
        .skip_client_worker_set_check(true)
        .build()
        .map_err(anyhow::Error::msg)?;
    let replay = init_replay_worker(ReplayWorkerInput::new(
        config,
        stream::iter([HistoryForReplay::new(history, "osfo-replay")]),
    ))?;
    let mut worker = Worker::new_from_core(Arc::new(replay), DataConverter::default());
    worker.set_worker_interceptor(FailOnNondeterminismInterceptor {});
    Ok(worker)
}

#[cfg(test)]
mod cloud_configuration_tests {
    use super::{TemporalConnectionProfile, unique_workflow_start_options};
    use temporalio_common::protos::temporal::api::enums::v1::{
        WorkflowIdConflictPolicy, WorkflowIdReusePolicy,
    };

    #[test]
    fn api_key_profile_uses_tls_and_the_configured_cloud_namespace() {
        let profile = TemporalConnectionProfile::new(
            "osfo.qvao9.tmprl.cloud:7233",
            "osfo.qvao9",
            Some("not-a-real-api-key".into()),
        )
        .expect("valid Temporal Cloud profile");

        let (connection, client) = profile
            .options("cloud-config-test")
            .expect("build Temporal options");
        assert_eq!(
            connection.target.as_str(),
            "https://osfo.qvao9.tmprl.cloud:7233/"
        );
        assert!(connection.api_key.is_some());
        assert!(connection.tls_options.is_some());
        assert_eq!(client.namespace, "osfo.qvao9");
        assert!(!format!("{profile:?}").contains("not-a-real-api-key"));
    }

    #[test]
    fn cloud_only_profile_rejects_a_missing_api_key() {
        let result =
            TemporalConnectionProfile::new("osfo.qvao9.tmprl.cloud:7233", "osfo.qvao9", None);

        assert!(result.is_err());
    }

    #[test]
    fn api_key_profile_rejects_an_explicit_plaintext_endpoint() {
        let result = TemporalConnectionProfile::new(
            "http://osfo.qvao9.tmprl.cloud:7233",
            "osfo.qvao9",
            Some("not-a-real-api-key".into()),
        );

        assert!(result.is_err());
    }

    #[test]
    fn workflow_start_reuses_running_execution_and_rejects_closed_duplicates() {
        let options = unique_workflow_start_options("queue", "stable-workflow-id".into());

        assert_eq!(
            options.id_reuse_policy,
            WorkflowIdReusePolicy::RejectDuplicate
        );
        assert_eq!(
            options.id_conflict_policy,
            WorkflowIdConflictPolicy::UseExisting
        );
    }
}
