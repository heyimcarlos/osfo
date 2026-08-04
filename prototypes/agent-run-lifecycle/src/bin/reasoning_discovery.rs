use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::{
    evidence::{MetricSummary, summarize_milliseconds},
    reasoning_lane::{
        AGENT_DECISION_PREAMBLE, AgentDecision, DISCOVERY_PROMPT_VERSION, DiscoverySummary,
        REASONING_EFFORT, run_live_agent_decision, synthetic_discovery_corpus,
    },
    rig_lane::DEFAULT_OPENROUTER_MODEL,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

const OPENROUTER_INPUT_DOLLARS_PER_TOKEN: f64 = 0.000_000_1;
const OPENROUTER_OUTPUT_DOLLARS_PER_TOKEN: f64 = 0.000_000_6;

#[derive(Debug, Serialize)]
struct DiscoverySample {
    case_label: String,
    repetition: u64,
    message_sha256: String,
    decision: AgentDecision,
    provider_calls: u64,
    validation_retries: u64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    latency_milliseconds: f64,
}

#[derive(Debug, Serialize)]
struct UsageSummary {
    successful_decisions: u64,
    provider_calls: u64,
    validation_retries: u64,
    failed_provider_calls: u64,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    provider_cost_dollars: f64,
    cost_per_message_dollars: f64,
    latency: MetricSummary,
}

#[derive(Debug, Serialize)]
struct DiscoveryResult {
    schema_version: u32,
    generated_at_unix_milliseconds: u64,
    question: String,
    provider: String,
    model: String,
    reasoning_effort: String,
    repetitions: u64,
    prompt_version: String,
    prompt_sha256: String,
    tool_schema_sha256: String,
    corpus_sha256: String,
    pricing: BTreeMap<String, f64>,
    samples: Vec<DiscoverySample>,
    amplification: DiscoverySummary,
    usage: UsageSummary,
    correctness_passed: bool,
    errors: Vec<String>,
    limitations: Vec<String>,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let output = std::env::var("OSFO_DISCOVERY_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("evidence/reasoning-discovery-latest"));
    let model =
        std::env::var("OSFO_OPENROUTER_MODEL").unwrap_or_else(|_| DEFAULT_OPENROUTER_MODEL.into());
    let repetitions = std::env::var("OSFO_DISCOVERY_REPETITIONS")
        .unwrap_or_else(|_| "3".into())
        .parse::<u64>()
        .context("OSFO_DISCOVERY_REPETITIONS must be a positive integer")?;
    if repetitions == 0 {
        anyhow::bail!("OSFO_DISCOVERY_REPETITIONS must be positive");
    }

    let corpus = synthetic_discovery_corpus();
    let mut samples = Vec::with_capacity(corpus.len() * repetitions as usize);
    let mut errors = Vec::new();
    let mut failed_provider_calls = 0_u64;
    for repetition in 1..=repetitions {
        for case in &corpus {
            match run_live_agent_decision(Some(&model), case.message).await {
                Ok(report) => samples.push(DiscoverySample {
                    case_label: case.label.into(),
                    repetition,
                    message_sha256: sha256(case.message.as_bytes()),
                    decision: report.decision,
                    provider_calls: report.provider_calls,
                    validation_retries: report.validation_retries,
                    input_tokens: report.input_tokens,
                    output_tokens: report.output_tokens,
                    reasoning_tokens: report.reasoning_tokens,
                    total_tokens: report.total_tokens,
                    latency_milliseconds: report.latency_milliseconds,
                }),
                Err(error) => {
                    failed_provider_calls += 1;
                    errors.push(format!(
                        "{} repetition {}: {}",
                        case.label,
                        repetition,
                        sanitize_provider_error(&error.to_string())
                    ));
                }
            }
        }
    }

    let decisions = samples
        .iter()
        .map(|sample| sample.decision)
        .collect::<Vec<_>>();
    let amplification = DiscoverySummary::from_decisions(&decisions)?;
    let input_tokens = samples
        .iter()
        .map(|sample| sample.input_tokens)
        .sum::<u64>();
    let output_tokens = samples
        .iter()
        .map(|sample| sample.output_tokens)
        .sum::<u64>();
    let reasoning_tokens = samples
        .iter()
        .map(|sample| sample.reasoning_tokens)
        .sum::<u64>();
    let total_tokens = samples
        .iter()
        .map(|sample| sample.total_tokens)
        .sum::<u64>();
    let provider_cost_dollars = input_tokens as f64 * OPENROUTER_INPUT_DOLLARS_PER_TOKEN
        + output_tokens as f64 * OPENROUTER_OUTPUT_DOLLARS_PER_TOKEN;
    let expected = corpus.len() as u64 * repetitions;
    let correctness_passed = samples.len() as u64 == expected && errors.is_empty();
    let corpus_manifest = corpus
        .iter()
        .map(|case| format!("{}:{}", case.label, sha256(case.message.as_bytes())))
        .collect::<Vec<_>>()
        .join("\n");
    let tool_schema = serde_json::to_vec(&schemars::schema_for!(AgentDecision))?;
    let result = DiscoveryResult {
        schema_version: 1,
        generated_at_unix_milliseconds: unix_milliseconds(),
        question: "What work amplification does real agent reasoning create per incoming message?".into(),
        provider: "OpenRouter Chat Completions API through Rig 0.41.0".into(),
        model: model.clone(),
        reasoning_effort: REASONING_EFFORT.into(),
        repetitions,
        prompt_version: DISCOVERY_PROMPT_VERSION.into(),
        prompt_sha256: sha256(AGENT_DECISION_PREAMBLE.as_bytes()),
        tool_schema_sha256: sha256(&tool_schema),
        corpus_sha256: sha256(corpus_manifest.as_bytes()),
        pricing: BTreeMap::from([
            ("input_dollars_per_token".into(), OPENROUTER_INPUT_DOLLARS_PER_TOKEN),
            ("output_dollars_per_token".into(), OPENROUTER_OUTPUT_DOLLARS_PER_TOKEN),
        ]),
        usage: UsageSummary {
            successful_decisions: samples.len() as u64,
            provider_calls: samples.iter().map(|sample| sample.provider_calls).sum(),
            validation_retries: samples
                .iter()
                .map(|sample| sample.validation_retries)
                .sum(),
            failed_provider_calls,
            input_tokens,
            output_tokens,
            reasoning_tokens,
            total_tokens,
            provider_cost_dollars,
            cost_per_message_dollars: if samples.is_empty() {
                0.0
            } else {
                provider_cost_dollars / samples.len() as f64
            },
            latency: summarize_milliseconds(
                samples
                    .iter()
                    .map(|sample| sample.latency_milliseconds)
                    .collect(),
            ),
        },
        samples,
        amplification,
        correctness_passed,
        errors,
        limitations: vec![
            "This is a live root-agent planning distribution over a synthetic corpus, not future production truth.".into(),
            "The deterministic load lane must replay the observed distribution. It must not call a hosted model at infrastructure saturation rates.".into(),
            "Provider cost counts input and output tokens reported by Rig. Reasoning tokens are already included in output billing and are not charged twice.".into(),
        ],
    };

    fs::create_dir_all(&output)?;
    let results = serde_json::to_vec_pretty(&result)?;
    fs::write(output.join("results.json"), &results)?;
    fs::write(output.join("dashboard.html"), render_dashboard(&result)?)?;
    let manifest = ["results.json", "dashboard.html"]
        .into_iter()
        .map(|name| {
            Ok(format!(
                "{}  {name}\n",
                sha256(&fs::read(output.join(name))?)
            ))
        })
        .collect::<Result<String>>()?;
    fs::write(output.join("SHA256SUMS"), manifest)?;
    println!("evidence={}", output.join("dashboard.html").display());
    if !correctness_passed {
        anyhow::bail!("live reasoning discovery correctness gate failed");
    }
    Ok(())
}

fn render_dashboard(result: &DiscoveryResult) -> Result<String> {
    let data = serde_json::to_string(result)?.replace("</", "<\\/");
    Ok(format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Osfo live reasoning discovery</title><style>
body{{font:14px/1.45 ui-sans-serif,system-ui;background:#07111f;color:#dce8f7;margin:0}}main{{max-width:1450px;margin:auto;padding:28px}}h1{{font-size:28px;margin:0 0 4px}}h2{{margin-top:28px}}.sub{{color:#8ea5bd}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:20px 0}}.card{{background:#0d1b2d;border:1px solid #1e3852;border-radius:10px;padding:14px}}.value{{font-size:25px;font-weight:700;color:#82e6bd}}.pass{{color:#82e6bd}}.fail{{color:#ff8e8e}}table{{width:100%;border-collapse:collapse;background:#0d1b2d}}th,td{{padding:8px;border-bottom:1px solid #1e3852;text-align:right}}th:first-child,td:first-child{{text-align:left}}code{{color:#9bd8ff}}.note{{background:#0d1b2d;border-left:4px solid #f6c85f;padding:12px;margin:8px 0}}
</style></head><body><main><h1>Osfo live agent reasoning discovery</h1><div class="sub" id="meta"></div><div class="grid" id="cards"></div><h2>Measured work graph per synthetic message</h2><table><thead><tr><th>Case</th><th>Rep</th><th>Quick</th><th>Child runs</th><th>Temporal workflows</th><th>Activities</th><th>Tools</th><th>Approvals</th><th>Tokens</th><th>Reasoning</th><th>Latency ms</th></tr></thead><tbody id="rows"></tbody></table><h2>Interpretation</h2><div id="notes"></div></main><script>const d={data};
const a=d.amplification,u=d.usage;document.getElementById('meta').innerHTML=`<code>${{d.model}}</code>, reasoning ${{d.reasoning_effort}}, ${{d.samples.length}} decisions, verdict <b class="${{d.correctness_passed?'pass':'fail'}}">${{d.correctness_passed?'PASS':'FAIL'}}</b>`;
const cards=[['Messages',a.messages],['Quick replies',a.quick_replies],['AgentRuns / message',a.total_agent_runs_per_message.toFixed(3)],['Child AgentRuns',a.child_agent_runs],['Temporal workflows / message',a.temporal_workflows_per_message.toFixed(3)],['Temporal activities',a.temporal_activities],['Tool calls',a.tool_calls],['Approvals',a.approvals],['Provider calls',u.provider_calls],['Validation retries',u.validation_retries],['Tokens',u.total_tokens.toLocaleString()],['Reasoning tokens',u.reasoning_tokens.toLocaleString()],['Provider cost','$'+u.provider_cost_dollars.toFixed(6)],['Latency p95',u.latency.p95_ms.toFixed(1)+' ms'],['Latency p99',u.latency.p99_ms.toFixed(1)+' ms']];document.getElementById('cards').innerHTML=cards.map(([k,v])=>`<div class="card"><div class="sub">${{k}}</div><div class="value">${{v}}</div></div>`).join('');
document.getElementById('rows').innerHTML=d.samples.map(s=>`<tr><td>${{s.case_label}}</td><td>${{s.repetition}}</td><td>${{s.decision.quick_reply?'yes':'no'}}</td><td>${{s.decision.child_agent_runs}}</td><td>${{s.decision.temporal_workflows}}</td><td>${{s.decision.temporal_activities}}</td><td>${{s.decision.tool_calls}}</td><td>${{s.decision.approvals}}</td><td>${{s.total_tokens}}</td><td>${{s.reasoning_tokens}}</td><td>${{s.latency_milliseconds.toFixed(1)}}</td></tr>`).join('');document.getElementById('notes').innerHTML=d.limitations.map(n=>`<div class="note">${{n}}</div>`).join('');</script></body></html>"#
    ))
}

fn sanitize_provider_error(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("401") || error.contains("api key") {
        "authentication failure"
    } else if error.contains("429") || error.contains("rate") {
        "provider rate limit"
    } else if error.contains("timeout") {
        "provider timeout"
    } else if error.contains("extract") || error.contains("deserialize") {
        "typed decision extraction failure"
    } else {
        "provider request failure"
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn unix_milliseconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
