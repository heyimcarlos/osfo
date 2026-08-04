use std::{
    sync::{Arc, Barrier, Mutex, MutexGuard, OnceLock},
    thread,
    time::Duration,
};

use osfo_agent_run_lifecycle_prototype::{
    Command, CommandOutcome, PostgresLifecycle, RunId, RunState,
};

fn shared_database_test_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn expired_lease_takeover_fences_stale_commit_and_terminal_reclaim() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");
    lifecycle
        .execute(Command::AdmitUserMessage {
            idempotency_key: "fencing-001".into(),
            request_hash: "sha256:fencing-001".into(),
        })
        .expect("admit run");
    lifecycle
        .claim_with_lease(
            &RunId::from("run-parent"),
            "worker-stale",
            Duration::from_millis(20),
        )
        .expect("initial claim");
    thread::sleep(Duration::from_millis(30));
    lifecycle
        .takeover_expired(
            &RunId::from("run-parent"),
            "worker-current",
            Duration::from_secs(1),
        )
        .expect("expired lease takeover");

    assert!(
        lifecycle
            .complete_run(&RunId::from("run-parent"), 1, RunState::Succeeded)
            .is_err()
    );
    lifecycle
        .complete_run(&RunId::from("run-parent"), 2, RunState::Succeeded)
        .expect("current attempt completion");
    assert_eq!(
        lifecycle
            .run(&RunId::from("run-parent"))
            .expect("run")
            .state,
        RunState::Succeeded
    );
    assert!(
        lifecycle
            .execute(Command::Claim {
                run_id: RunId::from("run-parent"),
                worker_id: "worker-late".into(),
            })
            .is_err()
    );
}

#[test]
fn concurrent_interaction_commits_allocate_distinct_sequences_after_the_run_lock() {
    let _database_guard = shared_database_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");
    lifecycle
        .execute(Command::AdmitUserMessage {
            idempotency_key: "concurrent-sequence-001".into(),
            request_hash: "sha256:concurrent-sequence-001".into(),
        })
        .expect("admit run");
    lifecycle
        .claim_with_lease(
            &RunId::from("run-parent"),
            "worker-current",
            Duration::from_secs(5),
        )
        .expect("claim run");

    const COMMITTERS: usize = 32;
    let barrier = Arc::new(Barrier::new(COMMITTERS));
    let mut handles = Vec::new();
    for index in 0..COMMITTERS {
        let database_url = database_url.clone();
        let barrier = barrier.clone();
        handles.push(thread::spawn(move || {
            let mut lifecycle =
                PostgresLifecycle::connect(&database_url).expect("connect concurrent committer");
            barrier.wait();
            lifecycle.commit_interaction(
                &RunId::from("run-parent"),
                1,
                &format!("concurrent-{index}"),
                &format!("AssistantOutputFragment:v1:{index}"),
            )
        }));
    }
    for handle in handles {
        assert_eq!(
            handle.join().expect("committer thread").expect("commit"),
            CommandOutcome::Applied
        );
    }

    let records = lifecycle
        .semantic_sequence(&RunId::from("run-parent"))
        .expect("read semantic sequence");
    assert_eq!(records.len(), COMMITTERS + 2);
}
