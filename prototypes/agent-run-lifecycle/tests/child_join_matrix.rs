use osfo_agent_run_lifecycle_prototype::{
    ChildJoinMode, Command, CommandOutcome, PostgresLifecycle, RunId, RunState,
};

#[test]
fn child_join_modes_deadline_late_outcomes_and_root_limit_preserve_one_wake() {
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect PostgreSQL");

    lifecycle.reset().expect("reset for FirstSuccessful");
    admit_and_claim(&mut lifecycle, "first-successful");
    lifecycle
        .execute(Command::AdmitChildren {
            parent_run_id: RunId::from("run-parent"),
            parent_claim_epoch: 1,
            join_id: "join-first".into(),
            mode: ChildJoinMode::FirstSuccessful,
            child_run_ids: vec![RunId::from("child-failed"), RunId::from("child-succeeded")],
        })
        .expect("admit FirstSuccessful children");
    lifecycle
        .execute(Command::CompleteChild {
            child_run_id: RunId::from("child-failed"),
            outcome: "failed:provider".into(),
        })
        .expect("record failed child");
    assert_eq!(
        lifecycle
            .run(&RunId::from("run-parent"))
            .expect("parent")
            .state,
        RunState::Waiting
    );
    lifecycle
        .execute(Command::CompleteChild {
            child_run_id: RunId::from("child-succeeded"),
            outcome: "artifact-ready".into(),
        })
        .expect("record successful child");
    assert_eq!(
        lifecycle
            .run(&RunId::from("run-parent"))
            .expect("parent")
            .wake_count,
        1
    );
    assert_eq!(
        lifecycle
            .run(&RunId::from("child-failed"))
            .expect("failed child")
            .state,
        RunState::Failed
    );

    lifecycle.reset().expect("reset for deadline");
    admit_and_claim(&mut lifecycle, "deadline");
    lifecycle
        .execute(Command::AdmitChildren {
            parent_run_id: RunId::from("run-parent"),
            parent_claim_epoch: 1,
            join_id: "join-deadline".into(),
            mode: ChildJoinMode::AllTerminal,
            child_run_ids: vec![RunId::from("child-late"), RunId::from("child-canceled")],
        })
        .expect("admit deadline children");
    lifecycle
        .expire_child_join("join-deadline")
        .expect("settle expired join");
    assert_eq!(
        lifecycle
            .expire_child_join("join-deadline")
            .expect("repeat deadline"),
        CommandOutcome::IdempotentReplay
    );
    assert_eq!(
        lifecycle
            .execute(Command::CompleteChild {
                child_run_id: RunId::from("child-late"),
                outcome: "late-success".into(),
            })
            .expect("late outcome"),
        CommandOutcome::IdempotentReplay
    );
    let parent = lifecycle.run(&RunId::from("run-parent")).expect("parent");
    assert_eq!(parent.state, RunState::Pending);
    assert_eq!(parent.wake_count, 1);
    assert_eq!(
        lifecycle
            .run(&RunId::from("child-late"))
            .expect("late child")
            .state,
        RunState::Canceled
    );

    lifecycle.reset().expect("reset for root limit");
    admit_and_claim(&mut lifecycle, "root-limit");
    let children = (0..64)
        .map(|index| RunId::from(format!("child-{index}").as_str()))
        .collect();
    assert!(
        lifecycle
            .execute(Command::AdmitChildren {
                parent_run_id: RunId::from("run-parent"),
                parent_claim_epoch: 1,
                join_id: "join-over-limit".into(),
                mode: ChildJoinMode::AllTerminal,
                child_run_ids: children,
            })
            .is_err()
    );
    assert_eq!(
        lifecycle
            .run(&RunId::from("run-parent"))
            .expect("parent")
            .state,
        RunState::Running
    );
}

fn admit_and_claim(lifecycle: &mut PostgresLifecycle, suffix: &str) {
    lifecycle
        .execute(Command::AdmitUserMessage {
            idempotency_key: format!("message-{suffix}"),
            request_hash: format!("sha256:{suffix}"),
        })
        .expect("admit root");
    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-a".into(),
        })
        .expect("claim root");
}
