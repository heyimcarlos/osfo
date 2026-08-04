use osfo_agent_run_lifecycle_prototype::reasoning_lane::{
    AgentDecision, DecisionClass, DiscoverySummary, MAX_DECISION_ATTEMPTS,
    measured_replay_decision, synthetic_discovery_corpus,
};

fn decision(class: DecisionClass) -> AgentDecision {
    AgentDecision {
        decision_class: class,
        quick_reply: false,
        child_agent_runs: 0,
        awaited_child_agent_runs: 0,
        detached_child_agent_runs: 0,
        temporal_workflows: 0,
        temporal_activities: 0,
        approvals: 0,
        tool_calls: 0,
        proactive_messages: 0,
        scheduled_reminders: 0,
        sandbox_jobs: 0,
        artifact_commits: 0,
    }
}

#[test]
fn typed_agent_decision_rejects_internally_inconsistent_work_graphs() {
    let mut invalid = decision(DecisionClass::Research);
    invalid.child_agent_runs = 1;
    invalid.awaited_child_agent_runs = 1;
    invalid.detached_child_agent_runs = 1;

    assert_eq!(
        invalid.validate().unwrap_err().to_string(),
        "awaited and detached children exceed total child AgentRuns"
    );

    let mut quick = decision(DecisionClass::DirectReply);
    quick.quick_reply = true;
    quick.tool_calls = 1;
    assert_eq!(
        quick.validate().unwrap_err().to_string(),
        "a quick reply cannot delegate workflows, children, approvals, or tools"
    );
}

#[test]
fn discovery_summary_reports_measured_agentic_amplification() {
    let mut quick = decision(DecisionClass::DirectReply);
    quick.quick_reply = true;

    let mut delegated = decision(DecisionClass::Research);
    delegated.child_agent_runs = 3;
    delegated.awaited_child_agent_runs = 2;
    delegated.detached_child_agent_runs = 1;
    delegated.temporal_workflows = 1;
    delegated.temporal_activities = 4;
    delegated.tool_calls = 2;

    let summary = DiscoverySummary::from_decisions(&[quick, delegated]).unwrap();

    assert_eq!(summary.messages, 2);
    assert_eq!(summary.quick_replies, 1);
    assert_eq!(summary.root_agent_runs, 2);
    assert_eq!(summary.child_agent_runs, 3);
    assert_eq!(summary.total_agent_runs, 5);
    assert_eq!(summary.temporal_workflows, 1);
    assert_eq!(summary.temporal_activities, 4);
    assert_eq!(summary.tool_calls, 2);
    assert_eq!(summary.total_agent_runs_per_message, 2.5);
    assert_eq!(summary.temporal_workflows_per_message, 0.5);
}

#[test]
fn synthetic_discovery_corpus_covers_the_agentic_seams() {
    let labels = synthetic_discovery_corpus()
        .into_iter()
        .map(|case| case.label)
        .collect::<std::collections::BTreeSet<_>>();

    for required in [
        "quick-conversation",
        "clarification",
        "research-zero-child",
        "research-one-child",
        "research-many-children",
        "awaited-child",
        "detached-child",
        "multi-step-workflow",
        "approval-gated-email",
        "scheduled-reminder",
        "recurring-work",
        "sandbox-artifact",
        "proactive-message",
    ] {
        assert!(
            labels.contains(required),
            "missing discovery case {required}"
        );
    }
}

#[test]
fn agent_decision_schema_explains_counting_rules_to_the_model() {
    let schema = serde_json::to_string(&schemars::schema_for!(AgentDecision))
        .unwrap()
        .to_ascii_lowercase();

    assert!(schema.contains("one approval-gated external action counts as one tool call"));
    assert!(schema.contains("one scheduled reminder requires one temporal workflow"));
    assert!(schema.contains("quick user-visible response with no delegated work"));
}

#[test]
fn live_reasoning_has_one_bounded_semantic_correction_attempt() {
    assert_eq!(MAX_DECISION_ATTEMPTS, 2);
}

#[test]
fn measured_replay_profile_matches_the_confirmed_luna_distribution() {
    let decisions = (0..42).map(measured_replay_decision).collect::<Vec<_>>();
    let summary = DiscoverySummary::from_decisions(&decisions).unwrap();

    assert_eq!(summary.messages, 42);
    assert_eq!(summary.quick_replies, 12);
    assert_eq!(summary.root_agent_runs, 42);
    assert_eq!(summary.child_agent_runs, 21);
    assert_eq!(summary.total_agent_runs, 63);
    assert_eq!(summary.awaited_child_agent_runs, 18);
    assert_eq!(summary.detached_child_agent_runs, 3);
    assert_eq!(summary.temporal_workflows, 15);
    assert_eq!(summary.temporal_activities, 19);
    assert_eq!(summary.approvals, 3);
    assert_eq!(summary.tool_calls, 3);
    assert_eq!(summary.proactive_messages, 9);
    assert_eq!(summary.scheduled_reminders, 3);
    assert_eq!(summary.sandbox_jobs, 3);
    assert_eq!(summary.artifact_commits, 4);
}
