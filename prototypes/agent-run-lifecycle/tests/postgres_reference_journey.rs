use osfo_agent_run_lifecycle_prototype::{
    ChildJoinMode, Command, CommandOutcome, PostgresLifecycle, RunId, RunState,
};

#[test]
fn postgres_is_authority_for_the_awaited_reference_journey() {
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let mut lifecycle = PostgresLifecycle::connect(&database_url).expect("connect to PostgreSQL");
    lifecycle.reset().expect("reset lifecycle schema");

    assert_eq!(
        lifecycle
            .execute(Command::AdmitUserMessage {
                idempotency_key: "message-001".into(),
                request_hash: "sha256:message-001".into(),
            })
            .expect("admit parent"),
        CommandOutcome::RunAdmitted(RunId::from("run-parent"))
    );
    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-a".into(),
        })
        .expect("claim parent");
    lifecycle
        .execute(Command::AdmitChildren {
            parent_run_id: RunId::from("run-parent"),
            parent_claim_epoch: 1,
            join_id: "join-001".into(),
            mode: ChildJoinMode::AllTerminal,
            child_run_ids: vec![RunId::from("run-child-a"), RunId::from("run-child-b")],
        })
        .expect("admit children");
    lifecycle
        .execute(Command::CompleteChild {
            child_run_id: RunId::from("run-child-b"),
            outcome: "artifact-ready".into(),
        })
        .expect("complete second child first");
    lifecycle
        .execute(Command::CompleteChild {
            child_run_id: RunId::from("run-child-a"),
            outcome: "research-ready".into(),
        })
        .expect("complete first child");

    assert_eq!(
        lifecycle
            .run(&RunId::from("run-parent"))
            .expect("parent")
            .state,
        RunState::Pending
    );
    lifecycle
        .execute(Command::Claim {
            run_id: RunId::from("run-parent"),
            worker_id: "worker-b".into(),
        })
        .expect("reclaim parent");
    lifecycle
        .execute(Command::StartAwaitedWorkflow {
            parent_run_id: RunId::from("run-parent"),
            parent_claim_epoch: 2,
            tool_call_id: "tool-workflow-001".into(),
            workflow_instance_id: "workflow-001".into(),
        })
        .expect("start awaited workflow");
    lifecycle
        .deliver_workflow_progress(
            "workflow-001",
            "progress-001",
            "WorkflowProgress:v1:artifact-exported",
        )
        .expect("deliver workflow progress");
    assert_eq!(
        lifecycle
            .deliver_workflow_progress(
                "workflow-001",
                "progress-001",
                "WorkflowProgress:v1:artifact-exported",
            )
            .expect("redeliver workflow progress"),
        CommandOutcome::IdempotentReplay
    );
    lifecycle
        .execute(Command::DeliverWorkflowOutcome {
            workflow_instance_id: "workflow-001".into(),
            delivery_id: "delivery-001".into(),
            outcome: "published".into(),
        })
        .expect("deliver workflow outcome");
    assert_eq!(
        lifecycle
            .execute(Command::DeliverWorkflowOutcome {
                workflow_instance_id: "workflow-001".into(),
                delivery_id: "delivery-001".into(),
                outcome: "published".into(),
            })
            .expect("redeliver workflow outcome"),
        CommandOutcome::IdempotentReplay
    );

    let parent = lifecycle.run(&RunId::from("run-parent")).expect("parent");
    assert_eq!(parent.state, RunState::Pending);
    assert_eq!(parent.wake_count, 2);
    assert_eq!(parent.claim_epoch, 2);
    assert_eq!(
        lifecycle
            .semantic_sequence(&RunId::from("run-parent"))
            .expect("semantic sequence"),
        vec![
            "UserMessage:v1",
            "AgentRunClaimed:1",
            "ChildJoinOpened:join-001",
            "ChildOutcome:run-child-b:artifact-ready",
            "ChildOutcome:run-child-a:research-ready",
            "ChildJoinSettled:join-001",
            "AgentRunClaimed:2",
            "WorkflowStartIntent:workflow-001",
            "WorkflowProgress:workflow-001:WorkflowProgress:v1:artifact-exported",
            "WorkflowOutcome:workflow-001:published",
        ]
    );
}
