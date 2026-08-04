use osfo_agent_run_lifecycle_prototype::{
    ChildJoinMode, Command, PostgresLifecycle, RunId, RunState, temporal_lane::run_temporal_smoke,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_temporal_outcome_wakes_the_cloud_sql_owned_agent_run() {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let database_url = std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into());
    let temporal_address = std::env::var("TEMPORAL_ADDRESS")
        .expect("TEMPORAL_ADDRESS must identify the Temporal Cloud namespace endpoint");
    let setup_database_url = database_url.clone();
    tokio::task::spawn_blocking(move || {
        let mut lifecycle =
            PostgresLifecycle::connect(&setup_database_url).expect("connect PostgreSQL");
        lifecycle.reset().expect("reset authority schema");
        lifecycle
            .execute(Command::AdmitUserMessage {
                idempotency_key: "vertical-message-001".into(),
                request_hash: "sha256:vertical-message-001".into(),
            })
            .expect("admit parent");
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
                join_id: "vertical-join-001".into(),
                mode: ChildJoinMode::AllTerminal,
                child_run_ids: vec![
                    RunId::from("vertical-child-a"),
                    RunId::from("vertical-child-b"),
                ],
            })
            .expect("admit child AgentRuns");
        for (child, outcome) in [
            ("vertical-child-a", "research-ready"),
            ("vertical-child-b", "artifact-plan-ready"),
        ] {
            lifecycle
                .execute(Command::CompleteChild {
                    child_run_id: RunId::from(child),
                    outcome: outcome.into(),
                })
                .expect("complete child AgentRun");
        }
        lifecycle
            .execute(Command::Claim {
                run_id: RunId::from("run-parent"),
                worker_id: "worker-b".into(),
            })
            .expect("reclaim after ChildJoin");
        lifecycle
            .execute(Command::StartAwaitedWorkflow {
                parent_run_id: RunId::from("run-parent"),
                parent_claim_epoch: 2,
                tool_call_id: "vertical-workflow-tool-001".into(),
                workflow_instance_id: "vertical-workflow-001".into(),
            })
            .expect("commit WorkflowInstance start intent");
    })
    .await
    .expect("join lifecycle setup");

    let temporal = run_temporal_smoke(&temporal_address)
        .await
        .expect("run real Temporal workflow and worker");
    assert!(
        temporal
            .steps
            .iter()
            .any(|step| step.starts_with("artifact-committed:"))
    );
    let typed_outcome = serde_json::to_string(&temporal.steps).expect("encode typed outcome");
    tokio::task::spawn_blocking(move || {
        let mut lifecycle =
            PostgresLifecycle::connect(&database_url).expect("reconnect PostgreSQL");
        lifecycle
            .execute(Command::DeliverWorkflowOutcome {
                workflow_instance_id: "vertical-workflow-001".into(),
                delivery_id: "vertical-delivery-001".into(),
                outcome: typed_outcome.clone(),
            })
            .expect("accept Temporal outcome through Osfo");
        lifecycle
            .execute(Command::DeliverWorkflowOutcome {
                workflow_instance_id: "vertical-workflow-001".into(),
                delivery_id: "vertical-delivery-001".into(),
                outcome: typed_outcome,
            })
            .expect("reconcile lost acknowledgement");

        let parent = lifecycle.run(&RunId::from("run-parent")).expect("parent");
        assert_eq!(parent.state, RunState::Pending);
        assert_eq!(parent.wake_count, 2);
        assert_eq!(parent.claim_epoch, 2);
    })
    .await
    .expect("join lifecycle outcome delivery");
}
