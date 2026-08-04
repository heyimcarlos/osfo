use std::collections::BTreeMap;

use osfo_agent_run_lifecycle_prototype::confirmation::{JourneyMix, PrincipalMix};
use osfo_agent_run_lifecycle_prototype::workload::{JourneyKind, WorkloadSelector};

#[test]
fn deterministic_selector_produces_the_exact_declared_mix_per_hundred_runs() {
    let selector = WorkloadSelector::new(
        130013,
        JourneyMix {
            basic_agent_run_percent: 90,
            child_fanout_percent: 4,
            awaited_workflow_percent: 2,
            detached_workflow_percent: 1,
            sandbox_artifact_percent: 1,
            approval_smtp_percent: 1,
            full_reference_journey_percent: 1,
        },
        PrincipalMix {
            noisy_percent: 80,
            quiet_principal_count: 4,
        },
    );

    let counts = (0..100).fold(BTreeMap::new(), |mut counts, ordinal| {
        *counts.entry(selector.journey(ordinal)).or_insert(0) += 1;
        counts
    });

    assert_eq!(counts[&JourneyKind::BasicAgentRun], 90);
    assert_eq!(counts[&JourneyKind::ChildFanout], 4);
    assert_eq!(counts[&JourneyKind::AwaitedWorkflow], 2);
    assert_eq!(counts[&JourneyKind::DetachedWorkflow], 1);
    assert_eq!(counts[&JourneyKind::SandboxArtifact], 1);
    assert_eq!(counts[&JourneyKind::ApprovalSmtp], 1);
    assert_eq!(counts[&JourneyKind::FullReferenceJourney], 1);

    let principals = (0..100)
        .map(|ordinal| selector.principal(ordinal))
        .collect::<Vec<_>>();
    assert_eq!(
        principals.iter().filter(|name| *name == "noisy").count(),
        80
    );
    for quiet in 1..=4 {
        assert!(
            principals
                .iter()
                .any(|name| name == &format!("quiet-{quiet}"))
        );
    }
}
