use std::{
    io::{Read, Write},
    net::TcpStream,
    time::{SystemTime, UNIX_EPOCH},
};

use osfo_agent_run_lifecycle_prototype::temporal_lane::{
    TemporalWorkerFleet, TemporalWorkerFleetConfig, run_temporal_smoke,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pinned_temporal_rust_sdk_executes_typed_activity_update_and_timer() {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let address = std::env::var("TEMPORAL_ADDRESS")
        .expect("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint");
    let report = run_temporal_smoke(&address)
        .await
        .expect("run typed Temporal smoke");

    assert_eq!(report.sdk_version, "0.5.0");
    assert_eq!(report.workflow_type_version, "osfo-awaited-workflow-v1");
    assert!(report.history_event_count > 0);
    assert!(report.replay_passed);
    assert!(report.nondeterminism_negative_detected);
    assert!(report.wrong_order_approval_rejected);
    assert!(report.duplicate_approval_idempotent);
    assert!(report.post_settlement_approval_rejected);
    assert_eq!(
        report.steps,
        vec![
            "identity-validated",
            "editorial-approved",
            "timer-fired",
            "sandbox-created",
            "artifact-committed:4d958129226715d3c4b7d68a53a9be2040025d9b0f844ced223ab9a71ad01751",
            "release-approved",
            "publish-succeeded-attempt-2",
            "terminal-outcome-returned",
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fixed_temporal_worker_fleet_runs_multiple_workflows_and_exports_sdk_metrics() {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let address = std::env::var("TEMPORAL_ADDRESS")
        .expect("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint");
    let metrics_address = "127.0.0.1:19465";
    let invocation = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let fleet_id = format!("temporal-test-fleet-{invocation}");
    let fleet = TemporalWorkerFleet::start(
        &address,
        TemporalWorkerFleetConfig {
            fleet_id: fleet_id.clone(),
            metrics_address: metrics_address.into(),
            task_queue: "osfo-agent-run-lifecycle-v1".into(),
            workflow_slots: 16,
            activity_slots: 16,
        },
    )
    .await
    .expect("start one fixed Temporal worker fleet");

    let (first, second) = tokio::join!(
        fleet.run_smoke_named(format!("stable-fleet-workflow-a-{invocation}")),
        fleet.run_smoke_named(format!("stable-fleet-workflow-b-{invocation}")),
    );
    let first = first.expect("first workflow");
    let second = second.expect("second workflow");

    assert_eq!(first.worker_fleet_id, fleet_id);
    assert_eq!(second.worker_fleet_id, fleet_id);
    let metrics = tokio::task::spawn_blocking(move || fetch_metrics(metrics_address))
        .await
        .unwrap();
    assert!(metrics.contains("temporal_workflow_completed"));
    assert!(metrics.contains("temporal_worker_task_slots_available"));

    fleet
        .shutdown()
        .await
        .expect("stop fixed Temporal worker fleet");
}

fn fetch_metrics(address: &str) -> String {
    let mut stream = TcpStream::connect(address).expect("connect to Temporal metrics exporter");
    stream
        .write_all(b"GET /metrics HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}
