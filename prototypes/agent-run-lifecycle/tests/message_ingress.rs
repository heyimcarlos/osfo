use std::time::Duration;

use osfo_agent_run_lifecycle_prototype::{
    PostgresLifecycle,
    ingress::{MessageAdmission, PostgresMessageStore},
    reasoning_lane::{DiscoverySummary, measured_replay_decision},
    workload::JourneyKind,
};

static DATABASE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn database_url() -> String {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into())
}

fn admission(idempotency_key: &str, request_hash: &str) -> MessageAdmission {
    MessageAdmission {
        account_id: "account-a".into(),
        thread_id: "thread-a".into(),
        idempotency_key: idempotency_key.into(),
        request_hash: request_hash.into(),
        message_id: format!("message-{idempotency_key}"),
        content: "Research a durable agent primitive".into(),
        journey_kind: JourneyKind::BasicAgentRun,
    }
}

async fn reset(url: &str) {
    let url = url.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut lifecycle = PostgresLifecycle::connect(&url).expect("connect lifecycle");
        lifecycle.reset().expect("reset schema");
    })
    .await
    .expect("reset worker");
}

#[tokio::test]
async fn message_admission_is_atomic_and_duplicate_safe() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 4).expect("connect message store");

    let first = store
        .admit_message(&admission("idem-1", "sha256:request-a"))
        .await
        .expect("admit first message");
    let replay = store
        .admit_message(&admission("idem-1", "sha256:request-a"))
        .await
        .expect("replay same message");

    assert!(!first.idempotent_replay);
    assert!(replay.idempotent_replay);
    assert_eq!(replay.run_id, first.run_id);
    assert_eq!(replay.event_sequence, first.event_sequence);
    assert_eq!(store.count_root_runs().await.expect("count runs"), 1);
    assert_eq!(store.count_events().await.expect("count events"), 1);

    let conflict = store
        .admit_message(&admission("idem-1", "sha256:request-b"))
        .await;
    assert!(conflict.is_err());
    assert_eq!(store.count_root_runs().await.expect("count runs"), 1);
    assert_eq!(store.count_events().await.expect("count events"), 1);
}

#[tokio::test]
async fn cursor_replay_is_account_scoped_and_identical_for_four_devices() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 4).expect("connect message store");

    for ordinal in 1..=3 {
        store
            .admit_message(&admission(
                &format!("idem-{ordinal}"),
                &format!("sha256:request-{ordinal}"),
            ))
            .await
            .expect("admit message");
    }

    let expected = store
        .replay("account-a", "thread-a", 0, 100)
        .await
        .expect("replay thread");
    assert_eq!(expected.len(), 3);
    assert_eq!(
        expected
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    for _device in 0..4 {
        assert_eq!(
            store
                .replay("account-a", "thread-a", 0, 100)
                .await
                .expect("device replay"),
            expected
        );
    }
    assert!(
        store
            .replay("account-b", "thread-a", 0, 100)
            .await
            .expect("cross-account replay")
            .is_empty()
    );
}

#[tokio::test]
async fn worker_commits_output_event_and_terminal_state_atomically() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 4).expect("connect message store");
    let admitted = store
        .admit_message(&admission("idem-output", "sha256:output"))
        .await
        .expect("admit message");
    let claimed = store
        .claim_next("worker-a", Duration::from_secs(30))
        .await
        .expect("claim query")
        .expect("claim one run");
    assert_eq!(claimed.run_id, admitted.run_id);

    let completed = store
        .commit_assistant_output(&claimed.run_id, claimed.claim_epoch, "A durable response")
        .await
        .expect("commit assistant output");

    assert_eq!(completed.sequence, 2);
    let events = store
        .replay("account-a", "thread-a", 0, 100)
        .await
        .expect("replay complete thread");
    assert_eq!(events.len(), 2);
    assert_eq!(events[1].event_type, "assistant.message.completed");
    assert_eq!(
        store.run_state(&claimed.run_id).await.expect("read run"),
        osfo_agent_run_lifecycle_prototype::RunState::Succeeded
    );
}

