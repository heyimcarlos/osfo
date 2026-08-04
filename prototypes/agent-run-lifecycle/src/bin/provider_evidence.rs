use std::{collections::BTreeMap, fs, path::PathBuf, time::Instant};

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::{
    evidence::{CorrectnessCheck, EvidenceBundle, ScenarioEvidence, summarize_milliseconds},
    rig_lane::{DEFAULT_OPENROUTER_MODEL, RigLiveProvider, run_rig_live_conformance},
};
use sha2::{Digest, Sha256};

fn classify_provider_error(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("401")
        || error.contains("invalid_api_key")
        || error.contains("incorrect api key")
    {
        "authentication: provider rejected the configured API key"
    } else if error.contains("insufficient_quota") {
        "quota: provider reported insufficient API quota"
    } else if error.contains("429") || error.contains("rate_limit") {
        "rate-limit: provider rejected the request at the current request rate"
    } else {
        "provider request failed; raw provider error intentionally omitted"
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let output = std::env::var("OSFO_EVIDENCE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("evidence/provider-focused-latest"));
    let provider = RigLiveProvider::OpenRouter;
    let model =
        std::env::var("OSFO_OPENROUTER_MODEL").unwrap_or_else(|_| DEFAULT_OPENROUTER_MODEL.into());
    let started = Instant::now();
    let attempt = run_rig_live_conformance(provider, &model).await;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let (provider, report_model, rig_version, output_hash, passed, failure) = match attempt {
        Ok(report) => {
            let passed = report.output == "OSFO_PROVIDER_OK" && !report.checkpoint_is_authority;
            let failure =
                (!passed).then(|| "provider returned an unexpected conformance token".into());
            (
                report.provider,
                report.model,
                report.rig_version,
                format!("{:x}", Sha256::digest(report.output.as_bytes())),
                passed,
                failure,
            )
        }
        Err(error) => (
            provider.provider_name().into(),
            model.clone(),
            "0.41.0".into(),
            "not-produced".into(),
            false,
            Some(classify_provider_error(&error.to_string()).into()),
        ),
    };
    let scenario = ScenarioEvidence {
        name: "rig-openrouter-live-conformance".into(),
        started_at_unix_milliseconds: 0,
        ended_at_unix_milliseconds: 0,
        workload: "one bounded Rig request through the OpenRouter Chat Completions API".into(),
        persistence_profile: "provider conformance only; PostgreSQL remains authoritative".into(),
        offered: 1,
        accepted: 1,
        completed: u64::from(passed),
        shed: 0,
        traffic: osfo_agent_run_lifecycle_prototype::confirmation::TrafficAccounting {
            offered: 1,
            received: 1,
            caller_drop: 0,
            accepted: 1,
            shed_or_rejected: 0,
            completed: u64::from(passed),
            failed: u64::from(!passed),
            canceled: 0,
            still_in_flight: 0,
        },
        errors: failure.iter().cloned().collect(),
        elapsed_seconds: elapsed_ms / 1_000.0,
        drain_seconds: 0.0,
        offered_per_second: 1_000.0 / elapsed_ms,
        completed_per_second: f64::from(passed) * 1_000.0 / elapsed_ms,
        metrics: BTreeMap::from([(
            "model_provider_round_trip".into(),
            summarize_milliseconds(vec![elapsed_ms]),
        )]),
        samples: Vec::new(),
        raw_latency_file: None,
        raw_latency_sha256: None,
        raw_latency_rows: 0,
    };
    let bundle = EvidenceBundle {
        schema_version: 3,
        generated_at: "runtime".into(),
        question: "Does Rig 0.41.0 complete one real typed OpenRouter provider request without becoming lifecycle authority?".into(),
        environment: BTreeMap::from([
            ("provider".into(), provider),
            ("model".into(), report_model),
            ("rig-agent".into(), rig_version),
            ("response-sha256".into(), output_hash),
        ]),
        scenarios: vec![scenario],
        correctness: vec![CorrectnessCheck {
            name: "Rig live provider conformance".into(),
            passed,
            evidence: failure.unwrap_or_else(|| "one real provider response matched the pinned conformance token; no provider response was treated as authoritative lifecycle state".into()),
        }],
        failure_matrix: Vec::new(),
        notes: vec!["Focused conformance lane only. It is not a load result and does not establish model-provider availability guarantees.".into()],
        confirmation_verdict: None,
    };
    fs::create_dir_all(&output)?;
    fs::write(
        output.join("results.json"),
        serde_json::to_vec_pretty(&bundle)?,
    )?;
    fs::write(
        output.join("dashboard.html"),
        osfo_agent_run_lifecycle_prototype::evidence::render_dashboard(&bundle)?,
    )?;
    let manifest = ["results.json", "dashboard.html"]
        .into_iter()
        .map(|name| {
            Ok(format!(
                "{:x}  {name}\n",
                Sha256::digest(&fs::read(output.join(name))?)
            ))
        })
        .collect::<Result<String>>()
        .context("build provider evidence checksums")?;
    fs::write(output.join("REPORT_SHA256SUMS"), manifest)?;
    if !passed {
        anyhow::bail!("Rig live provider conformance failed");
    }
    println!("evidence={}", output.join("dashboard.html").display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::classify_provider_error;

    #[test]
    fn provider_error_evidence_keeps_authentication_class_without_key_material() {
        let classified = classify_provider_error(
            "401 invalid_api_key Incorrect API key provided: sensitive-value",
        );

        assert_eq!(
            classified,
            "authentication: provider rejected the configured API key"
        );
        assert!(!classified.contains("sensitive-value"));
    }
}
