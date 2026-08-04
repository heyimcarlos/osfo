use osfo_agent_run_lifecycle_prototype::{
    ChildJoinMode, Command, CommandOutcome, LifecycleManager, MemoryLedger, RunId, RunState,
};

#[test]
fn awaited_reference_journey_wakes_the_same_parent_exactly_once() {
    let mut lifecycle = LifecycleManager::new(MemoryLedger::default());

    let parent = lifecycle
        .execute(Command::AdmitUserMessage {
            idempotency_key: "message-001".into(),
            request_hash: "sha256:message-001".into(),
        })
        .expect("admit parent");
    assert_eq!(
        parent,
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

    let parent_after_join = lifecycle
        .run(&RunId::from("run-parent"))
        .expect("parent after join");
    assert_eq!(parent_after_join.state, RunState::Pending);
    assert_eq!(parent_after_join.wake_count, 1);

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
        .execute(Command::DeliverWorkflowOutcome {
            workflow_instance_id: "workflow-001".into(),
            delivery_id: "delivery-001".into(),
            outcome: "published".into(),
        })
        .expect("deliver workflow outcome");
    lifecycle
        .execute(Command::DeliverWorkflowOutcome {
            workflow_instance_id: "workflow-001".into(),
            delivery_id: "delivery-001".into(),
            outcome: "published".into(),
        })
        .expect("redeliver after lost acknowledgement");

    let parent_after_workflow = lifecycle
        .run(&RunId::from("run-parent"))
        .expect("parent after workflow");
    assert_eq!(parent_after_workflow.state, RunState::Pending);
    assert_eq!(parent_after_workflow.wake_count, 2);
    assert_eq!(parent_after_workflow.claim_epoch, 2);

    assert_eq!(
        lifecycle.semantic_sequence(&RunId::from("run-parent")),
        vec![
            "UserMessage:v1",
            "AgentRunClaimed:1",
            "ChildJoinOpened:join-001",
            "ChildOutcome:run-child-b:artifact-ready",
            "ChildOutcome:run-child-a:research-ready",
            "ChildJoinSettled:join-001",
            "AgentRunClaimed:2",
            "WorkflowStartIntent:workflow-001",
            "WorkflowOutcome:workflow-001:published",
        ]
    );
}