#[tokio::test]
async fn deterministic_deployed_journeys_preserve_typed_dependency_records() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 4).expect("connect message store");
    let cases = [
        (JourneyKind::AwaitedWorkflow, 1, 0),
        (JourneyKind::DetachedWorkflow, 1, 0),
        (JourneyKind::ApprovalSmtp, 0, 1),
    ];

    for (ordinal, (journey_kind, workflows, tool_calls)) in cases.into_iter().enumerate() {
        let mut message = admission(
            &format!("idem-typed-{ordinal}"),
            &format!("sha256:typed-{ordinal}"),
        );
        message.thread_id = format!("thread-typed-{ordinal}");
        message.journey_kind = journey_kind;
        let admitted = store.admit_message(&message).await.expect("admit journey");
        let claimed = store
            .claim_next("typed-worker", Duration::from_secs(30))
            .await
            .expect("claim journey")
            .expect("claimed journey");
        store
            .commit_assistant_output(&claimed.run_id, claimed.claim_epoch, "typed outcome")
            .await
            .expect("commit typed journey");

        let evidence = store
            .run_evidence("account-a", admitted.run_id.as_str())
            .await
            .expect("query journey evidence")
            .expect("journey evidence");
        assert_eq!(evidence.workflow_instances, workflows);
        assert_eq!(evidence.workflow_deliveries, workflows);
        assert_eq!(evidence.tool_calls, tool_calls);
        assert_eq!(evidence.approvals, tool_calls);
        assert_eq!(evidence.tool_attempts, tool_calls);
    }
}

#[tokio::test]
async fn confirmed_luna_trace_replays_the_measured_work_graph_in_postgres() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 8).expect("connect message store");
    let decisions = (0..42).map(measured_replay_decision).collect::<Vec<_>>();
    let expected = DiscoverySummary::from_decisions(&decisions).expect("summarize trace");
    let mut actual = DiscoverySummary::from_decisions(&[]).expect("empty summary");

    for (ordinal, decision) in decisions.iter().enumerate() {
        let mut message = admission(
            &format!("idem-luna-{ordinal}"),
            &format!("sha256:luna-{ordinal}"),
        );
        message.thread_id = format!("thread-luna-{ordinal}");
        message.journey_kind = JourneyKind::MeasuredAgentDecision;
        let admitted = store
            .admit_message(&message)
            .await
            .expect("admit Luna trace");
        let mut claimed = store
            .claim_next("luna-replay-worker", Duration::from_secs(30))
            .await
            .expect("claim root")
            .expect("root run");

        if decision.awaited_child_agent_runs > 0 {
            store
                .begin_child_fanout(
                    &claimed.run_id,
                    claimed.claim_epoch,
                    usize::from(decision.awaited_child_agent_runs),
                )
                .await
                .expect("begin awaited children");
            for _ in 0..decision.awaited_child_agent_runs {
                let child = store
                    .claim_next("luna-replay-child", Duration::from_secs(30))
                    .await
                    .expect("claim child")
                    .expect("awaited child");
                store
                    .complete_child(&child.run_id, child.claim_epoch, "succeeded")
                    .await
                    .expect("complete awaited child");
            }
            claimed = store
                .claim_next("luna-replay-worker", Duration::from_secs(30))
                .await
                .expect("reclaim parent")
                .expect("woken parent");
        }
        if decision.detached_child_agent_runs > 0 {
            store
                .begin_detached_children(
                    &claimed.run_id,
                    claimed.claim_epoch,
                    usize::from(decision.detached_child_agent_runs),
                )
                .await
                .expect("begin detached children");
        }
        store
            .commit_assistant_output(&claimed.run_id, claimed.claim_epoch, "replayed outcome")
            .await
            .expect("commit root");
        for _ in 0..decision.detached_child_agent_runs {
            let child = store
                .claim_next("luna-replay-child", Duration::from_secs(30))
                .await
                .expect("claim detached child")
                .expect("detached child");
            store
                .complete_child(&child.run_id, child.claim_epoch, "succeeded")
                .await
                .expect("complete detached child");
        }

        let evidence = store
            .run_evidence("account-a", admitted.run_id.as_str())
            .await
            .expect("query evidence")
            .expect("run evidence");
        actual.messages += 1;
        actual.quick_replies += u64::from(evidence.quick_reply);
        actual.root_agent_runs += 1;
        actual.child_agent_runs += evidence.child_agent_runs;
        actual.total_agent_runs += evidence.total_agent_runs;
        actual.awaited_child_agent_runs += evidence.awaited_child_agent_runs;
        actual.detached_child_agent_runs += evidence.detached_child_agent_runs;
        actual.temporal_workflows += evidence.workflow_instances;
        actual.temporal_activities += evidence.workflow_activities;
        actual.approvals += evidence.approvals;
        actual.tool_calls += evidence.tool_calls;
        actual.proactive_messages += evidence.proactive_messages;
        actual.scheduled_reminders += evidence.scheduled_reminders;
        actual.sandbox_jobs += evidence.sandbox_jobs;
        actual.artifact_commits += evidence.artifact_commits;
    }

    assert_eq!(actual.messages, expected.messages);
    assert_eq!(actual.quick_replies, expected.quick_replies);
    assert_eq!(actual.root_agent_runs, expected.root_agent_runs);
    assert_eq!(actual.child_agent_runs, expected.child_agent_runs);
    assert_eq!(actual.total_agent_runs, expected.total_agent_runs);
    assert_eq!(
        actual.awaited_child_agent_runs,
        expected.awaited_child_agent_runs
    );
    assert_eq!(
        actual.detached_child_agent_runs,
        expected.detached_child_agent_runs
    );
    assert_eq!(actual.temporal_workflows, expected.temporal_workflows);
    assert_eq!(actual.temporal_activities, expected.temporal_activities);
    assert_eq!(actual.approvals, expected.approvals);
    assert_eq!(actual.tool_calls, expected.tool_calls);
    assert_eq!(actual.proactive_messages, expected.proactive_messages);
    assert_eq!(actual.scheduled_reminders, expected.scheduled_reminders);
    assert_eq!(actual.sandbox_jobs, expected.sandbox_jobs);
    assert_eq!(actual.artifact_commits, expected.artifact_commits);
}

