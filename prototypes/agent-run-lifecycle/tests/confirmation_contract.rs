use osfo_agent_run_lifecycle_prototype::confirmation::{
    ConfirmationManifest, ConfirmationObservations, ConfirmationVerdict, GateStatus,
    REQUIRED_FAILURE_INJECTIONS, TrafficAccounting,
};
use osfo_agent_run_lifecycle_prototype::load::{
    ArrivalDisposition, LinearRampSchedule, OpenLoopSchedule,
};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use std::{fs, path::PathBuf};

fn valid_manifest() -> String {
    let profiles = [
        "cold-logical-reconstruction",
        "checkpoint-and-sandbox-restore",
        "per-step-checkpoint",
    ];
    let mut stages = Vec::new();
    for profile in profiles {
        for rate in [700, 1_400, 2_083, 4_167] {
            stages.push(serde_json::json!({
                "name": format!("steady-{rate}-{profile}"),
                "phase": "steady",
                "arrival_pattern": "open-loop-uniform",
                "workload_lane": "production-shaped-deterministic",
                "offered_agent_runs_per_second": rate,
                "duration_seconds": 1_800,
                "persistence_profile": profile
            }));
        }
    }
    for phase in [
        "ramp",
        "impulse",
        "mixed-journeys",
        "child-fanout",
        "approval-batch",
        "timer-herd",
        "retry-storm",
        "failure-under-load",
        "post-knee",
        "recovery",
    ] {
        stages.push(serde_json::json!({
            "name": phase,
            "phase": phase,
            "arrival_pattern": if phase == "impulse" { "open-loop-impulse" } else { "open-loop-uniform" },
            "workload_lane": "production-shaped-deterministic",
            "offered_agent_runs_per_second": 1_400,
            "duration_seconds": 600,
            "persistence_profile": "cold-logical-reconstruction"
        }));
    }
    let failure_plan = REQUIRED_FAILURE_INJECTIONS
        .iter()
        .map(|injection| {
            serde_json::json!({
                "injection": injection,
                "stage": "failure-under-load",
                "offered_agent_runs_per_second": 1400
            })
        })
        .collect::<Vec<_>>();

    serde_json::json!({
        "schema_version": 3,
        "run_id": "issue-13-confirmation-test",
        "seed": 130013,
        "question": "Does the production-shaped AgentRun lifecycle meet the issue 13 target?",
        "topology": {
            "same_region_compute_and_cloud_sql": true,
            "cloud_sql_is_agent_run_authority": true,
            "temporal_persistence_isolated": true,
            "fixed_temporal_worker_fleet": true
        },
        "worker_fleet": {
            "generator_instances": 1,
            "lifecycle_workers": 64,
            "admission_workers": 8,
            "execution_workers": 56,
            "execution_lane_workers": {
                "basic": 24,
                "child": 8,
                "temporal": 16,
                "sandbox": 4,
                "smtp": 4
            },
            "database_pool_size": 64,
            "temporal_worker_processes": 2,
            "temporal_gateway_concurrency": 16,
            "temporal_workflow_slots_per_process": 100,
            "temporal_activity_slots_per_process": 100,
            "maximum_admission_queue_depth": 4096,
            "maximum_arrival_lag_milliseconds": 250
        },
        "principal_mix": {
            "noisy_percent": 80,
            "quiet_principal_count": 4
        },
        "required_offered_agent_runs_per_second": [700, 1400, 2083, 4167],
        "required_persistence_profiles": profiles,
        "journey_mix": {
            "basic_agent_run_percent": 90,
            "child_fanout_percent": 4,
            "awaited_workflow_percent": 2,
            "detached_workflow_percent": 1,
            "sandbox_artifact_percent": 1,
            "approval_smtp_percent": 1,
            "full_reference_journey_percent": 1
        },
        "stages": stages,
        "failure_plan": failure_plan
    })
    .to_string()
}

#[test]
fn issue_13_manifest_accepts_only_the_complete_production_shaped_matrix() {
    let manifest = ConfirmationManifest::from_json(&valid_manifest()).unwrap();

    assert_eq!(
        manifest.required_offered_agent_runs_per_second,
        vec![700, 1_400, 2_083, 4_167]
    );
    assert_eq!(manifest.steady_target_stages().count(), 12);
    assert_eq!(manifest.worker_fleet.lifecycle_workers, 64);
    assert_eq!(manifest.worker_fleet.admission_workers, 8);
    assert_eq!(manifest.worker_fleet.execution_workers, 56);
    assert_eq!(manifest.worker_fleet.execution_lane_workers.temporal, 16);
    assert_eq!(manifest.worker_fleet.temporal_gateway_concurrency, 16);
    assert_eq!(manifest.principal_mix.quiet_principal_count, 4);
}

