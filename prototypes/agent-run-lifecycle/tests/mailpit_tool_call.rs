use std::sync::{Mutex, MutexGuard, OnceLock};

use osfo_agent_run_lifecycle_prototype::{
    ApprovalDecision, Command, CommandOutcome, EmailMessage, MailpitSmtpSink,
    PostgresApprovalLedger, PostgresLifecycle, RunId, RunState, SmtpSink,
};

fn shared_service_test_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[test]
fn approval_gated_email_wakes_same_run_and_delivers_once_to_mailpit() {
    let _service_guard = shared_service_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect lifecycle");
    lifecycle.reset().expect("reset lifecycle schema");
    let mut approvals =
        PostgresApprovalLedger::connect(&database_url).expect("connect approval ledger");
    let mut mailpit = MailpitSmtpSink::local();
    mailpit.reset().expect("clear Mailpit");

    lifecycle
        .execute(Command::AdmitUserMessage {
            idempotency_key: "email-message-001".into(),
            request_hash: "sha256:email-message-001".into(),
        })
        .expect("admit parent");
    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-a".into(),
        })
        .expect("claim parent");
    approvals
        .open_email_tool(
            &RunId::from("run-parent"),
            1,
            "tool-email-001",
            "approval-email-001",
        )
        .expect("open approval-gated email tool");
    assert_eq!(
        lifecycle
            .run(&RunId::from("run-parent"))
            .expect("parent")
            .state,
        RunState::Waiting
    );

    assert_eq!(
        approvals
            .decide(
                "approval-email-001",
                "decision-email-001",
                ApprovalDecision::Approved,
            )
            .expect("approve email"),
        CommandOutcome::Applied
    );
    assert_eq!(
        approvals
            .decide(
                "approval-email-001",
                "decision-email-001",
                ApprovalDecision::Approved,
            )
            .expect("duplicate approval"),
        CommandOutcome::IdempotentReplay
    );
    assert!(
        approvals
            .decide(
                "approval-email-001",
                "decision-email-wrong",
                ApprovalDecision::Rejected,
            )
            .is_err()
    );
    let parent = lifecycle.run(&RunId::from("run-parent")).expect("parent");
    assert_eq!(parent.state, RunState::Pending);
    assert_eq!(parent.wake_count, 1);

    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-b".into(),
        })
        .expect("reclaim parent");
    approvals
        .begin_attempt(
            &RunId::from("run-parent"),
            2,
            "tool-email-001",
            "attempt-email-001",
        )
        .expect("begin SMTP attempt");
    mailpit
        .send(&EmailMessage {
            from: "osfo@example.invalid".into(),
            to: "fixture@example.invalid".into(),
            subject: "Approved fixture".into(),
            body: "Mailpit only. No real email was sent.".into(),
        })
        .expect("send to Mailpit");
    assert_eq!(
        approvals
            .complete_attempt(
                &RunId::from("run-parent"),
                2,
                "tool-email-001",
                "attempt-email-001",
                "smtp-accepted",
            )
            .expect("commit terminal ToolCall outcome"),
        CommandOutcome::Applied
    );
    assert_eq!(
        approvals
            .complete_attempt(
                &RunId::from("run-parent"),
                2,
                "tool-email-001",
                "attempt-email-001",
                "smtp-accepted",
            )
            .expect("duplicate terminal delivery"),
        CommandOutcome::IdempotentReplay
    );
    assert_eq!(mailpit.message_count().expect("Mailpit message count"), 1);
}

#[test]
fn smtp_attempts_retry_with_new_claim_epochs_and_reconcile_unknown_terminal_commits() {
    let _service_guard = shared_service_test_lock();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect lifecycle");
    lifecycle.reset().expect("reset lifecycle schema");
    let mut approvals =
        PostgresApprovalLedger::connect(&database_url).expect("connect approval ledger");

    lifecycle
        .execute(Command::AdmitUserMessage {
            idempotency_key: "email-retry-001".into(),
            request_hash: "sha256:email-retry-001".into(),
        })
        .expect("admit parent");
    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-a".into(),
        })
        .expect("claim parent");
    approvals
        .open_email_tool(
            &RunId::from("run-parent"),
            1,
            "tool-email-retry",
            "approval-email-retry",
        )
        .expect("open approval");
    approvals
        .decide(
            "approval-email-retry",
            "decision-email-retry",
            ApprovalDecision::Approved,
        )
        .expect("approve");
    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-b".into(),
        })
        .expect("claim approved ToolCall");
    approvals
        .begin_attempt(
            &RunId::from("run-parent"),
            2,
            "tool-email-retry",
            "attempt-email-retry-1",
        )
        .expect("begin first attempt");
    assert_eq!(
        approvals
            .fail_attempt(
                &RunId::from("run-parent"),
                2,
                "tool-email-retry",
                "attempt-email-retry-1",
                "smtp-refused",
                2,
            )
            .expect("schedule bounded retry"),
        CommandOutcome::Applied
    );
    assert_eq!(
        lifecycle.run(&RunId::from("run-parent")).unwrap().state,
        RunState::RetryReady
    );

    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-c".into(),
        })
        .expect("claim retry");
    approvals
        .begin_attempt(
            &RunId::from("run-parent"),
            3,
            "tool-email-retry",
            "attempt-email-retry-2",
        )
        .expect("begin second attempt");
    approvals
        .mark_attempt_unknown(
            &RunId::from("run-parent"),
            3,
            "tool-email-retry",
            "attempt-email-retry-2",
            "smtp-connection-dropped-after-data",
        )
        .expect("mark unknown external outcome");
    assert_eq!(
        approvals
            .complete_attempt(
                &RunId::from("run-parent"),
                3,
                "tool-email-retry",
                "attempt-email-retry-2",
                "smtp-accepted",
            )
            .expect("reconcile unknown attempt"),
        CommandOutcome::Applied
    );
    assert_eq!(
        approvals
            .complete_attempt(
                &RunId::from("run-parent"),
                3,
                "tool-email-retry",
                "attempt-email-retry-2",
                "smtp-accepted",
            )
            .expect("reconcile lost terminal acknowledgement"),
        CommandOutcome::IdempotentReplay
    );
}
