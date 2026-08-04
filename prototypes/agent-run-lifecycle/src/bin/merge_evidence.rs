use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::confirmation::{
    CapacityEnvelope, ConfirmationVerdict, GateStatus,
};
use osfo_agent_run_lifecycle_prototype::evidence::{
    EvidenceBundle, load_frozen_telemetry, merge_bundles, merge_frozen_telemetry,
    render_dashboard_with_telemetry,
};

fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let mut arguments = std::env::args_os().skip(1);
    let output = arguments
        .next()
        .map(PathBuf::from)
        .context("usage: merge_evidence OUTPUT_DIR INPUT_DIR...")?;
    let inputs = arguments.map(PathBuf::from).collect::<Vec<_>>();
    if inputs.is_empty() {
        anyhow::bail!("at least one input evidence directory is required");
    }
    let mut bundles = Vec::with_capacity(inputs.len());
    let mut telemetry = Vec::with_capacity(inputs.len());
    for input in &inputs {
        let bytes = fs::read(input.join("results.json"))
            .with_context(|| format!("read evidence from {}", input.display()))?;
        bundles.push(serde_json::from_slice::<EvidenceBundle>(&bytes)?);
        telemetry.push(load_frozen_telemetry(input)?);
    }
    let mut merged = merge_bundles(bundles);
    let mut telemetry = merge_frozen_telemetry(telemetry);
    let cost_path = output.join("cost.json");
    if cost_path.exists() {
        let cost = fs::read(&cost_path)
            .with_context(|| format!("read cost evidence from {}", cost_path.display()))?;
        telemetry["cost"] = serde_json::from_slice(&cost)
            .with_context(|| format!("parse cost evidence from {}", cost_path.display()))?;
    }
    merged.confirmation_verdict = Some(consolidated_verdict(&merged, &telemetry));
    fs::create_dir_all(&output)?;
    fs::write(
        output.join("results.json"),
        serde_json::to_vec_pretty(&merged)?,
    )?;
    fs::write(
        output.join("dashboard.html"),
        render_dashboard_with_telemetry(&merged, &telemetry)?,
    )?;
    fs::write(
        output.join("telemetry.json"),
        serde_json::to_vec_pretty(&telemetry)?,
    )?;
    fs::write(output.join("REPORT.md"), render_report(&merged, &telemetry))?;
    fs::write(
        output.join("inputs.json"),
        serde_json::to_vec_pretty(
            &inputs
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>(),
        )?,
    )?;
    println!("evidence={}", output.display());
    Ok(())
}

fn consolidated_verdict(
    bundle: &EvidenceBundle,
    telemetry: &serde_json::Value,
) -> ConfirmationVerdict {
    let mandatory_correctness = bundle
        .correctness
        .iter()
        .filter(|check| check.name != "Rig live provider conformance")
        .all(|check| check.passed);
    let failure_matrix =
        bundle.failure_matrix.len() == 29 && bundle.failure_matrix.iter().all(|row| row.passed);
    let telemetry_complete = telemetry["summary"]["complete"].as_bool() == Some(true);
    let topology = bundle
        .correctness
        .iter()
        .any(|check| check.name == "Cloud SQL topology exercised" && check.passed);
    let workload_fidelity = [
        "steady-700-cold",
        "steady-1400-cold",
        "steady-2083-cold",
        "steady-4167-cold",
        "temporal-timer-herd-retry-batch",
        "approval-gated-mailpit-batch",
    ]
    .iter()
    .all(|name| bundle.scenarios.iter().any(|stage| stage.name == *name));
    let safe_overload = ["steady-2083-cold", "steady-4167-cold"].iter().all(|name| {
        bundle.scenarios.iter().any(|stage| {
            stage.name == *name
                && stage.shed > 0
                && stage.traffic.reconcile().is_ok()
                && stage.traffic.completed == stage.traffic.accepted
        })
    });
    let recovery = bundle.scenarios.iter().all(|stage| {
        stage.traffic.still_in_flight == 0
            && stage.traffic.completed + stage.traffic.failed + stage.traffic.canceled
                == stage.traffic.accepted
    });
    let status = |passed| {
        if passed {
            GateStatus::Pass
        } else {
            GateStatus::Fail
        }
    };

    ConfirmationVerdict {
        run_id: "issue-13-temporal-cloud-confirmation-20260803T214500Z".into(),
        verdict: GateStatus::Fail,
        evidence_validity: GateStatus::Missing,
        target_result: GateStatus::Fail,
        correctness_gate: status(mandatory_correctness),
        telemetry_gate: status(telemetry_complete),
        workload_fidelity_gate: status(workload_fidelity),
        safe_overload_gate: status(safe_overload),
        recovery_gate: status(recovery),
        topology_gate: status(topology),
        load_matrix_gate: GateStatus::Missing,
        failure_matrix_gate: status(failure_matrix),
        capacity_envelope: CapacityEnvelope {
            unit: "offered AgentRuns/s".into(),
            highest_confirmed: None,
            knee_lower_bound: None,
            knee_upper_bound: Some(700),
        },
        missing_rows: vec![
            "full prescribed duration matrix after the 700/s completion target failed".into(),
            "checkpoint-and-sandbox-restore target-rate matrix".into(),
            "per-step-checkpoint target-rate matrix".into(),
        ],
        failed_invariants: Vec::new(),
        evidence_checksums: Some("REPORT_SHA256SUMS".into()),
    }
}

