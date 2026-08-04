use std::sync::{Arc, Barrier};
use std::thread;

use osfo_agent_run_lifecycle_prototype::{
    Command, CommandOutcome, PostgresLifecycle, RunId, RunState,
};

#[test]
fn awaited_workflow_delivery_racing_cancellation_never_reactivates_terminal_work() {
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset schema");
    lifecycle
        .execute(Command::AdmitUserMessage {
            idempotency_key: "wake-cancel-race".into(),
            request_hash: "sha256:wake-cancel-race".into(),
        })
        .expect("admit");
    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker".into(),
        })
        .expect("claim");
    lifecycle
        .execute(Command::StartAwaitedWorkflow {
            parent_run_id: RunId::from("run-parent"),
            parent_claim_epoch: 1,
            tool_call_id: "wake-cancel-tool".into(),
            workflow_instance_id: "wake-cancel-workflow".into(),
        })
        .expect("wait");
    drop(lifecycle);

    let barrier = Arc::new(Barrier::new(2));
    let cancellation_url = database_url.clone();
    let cancellation_barrier = barrier.clone();
    let cancellation = thread::spawn(move || {
        let mut lifecycle = PostgresLifecycle::connect(&cancellation_url).unwrap();
        cancellation_barrier.wait();
        lifecycle
            .cancel_run(&RunId::from("run-parent"), "user-canceled")
            .unwrap()
    });
    let delivery = thread::spawn(move || {
        let mut lifecycle = PostgresLifecycle::connect(&database_url).unwrap();
        barrier.wait();
        lifecycle
            .execute(Command::DeliverWorkflowOutcome {
                workflow_instance_id: "wake-cancel-workflow".into(),
                delivery_id: "wake-cancel-delivery".into(),
                outcome: "published".into(),
            })
            .unwrap()
    });
    assert!(matches!(
        cancellation.join().unwrap(),
        CommandOutcome::Applied | CommandOutcome::IdempotentReplay
    ));
    assert!(matches!(
        delivery.join().unwrap(),
        CommandOutcome::Applied | CommandOutcome::IdempotentReplay
    ));

    let mut lifecycle = PostgresLifecycle::connect(
        &std::env::var("OSFO_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into()
        }),
    )
    .unwrap();
    let run = lifecycle.run(&RunId::from("run-parent")).unwrap();
    assert_eq!(run.state, RunState::Canceled);
    assert!(run.wake_count <= 1);
    assert!(
        lifecycle
            .execute(Command::Claim {
                run_id: RunId::from("run-parent"),
                worker_id: "late-worker".into(),
            })
            .is_err()
    );
    let records = lifecycle
        .semantic_sequence(&RunId::from("run-parent"))
        .unwrap();
    let canceled_at = records
        .iter()
        .position(|record| record.starts_with("AgentRunCanceled:"));
    let outcome_at = records
        .iter()
        .position(|record| record.starts_with("WorkflowOutcome:"));
    if let (Some(canceled_at), Some(outcome_at)) = (canceled_at, outcome_at) {
        assert!(
            outcome_at < canceled_at,
            "terminal cancellation must be the last semantic record"
        );
    }
}