#[tokio::test]
async fn worker_claims_a_bounded_batch_in_one_dispatch_transaction() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 4).expect("connect message store");
    for ordinal in 1..=3 {
        store
            .admit_message(&admission(
                &format!("idem-batch-{ordinal}"),
                &format!("sha256:batch-{ordinal}"),
            ))
            .await
            .expect("admit batched work");
    }

    let first = store
        .claim_batch("batch-worker", Duration::from_secs(30), 2)
        .await
        .expect("claim first batch");
    let second = store
        .claim_batch("batch-worker", Duration::from_secs(30), 2)
        .await
        .expect("claim second batch");
    let empty = store
        .claim_batch("batch-worker", Duration::from_secs(30), 2)
        .await
        .expect("claim empty batch");

    assert_eq!(first.len(), 2);
    assert_eq!(second.len(), 1);
    assert!(empty.is_empty());
    let mut run_ids = first
        .iter()
        .chain(&second)
        .map(|claim| claim.run_id.as_str())
        .collect::<Vec<_>>();
    run_ids.sort_unstable();
    run_ids.dedup();
    assert_eq!(run_ids.len(), 3);
    assert!(
        first
            .iter()
            .chain(&second)
            .all(|claim| claim.claim_epoch == 1)
    );
}

#[tokio::test]
async fn worker_installs_the_bounded_dispatch_index_idempotently() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("connect catalog client");
    tokio::spawn(async move {
        connection.await.expect("catalog connection");
    });
    client
        .batch_execute(
            "DROP INDEX IF EXISTS agent_run_lifecycle.agent_runs_dispatch_active_idx;
             DROP INDEX IF EXISTS agent_run_lifecycle.agent_runs_dispatch_claimable_idx;
             DROP INDEX IF EXISTS agent_run_lifecycle.agent_runs_dispatch_expired_idx;
             DROP INDEX IF EXISTS agent_run_lifecycle.thread_events_run_lookup_idx",
        )
        .await
        .expect("drop dispatch index");
    let store = PostgresMessageStore::connect(&url, 2).expect("connect message store");

    store
        .ensure_runtime_indexes()
        .await
        .expect("install dispatch index");
    store
        .ensure_runtime_indexes()
        .await
        .expect("reinstall dispatch index");

    let claimable: String = client
        .query_one(
            "SELECT indexdef FROM pg_indexes
             WHERE schemaname = 'agent_run_lifecycle'
               AND indexname = 'agent_runs_dispatch_claimable_idx'",
            &[],
        )
        .await
        .expect("read dispatch index")
        .get(0);
    assert!(claimable.contains("workload_ordinal IS NOT NULL"));
    assert!(claimable.contains("'pending'"));
    assert!(!claimable.contains("'running'"));
    let expired: String = client
        .query_one(
            "SELECT indexdef FROM pg_indexes
             WHERE schemaname = 'agent_run_lifecycle'
               AND indexname = 'agent_runs_dispatch_expired_idx'",
            &[],
        )
        .await
        .expect("read expired-lease index")
        .get(0);
    assert!(expired.contains("(lease_until, created_at, run_id)"));
    assert!(expired.contains("state = 'running'"));
    let thread_lookup: String = client
        .query_one(
            "SELECT indexdef FROM pg_indexes
             WHERE schemaname = 'agent_run_lifecycle'
               AND indexname = 'thread_events_run_lookup_idx'",
            &[],
        )
        .await
        .expect("read ThreadEvent lookup index")
        .get(0);
    assert!(thread_lookup.contains("(run_id, event_type)"));
    assert!(thread_lookup.contains("INCLUDE (account_id, thread_id)"));
}