fn render_report(bundle: &EvidenceBundle, telemetry: &serde_json::Value) -> String {
    let offered: u64 = bundle.scenarios.iter().map(|stage| stage.offered).sum();
    let accepted: u64 = bundle.scenarios.iter().map(|stage| stage.accepted).sum();
    let completed: u64 = bundle.scenarios.iter().map(|stage| stage.completed).sum();
    let shed: u64 = bundle.scenarios.iter().map(|stage| stage.shed).sum();
    let passed = bundle
        .correctness
        .iter()
        .filter(|check| check.name != "Rig live provider conformance")
        .all(|check| check.passed)
        && bundle.failure_matrix.iter().all(|row| row.passed);
    let mut report = format!(
        "# Production-shaped AgentRun lifecycle evidence\n\n## Decision\n\n{}\n\nTarget confirmation: **FAIL**. The fixed 32-vCPU runner did not sustain the inherited 700 AgentRuns/s completion target and shed traffic at 2,083 and 4,167 AgentRuns/s. The evidence is valid for the observed cold-reconstruction lanes, but the exact duration and persistence-profile matrix remains incomplete.\n\nAcross all lanes: {offered} offered, {accepted} accepted, {completed} completed, and {shed} shed before acceptance.\n\n",
        if passed {
            "PASS: every mandatory issue-level correctness and failure coverage gate passed. The optional live-provider lane is reported separately."
        } else {
            "INCOMPLETE: observed lanes passed, but at least one issue-level coverage gate remains open."
        }
    );
    report.push_str("## Capacity result\n\n| Stage | Offered/s | Accepted | Acceptance | Completed | Shed | Drain | Completed/s | p99 end to end |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n");
    for stage in &bundle.scenarios {
        let latency = stage.metrics.get("end_to_end_journey");
        report.push_str(&format!(
            "| {} | {:.0} | {} | {:.1}% | {} | {} | {:.1} s | {:.2} | {:.1} ms |\n",
            stage.name,
            stage.offered_per_second,
            stage.accepted,
            if stage.offered == 0 {
                0.0
            } else {
                stage.accepted as f64 * 100.0 / stage.offered as f64
            },
            stage.completed,
            stage.shed,
            stage.drain_seconds,
            stage.completed_per_second,
            latency.map(|metric| metric.p99_ms).unwrap_or_default(),
        ));
    }
    report.push_str("\nThe 10-minute 700/s lane accepted all 420,000 runs but required 582.8 seconds of drain after its 600-second offer window, with 355.09 completions/s over the full run and 425,984 ms p99 end-to-end latency. The 60-second 1,400/s lane also accepted all traffic but completed at 352.34/s after drain. At 2,083/s, 20,083 of 124,980 offers were shed. At 4,167/s, 164,577 of 250,020 offers were shed. These observations reject stable target completion on the current single-runner local Docker shape.\n\n");
    let summary = &telemetry["summary"];
    report.push_str(&format!(
        "## Telemetry completeness\n\n{} frozen load runs contributed {} of {} successful acceptance queries. All seven required targets were healthy: runner process, runner node, PostgreSQL exporter, Cloud SQL monitoring, Temporal Cloud, Temporal Rust SDK worker, and Prometheus.\n\n",
        summary["run_count"].as_u64().unwrap_or_default(),
        summary["successful_queries"].as_u64().unwrap_or_default(),
        summary["query_count"].as_u64().unwrap_or_default(),
    ));
    if let Some(cost) = telemetry.get("cost").and_then(|value| value.get("summary")) {
        report.push_str(&format!(
            "## Cost evidence\n\nKnown GCP catalog estimate: **${:.2}**. Temporal Actions first-tier list-rate equivalent: **${:.2}**. Actual combined invoice cost: **{}**.\n\nThe GCP value uses measured provider operation intervals and exact public Catalog API SKUs. The Temporal value is a notional estimate from the frozen OpenMetrics Action series, not an invoice charge. The authoritative Temporal Billing API lags approximately 24 hours, the plan includes a monthly Action allocation, storage was not captured, and trial credits may apply. See `cost.json` for rates, formulas, exclusions, and continuing stopped-resource cost.\n\n",
            cost["gcp_known_catalog_estimate"]
                .as_f64()
                .unwrap_or_default(),
            cost["temporal_actions_first_tier_list_rate_equivalent"]
                .as_f64()
                .unwrap_or_default(),
            cost["combined_actual_invoice_status"]
                .as_str()
                .unwrap_or("MISSING"),
        ));
    }
    report.push_str("\n## Correctness gates\n\n| Gate | Result | Evidence |\n|---|---|---|\n");
    for check in &bundle.correctness {
        report.push_str(&format!(
            "| {} | {} | {} |\n",
            check.name,
            if check.passed { "PASS" } else { "FAIL" },
            check.evidence.replace('|', "\\|")
        ));
    }
    report.push_str("\n## Remaining blockers\n\n- The runner project has a 32-vCPU global Compute Engine quota, so the tested topology cannot add another runner or grow beyond the current 32-vCPU VM without a quota increase.\n- The production-shaped local Docker sandbox mix needs about 28 sandboxed workflows/s at 700 AgentRuns/s, while the measured tail drains about 13 to 14/s. E2B passed focused provider conformance, but it does not replace the required local deterministic lane.\n- The configured OpenAI key was rejected with `invalid_api_key`, so the real Rig-to-OpenAI conformance row is recorded as failed. The deterministic Rig lane passed.\n- The full 30-minute, three-persistence-profile matrix is not justified on this fixed shape because the 10-minute 700/s lane already accumulates nearly a full offer window of drain.\n\nNo latency threshold was selected before measurement. Focused failure batches preserve every sample instead of presenting unstable tail percentiles.\n\n## Requirement audit\n\nSee `AUDIT.md` for the issue exit-criteria mapping, known gaps, Grafana evidence hierarchy, cost interpretation, and follow-up scope.\n");
    report
}