#[test]
fn checked_in_issue_13_confirmation_manifest_is_complete() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("config/issue-13-confirmation.json");
    let manifest = ConfirmationManifest::from_json(&fs::read_to_string(path).unwrap()).unwrap();

    assert_eq!(manifest.steady_target_stages().count(), 12);
    assert_eq!(
        manifest.failure_plan.len(),
        REQUIRED_FAILURE_INJECTIONS.len()
    );
    assert!(manifest.stages.iter().any(|stage| {
        stage.phase == osfo_agent_run_lifecycle_prototype::confirmation::StagePhase::PostKnee
            && stage.offered_agent_runs_per_second > 4_167
    }));
}

#[test]
fn issue_13_manifest_rejects_an_unbounded_or_elastic_worker_fleet() {
    let mut value: serde_json::Value = serde_json::from_str(&valid_manifest()).unwrap();
    value["worker_fleet"]["maximum_admission_queue_depth"] = serde_json::json!(0);

    let error = ConfirmationManifest::from_json(&value.to_string()).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("fixed worker fleet values must be positive")
    );
}

#[test]
fn issue_13_manifest_rejects_a_worker_split_that_does_not_match_the_fixed_fleet() {
    let mut value: serde_json::Value = serde_json::from_str(&valid_manifest()).unwrap();
    value["worker_fleet"]["execution_workers"] = serde_json::json!(55);

    let error = ConfirmationManifest::from_json(&value.to_string()).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("admission and execution worker split")
    );
}

#[test]
fn issue_13_manifest_rejects_execution_lane_workers_that_do_not_match_the_split() {
    let mut value: serde_json::Value = serde_json::from_str(&valid_manifest()).unwrap();
    value["worker_fleet"]["execution_lane_workers"]["temporal"] = serde_json::json!(15);

    let error = ConfirmationManifest::from_json(&value.to_string()).unwrap_err();

    assert!(error.to_string().contains("execution lane workers"));
}

#[test]
fn issue_13_manifest_rejects_a_missing_failure_cut() {
    let mut value: serde_json::Value = serde_json::from_str(&valid_manifest()).unwrap();
    value["failure_plan"].as_array_mut().unwrap().pop();

    let error = ConfirmationManifest::from_json(&value.to_string()).unwrap_err();

    assert!(error.to_string().contains("failure plan is missing"));
}

#[test]
fn issue_13_manifest_rejects_a_missing_target_rate() {
    let mut value: serde_json::Value = serde_json::from_str(&valid_manifest()).unwrap();
    value["required_offered_agent_runs_per_second"] = serde_json::json!([700, 1400]);

    let error = ConfirmationManifest::from_json(&value.to_string()).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("required offered rates must include 700, 1400, 2083, and 4167")
    );
}

#[test]
fn issue_13_manifest_rejects_a_metadata_only_target_stage() {
    let mut value: serde_json::Value = serde_json::from_str(&valid_manifest()).unwrap();
    value["stages"][0]["workload_lane"] = serde_json::json!("postgres-metadata-only");

    let error = ConfirmationManifest::from_json(&value.to_string()).unwrap_err();

    assert!(
        error
            .to_string()
            .contains("missing steady production-shaped stage")
    );
}

#[test]
fn traffic_accounting_reconciles_at_the_client_admission_and_terminal_seams() {
    let accounting = TrafficAccounting {
        offered: 1_000,
        received: 990,
        caller_drop: 10,
        accepted: 950,
        shed_or_rejected: 40,
        completed: 940,
        failed: 4,
        canceled: 1,
        still_in_flight: 5,
    };

    accounting.reconcile().unwrap();
}

#[test]
fn traffic_accounting_rejects_unexplained_accepted_work() {
    let accounting = TrafficAccounting {
        offered: 100,
        received: 100,
        caller_drop: 0,
        accepted: 100,
        shed_or_rejected: 0,
        completed: 99,
        failed: 0,
        canceled: 0,
        still_in_flight: 0,
    };

    let error = accounting.reconcile().unwrap_err();

    assert!(
        error
            .to_string()
            .contains("accepted work does not reconcile")
    );
}

#[test]
fn open_loop_schedule_drops_late_arrivals_instead_of_hiding_reduced_demand() {
    let schedule =
        OpenLoopSchedule::new(100.0, Duration::from_secs(1), Duration::from_millis(25)).unwrap();

    assert_eq!(
        schedule.classify(10, Duration::from_millis(120)),
        ArrivalDisposition::Send {
            lag: Duration::from_millis(20)
        }
    );
    assert_eq!(
        schedule.classify(10, Duration::from_millis(130)),
        ArrivalDisposition::CallerDrop {
            lag: Duration::from_millis(30)
        }
    );
    assert_eq!(schedule.offered_count(), 100);
}

#[test]
fn linear_ramp_schedule_preserves_the_integrated_offered_demand() {
    let ramp = LinearRampSchedule::new(
        700.0,
        2_083.0,
        Duration::from_secs(10),
        Duration::from_millis(250),
    )
    .unwrap();

    assert_eq!(ramp.offered_count(), 13_915);
    assert!(ramp.target_offset(1_000) < Duration::from_secs(2));
    assert!(ramp.target_offset(13_914) <= Duration::from_secs(10));
}