#[tokio::test]
async fn owner_initializes_only_an_empty_lifecycle_schema() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 2).expect("connect message store");
    assert!(store.initialize_empty_schema().await.is_err());

    let (client, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls)
        .await
        .expect("connect schema owner");
    tokio::spawn(async move {
        connection.await.expect("schema owner connection");
    });
    client
        .batch_execute("DROP SCHEMA agent_run_lifecycle CASCADE")
        .await
        .expect("drop test schema");

    store
        .initialize_empty_schema()
        .await
        .expect("initialize empty schema");
    let table_exists: bool = client
        .query_one(
            "SELECT to_regclass('agent_run_lifecycle.agent_runs') IS NOT NULL",
            &[],
        )
        .await
        .expect("read initialized schema")
        .get(0);
    assert!(table_exists);
}

#[tokio::test]
async fn expired_worker_lease_is_taken_over_and_stale_output_is_fenced() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 4).expect("connect message store");
    let admitted = store
        .admit_message(&admission("idem-takeover", "sha256:takeover"))
        .await
        .expect("admit message");
    let original = store
        .claim_next("worker-original", Duration::from_millis(10))
        .await
        .expect("original claim")
        .expect("one run");
    tokio::time::sleep(Duration::from_millis(20)).await;
    let takeover = store
        .claim_next("worker-takeover", Duration::from_secs(30))
        .await
        .expect("takeover claim")
        .expect("expired run");

    assert_eq!(takeover.run_id, admitted.run_id);
    assert_eq!(takeover.claim_epoch, original.claim_epoch + 1);
    assert!(
        store
            .commit_assistant_output(&original.run_id, original.claim_epoch, "stale output")
            .await
            .is_err()
    );
    store
        .commit_assistant_output(&takeover.run_id, takeover.claim_epoch, "recovered output")
        .await
        .expect("takeover output");
    assert_eq!(
        store.run_state(&admitted.run_id).await.expect("run state"),
        osfo_agent_run_lifecycle_prototype::RunState::Succeeded
    );
}

#[tokio::test]
async fn child_fanout_creates_independently_claimed_agent_runs_and_resumes_parent() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    reset(&url).await;
    let store = PostgresMessageStore::connect(&url, 4).expect("connect message store");
    let mut message = admission("idem-fanout", "sha256:fanout");
    message.journey_kind = JourneyKind::ChildFanout;
    let admitted = store.admit_message(&message).await.expect("admit fanout");
    let parent = store
        .claim_next("worker-parent", Duration::from_secs(30))
        .await
        .expect("claim parent")
        .expect("parent run");

    let children = store
        .begin_child_fanout(&parent.run_id, parent.claim_epoch, 2)
        .await
        .expect("open child join");
    assert_eq!(children.len(), 2);
    assert_eq!(
        store
            .run_state(&admitted.run_id)
            .await
            .expect("parent state"),
        osfo_agent_run_lifecycle_prototype::RunState::Waiting
    );

    for expected_child in &children {
        let claimed = store
            .claim_next("worker-child", Duration::from_secs(30))
            .await
            .expect("claim child")
            .expect("child run");
        assert_eq!(&claimed.run_id, expected_child);
        assert_eq!(claimed.parent_run_id.as_ref(), Some(&admitted.run_id));
        store
            .complete_child(&claimed.run_id, claimed.claim_epoch, "succeeded")
            .await
            .expect("complete child");
    }

    let resumed = store
        .claim_next("worker-parent-resumed", Duration::from_secs(30))
        .await
        .expect("claim resumed parent")
        .expect("resumed parent");
    assert_eq!(resumed.run_id, admitted.run_id);
    store
        .commit_assistant_output(&resumed.run_id, resumed.claim_epoch, "Fanout completed")
        .await
        .expect("complete parent");

    assert_eq!(store.count_root_runs().await.expect("root count"), 1);
    assert_eq!(store.count_child_runs().await.expect("child count"), 2);
}
