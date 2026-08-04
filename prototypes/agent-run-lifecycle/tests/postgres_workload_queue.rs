use std::{
    collections::HashSet,
    sync::{Arc, Barrier, Mutex, MutexGuard, OnceLock},
    thread,
    time::Duration,
};

use osfo_agent_run_lifecycle_prototype::{
    CommandOutcome, PostgresLifecycle, RunState,
    workload::{JourneyKind, WorkloadAdmission},
};

fn shared_database_test_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn postgres_admits_workload_metadata_atomically_and_claims_quiet_principals_fairly() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");

    let noisy = lifecycle
        .admit_workload(WorkloadAdmission::new(
            "workload-noisy",
            "noisy",
            JourneyKind::BasicAgentRun,
            "cold-logical-reconstruction",
            1,
        ))
        .expect("admit noisy work");
    let quiet = lifecycle
        .admit_workload(WorkloadAdmission::new(
            "workload-quiet",
            "quiet-1",
            JourneyKind::AwaitedWorkflow,
            "cold-logical-reconstruction",
            2,
        ))
        .expect("admit quiet work");

    let claimed = lifecycle
        .claim_next_workload("worker-1", Duration::from_secs(5))
        .expect("claim next")
        .expect("one queued run");
    assert_eq!(claimed.run_id, quiet.run_id);
    assert_eq!(claimed.principal_id, "quiet-1");
    assert_eq!(claimed.journey_kind, JourneyKind::AwaitedWorkflow);

    assert_eq!(
        lifecycle
            .commit_interaction(
                &claimed.run_id,
                claimed.claim_epoch,
                "model-output-1",
                "AssistantOutputFragment:v1:hello",
            )
            .expect("commit output"),
        CommandOutcome::Applied
    );
    assert_eq!(
        lifecycle
            .commit_interaction(
                &claimed.run_id,
                claimed.claim_epoch,
                "model-output-1",
                "AssistantOutputFragment:v1:hello",
            )
            .expect("idempotent output"),
        CommandOutcome::IdempotentReplay
    );
    assert!(
        lifecycle
            .commit_interaction(
                &claimed.run_id,
                claimed.claim_epoch,
                "model-output-1",
                "AssistantOutputFragment:v1:different",
            )
            .is_err()
    );
    lifecycle
        .complete_run(&claimed.run_id, claimed.claim_epoch, RunState::Succeeded)
        .expect("complete quiet work");

    let second = lifecycle
        .claim_next_workload("worker-1", Duration::from_secs(5))
        .expect("claim noisy")
        .expect("noisy run remains");
    assert_eq!(second.run_id, noisy.run_id);
}

#[test]
fn workload_admission_replays_without_duplicating_its_atomic_semantic_history() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");

    let admission = WorkloadAdmission::new(
        "workload-atomic-history",
        "quiet-1",
        JourneyKind::AwaitedWorkflow,
        "cold-logical-reconstruction",
        42,
    );
    let admitted = lifecycle
        .admit_workload(admission.clone())
        .expect("admit workload");
    assert!(!admitted.idempotent_replay);
    assert_eq!(
        lifecycle
            .semantic_sequence(&admitted.run_id)
            .expect("read semantic history"),
        vec![
            "UserMessage:v1",
            "SemanticConfig:v1:quiet-1:awaited-workflow:cold-logical-reconstruction",
        ]
    );

    let replay = lifecycle
        .admit_workload(admission)
        .expect("replay workload admission");
    assert!(replay.idempotent_replay);
    assert_eq!(replay.run_id, admitted.run_id);
    assert_eq!(
        lifecycle
            .semantic_sequence(&admitted.run_id)
            .expect("read replayed semantic history")
            .len(),
        2
    );

    assert!(
        lifecycle
            .admit_workload(WorkloadAdmission::new(
                "workload-atomic-history",
                "quiet-1",
                JourneyKind::BasicAgentRun,
                "cold-logical-reconstruction",
                42,
            ))
            .is_err(),
        "an idempotency key cannot be reused with a different workload"
    );
}

#[test]
fn concurrent_claimers_commit_one_distinct_claim_record_per_workload() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");

    const WORKLOADS: usize = 256;
    const CLAIMERS: usize = 32;
    for ordinal in 0..WORKLOADS {
        lifecycle
            .admit_workload(WorkloadAdmission::new(
                format!("concurrent-claim-{ordinal}"),
                "quiet-1",
                JourneyKind::BasicAgentRun,
                "cold-logical-reconstruction",
                ordinal as u64,
            ))
            .expect("admit workload");
    }

    let barrier = Arc::new(Barrier::new(CLAIMERS));
    let mut handles = Vec::new();
    for worker in 0..CLAIMERS {
        let database_url = database_url.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            let mut lifecycle =
                PostgresLifecycle::connect(&database_url).expect("connect concurrent claimer");
            barrier.wait();
            let mut claimed = Vec::new();
            while let Some(workload) = lifecycle
                .claim_next_workload_for(
                    &format!("concurrent-worker-{worker}"),
                    Duration::from_secs(5),
                    &[JourneyKind::BasicAgentRun],
                )
                .expect("claim workload")
            {
                claimed.push(workload.run_id);
            }
            claimed
        }));
    }

    let claimed = handles
        .into_iter()
        .flat_map(|handle| handle.join().expect("claimer thread"))
        .collect::<Vec<_>>();
    assert_eq!(claimed.len(), WORKLOADS);
    assert_eq!(claimed.into_iter().collect::<HashSet<_>>().len(), WORKLOADS);
}

#[test]
fn fixed_execution_lanes_claim_only_their_journey_kinds() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");
    lifecycle
        .admit_workload(WorkloadAdmission::new(
            "lane-basic",
            "quiet-1",
            JourneyKind::BasicAgentRun,
            "cold-logical-reconstruction",
            1,
        ))
        .expect("admit basic work");
    let temporal = lifecycle
        .admit_workload(WorkloadAdmission::new(
            "lane-temporal",
            "noisy",
            JourneyKind::AwaitedWorkflow,
            "cold-logical-reconstruction",
            2,
        ))
        .expect("admit Temporal work");

    let claimed = lifecycle
        .claim_next_workload_for(
            "temporal-worker",
            Duration::from_secs(5),
            &[JourneyKind::AwaitedWorkflow, JourneyKind::DetachedWorkflow],
        )
        .expect("claim Temporal lane")
        .expect("Temporal work exists");

    assert_eq!(claimed.run_id, temporal.run_id);
    assert_eq!(claimed.journey_kind, JourneyKind::AwaitedWorkflow);
}