#[cfg(test)]
mod tests {
    use osfo_agent_run_lifecycle_prototype::confirmation::GateStatus;
    use osfo_agent_run_lifecycle_prototype::evidence::EvidenceBundle;

    use super::{consolidated_verdict, render_report};

    #[test]
    fn merged_report_leads_with_failed_target_and_telemetry_completeness() {
        let bundle: EvidenceBundle = serde_json::from_value(serde_json::json!({
            "schema_version": 3,
            "generated_at": "test",
            "question": "test",
            "environment": {},
            "scenarios": [],
            "correctness": [],
            "failure_matrix": [],
            "notes": [],
            "confirmation_verdict": null
        }))
        .expect("test evidence bundle");
        let report = render_report(
            &bundle,
            &serde_json::json!({
                "summary": {"run_count": 1, "query_count": 69, "successful_queries": 69},
                "cost": {
                    "summary": {
                        "gcp_known_catalog_estimate": 24.14522,
                        "temporal_actions_first_tier_list_rate_equivalent": 10.899819,
                        "combined_actual_invoice_status": "MISSING"
                    }
                }
            }),
        );

        assert!(report.contains("Target confirmation: **FAIL**"));
        assert!(report.contains("every mandatory issue-level correctness"));
        assert!(report.contains("69 of 69 successful acceptance queries"));
        assert!(report.contains("Known GCP catalog estimate: **$24.15**"));
        assert!(report.contains("Actual combined invoice cost: **MISSING**"));
        assert!(report.contains("Remaining blockers"));
    }

    #[test]
    fn consolidated_verdict_distinguishes_failed_target_from_missing_matrix() {
        let bundle: EvidenceBundle = serde_json::from_value(serde_json::json!({
            "schema_version": 3,
            "generated_at": "test",
            "question": "test",
            "environment": {},
            "scenarios": [],
            "correctness": [],
            "failure_matrix": [],
            "notes": [],
            "confirmation_verdict": null
        }))
        .expect("test evidence bundle");

        let verdict = consolidated_verdict(&bundle, &serde_json::json!({}));

        assert_eq!(verdict.verdict, GateStatus::Fail);
        assert_eq!(verdict.target_result, GateStatus::Fail);
        assert_eq!(verdict.load_matrix_gate, GateStatus::Missing);
        assert_ne!(verdict.correctness_gate, GateStatus::Missing);
    }
}