#[test]
fn confirmation_verdict_fails_closed_when_a_required_stage_is_missing() {
    let manifest = ConfirmationManifest::from_json(&valid_manifest()).unwrap();
    let observations = ConfirmationObservations {
        run_id: manifest.run_id.clone(),
        observed_stages: BTreeSet::new(),
        traffic_by_stage: BTreeMap::new(),
        failed_invariants: Vec::new(),
        observed_failure_injections: BTreeSet::new(),
        telemetry_complete: Some(true),
        workload_fidelity: Some(true),
        safe_overload: Some(true),
        recovery_complete: Some(true),
        topology_verified: Some(true),
        target_requirements_met: Some(true),
        evidence_checksums: Some("checksums.sha256".into()),
    };

    let verdict = ConfirmationVerdict::evaluate(&manifest, &observations);

    assert_eq!(verdict.verdict, GateStatus::Missing);
    assert_eq!(verdict.load_matrix_gate, GateStatus::Missing);
    assert!(!verdict.missing_rows.is_empty());
}

#[test]
fn confirmation_separates_valid_evidence_from_a_failed_target_hypothesis() {
    let manifest = ConfirmationManifest::from_json(&valid_manifest()).unwrap();
    let observed_stages = manifest
        .stages
        .iter()
        .map(|stage| stage.name.clone())
        .collect::<BTreeSet<_>>();
    let traffic_by_stage = observed_stages
        .iter()
        .map(|stage| {
            (
                stage.clone(),
                TrafficAccounting {
                    offered: 100,
                    received: 100,
                    accepted: 100,
                    completed: 100,
                    ..TrafficAccounting::default()
                },
            )
        })
        .collect();
    let observations = ConfirmationObservations {
        run_id: manifest.run_id.clone(),
        observed_stages,
        traffic_by_stage,
        failed_invariants: Vec::new(),
        observed_failure_injections:
            osfo_agent_run_lifecycle_prototype::confirmation::REQUIRED_FAILURE_INJECTIONS
                .iter()
                .map(|value| (*value).to_owned())
                .collect(),
        telemetry_complete: Some(true),
        workload_fidelity: Some(true),
        safe_overload: Some(true),
        recovery_complete: Some(true),
        topology_verified: Some(true),
        target_requirements_met: Some(false),
        evidence_checksums: Some("checksums.sha256".into()),
    };

    let verdict = ConfirmationVerdict::evaluate(&manifest, &observations);

    assert_eq!(verdict.evidence_validity, GateStatus::Pass);
    assert_eq!(verdict.target_result, GateStatus::Fail);
    assert_eq!(verdict.verdict, GateStatus::Fail);
}

#[test]
fn confirmation_reports_the_conservative_capacity_envelope_across_profiles() {
    let manifest = ConfirmationManifest::from_json(&valid_manifest()).unwrap();
    let observed_stages = manifest
        .stages
        .iter()
        .map(|stage| stage.name.clone())
        .collect::<BTreeSet<_>>();
    let traffic_by_stage = manifest
        .stages
        .iter()
        .map(|stage| {
            let traffic = if stage.phase
                == osfo_agent_run_lifecycle_prototype::confirmation::StagePhase::Steady
                && stage.offered_agent_runs_per_second >= 2_083
            {
                TrafficAccounting {
                    offered: 100,
                    received: 100,
                    accepted: 90,
                    shed_or_rejected: 10,
                    completed: 90,
                    ..TrafficAccounting::default()
                }
            } else {
                TrafficAccounting {
                    offered: 100,
                    received: 100,
                    accepted: 100,
                    completed: 100,
                    ..TrafficAccounting::default()
                }
            };
            (stage.name.clone(), traffic)
        })
        .collect();
    let observations = ConfirmationObservations {
        run_id: manifest.run_id.clone(),
        observed_stages,
        traffic_by_stage,
        failed_invariants: Vec::new(),
        observed_failure_injections: REQUIRED_FAILURE_INJECTIONS
            .iter()
            .map(|value| (*value).to_owned())
            .collect(),
        telemetry_complete: Some(true),
        workload_fidelity: Some(true),
        safe_overload: Some(true),
        recovery_complete: Some(true),
        topology_verified: Some(true),
        target_requirements_met: Some(false),
        evidence_checksums: Some("checksums.sha256".into()),
    };

    let verdict = ConfirmationVerdict::evaluate(&manifest, &observations);

    assert_eq!(verdict.capacity_envelope.highest_confirmed, Some(1_400));
    assert_eq!(verdict.capacity_envelope.knee_lower_bound, Some(1_400));
    assert_eq!(verdict.capacity_envelope.knee_upper_bound, Some(2_083));
}
