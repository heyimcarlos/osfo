use std::{
    sync::{Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use osfo_agent_run_lifecycle_prototype::{
    CommandOutcome, PostgresLifecycle, RunState,
    production_lane::execute_database_journey,
    workload::{JourneyKind, WorkloadAdmission},
};

fn shared_database_test_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn deterministic_basic_load_journey_commits_typed_records_and_optional_checkpoints() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");
    let admitted = lifecycle
        .admit_workload(WorkloadAdmission::new(
            "production-basic",
            "quiet-1",
            JourneyKind::BasicAgentRun,
            "per-step-checkpoint",
            1,
        ))
        .expect("admit");
    let claimed = lifecycle
        .claim_next_workload("production-worker", Duration::from_secs(5))
        .expect("claim")
        .expect("work");

    let samples = execute_database_journey(&mut lifecycle, &claimed).expect("execute");

    assert!(
        samples
            .iter()
            .any(|sample| sample.family == "model_call_intent_commit")
    );
    assert!(
        samples
            .iter()
            .any(|sample| sample.family == "checkpoint_commit")
    );
    assert_eq!(
        lifecycle.run(&admitted.run_id).expect("run").state,
        RunState::Succeeded
    );
    let records = lifecycle
        .semantic_sequence(&admitted.run_id)
        .expect("records");
    assert!(
        records
            .iter()
            .any(|record| record.starts_with("ModelCallIntent:v1"))
    );
    assert!(
        records
            .iter()
            .any(|record| record.starts_with("AssistantOutputFragment:v1"))
    );
    assert!(
        records
            .iter()
            .any(|record| record.starts_with("ModelCallOutcome:v1"))
    );
    assert!(
        records
            .iter()
            .any(|record| record.starts_with("RuntimeCheckpointRef:v1"))
    );
}

#[test]
fn non_streaming_basic_result_and_terminal_state_commit_atomically_and_replay() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");
    let admitted = lifecycle
        .admit_workload(WorkloadAdmission::new(
            "production-basic-atomic-result",
            "quiet-1",
            JourneyKind::BasicAgentRun,
            "cold-logical-reconstruction",
            1,
        ))
        .expect("admit");
    let claimed = lifecycle
        .claim_next_workload("production-worker", Duration::from_secs(5))
        .expect("claim")
        .expect("work");

    let samples = execute_database_journey(&mut lifecycle, &claimed).expect("execute");
    assert!(
        samples
            .iter()
            .any(|sample| sample.family == "model_response_terminal_commit")
    );
    assert_eq!(
        lifecycle
            .complete_basic_model_response(
                &claimed.run_id,
                claimed.claim_epoch,
                "model-fragment-1",
                "AssistantOutputFragment:v1:deterministic-output",
                "model-outcome",
                "ModelCallOutcome:v1:succeeded:tokens=17",
            )
            .expect("replay terminal response"),
        CommandOutcome::IdempotentReplay
    );
    assert_eq!(
        lifecycle
            .semantic_sequence(&admitted.run_id)
            .expect("semantic history"),
        vec![
            "UserMessage:v1",
            "SemanticConfig:v1:quiet-1:basic-agent-run:cold-logical-reconstruction",
            "AgentRunClaimed:1",
            "ModelCallIntent:v1:deterministic-adapter",
            "AssistantOutputFragment:v1:deterministic-output",
            "ModelCallOutcome:v1:succeeded:tokens=17",
            "AgentRunTerminal:succeeded",
        ]
    );
    assert!(
        lifecycle
            .complete_basic_model_response(
                &claimed.run_id,
                claimed.claim_epoch,
                "model-fragment-1",
                "AssistantOutputFragment:v1:different",
                "model-outcome",
                "ModelCallOutcome:v1:succeeded:tokens=17",
            )
            .is_err()
    );
}
