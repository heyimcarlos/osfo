use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Serialize)]
struct DashboardBundle {
    schema_version: u32,
    verdict: String,
    note: String,
    requirements: Vec<Requirement>,
    scenarios: Vec<Value>,
    reasoning: Option<Value>,
    temporal: Vec<Value>,
    auxiliary: Vec<Value>,
    cost: Option<Value>,
    telemetry: Vec<TelemetrySummary>,
    source_files: Vec<String>,
}

#[derive(Serialize)]
struct Requirement {
    name: String,
    status: String,
    evidence: String,
}

#[derive(Serialize)]
struct TelemetrySummary {
    scenario: String,
    ingress_instances_max: Option<f64>,
    stream_instances_max: Option<f64>,
    agent_worker_instances_max: Option<f64>,
    ingress_cpu_max: Option<f64>,
    stream_cpu_max: Option<f64>,
    agent_worker_cpu_max: Option<f64>,
    cloud_sql_cpu_max: Option<f64>,
    cloud_sql_memory_max: Option<f64>,
    cloud_sql_backends_max: Option<f64>,
    cloud_sql_backends_waiting_max: Option<f64>,
}

fn main() -> Result<()> {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    let files = std::env::var("OSFO_DEPLOYED_RESULT_FILES")
        .context("OSFO_DEPLOYED_RESULT_FILES is required")?
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if files.is_empty() {
        anyhow::bail!("OSFO_DEPLOYED_RESULT_FILES must contain at least one results.json");
    }
    let output = PathBuf::from(
        std::env::var("OSFO_DEPLOYED_DASHBOARD_OUTPUT")
            .unwrap_or_else(|_| "evidence/deployed-dashboard".into()),
    );
    let mut scenario_sources = files
        .iter()
        .map(|path| {
            Ok((
                path.clone(),
                serde_json::from_slice::<Value>(&fs::read(path)?)
                    .with_context(|| format!("parse {}", path.display()))?,
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    scenario_sources.sort_by_key(|(_, scenario)| {
        scenario["started_at_unix_microseconds"]
            .as_u64()
            .unwrap_or_default()
    });
    let scenarios = scenario_sources
        .iter()
        .map(|(_, scenario)| scenario.clone())
        .collect::<Vec<_>>();
    let reasoning_path = std::env::var("OSFO_REASONING_DISCOVERY_RESULT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let reasoning = reasoning_path
        .as_ref()
        .map(|path| {
            serde_json::from_slice::<Value>(&fs::read(path)?)
                .with_context(|| format!("parse {}", path.display()))
        })
        .transpose()?;
    let temporal_paths = std::env::var("OSFO_TEMPORAL_RESULT_FILES")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    let temporal = temporal_paths
        .iter()
        .map(|path| {
            serde_json::from_slice::<Value>(&fs::read(path)?)
                .with_context(|| format!("parse {}", path.display()))
        })
        .collect::<Result<Vec<_>>>()?;
    let auxiliary_paths = paths_from_environment("OSFO_AUXILIARY_EVIDENCE_FILES");
    let auxiliary = read_values(&auxiliary_paths)?;
    let cost_path = std::env::var("OSFO_COST_RESULT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let cost = cost_path
        .as_ref()
        .map(|path| {
            serde_json::from_slice::<Value>(&fs::read(path)?)
                .with_context(|| format!("parse {}", path.display()))
        })
        .transpose()?;
    let mut requirements = requirements(&scenarios);
    requirements.push(external_requirement(
        "live Luna reasoning discovery",
        reasoning.as_ref(),
        |value| value["correctness_passed"].as_bool() == Some(true),
    ));
    requirements.push(if temporal.is_empty() {
        Requirement {
            name: "actual Temporal Cloud workflow execution".into(),
            status: "MISSING".into(),
            evidence: "no recorded Temporal Cloud load result".into(),
        }
    } else {
        let passed = temporal
            .iter()
            .any(|result| result["correctness_passed"].as_bool() == Some(true));
        Requirement {
            name: "actual Temporal Cloud workflow execution".into(),
            status: if passed { "PASS" } else { "FAIL" }.into(),
            evidence: temporal
                .iter()
                .map(|result| {
                    format!(
                        "{} {} of {} workflows",
                        result["arrival_pattern"].as_str().unwrap_or("unknown"),
                        result["completed"].as_u64().unwrap_or_default(),
                        result["offered"].as_u64().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join(", "),
        }
    });
    requirements.extend(auxiliary_requirements(&auxiliary));
    requirements.push(cost_requirement(cost.as_ref()));
    requirements.push(temporal_capacity_requirement(cost.as_ref()));
    let telemetry = scenario_sources
        .iter()
        .map(|(path, scenario)| telemetry_summary(path, scenario))
        .collect::<Vec<_>>();
    let verdict = if requirements.iter().any(|item| item.status == "FAIL") {
        "FAIL"
    } else if requirements.iter().any(|item| item.status == "MISSING") {
        "MISSING"
    } else {
        "PASS"
    };
    let bundle = DashboardBundle {
        schema_version: 1,
        verdict: verdict.into(),
        note: "Correctness-first Toronto evidence. Live Luna measures work amplification. PostgreSQL terminal time is authoritative for AgentRuns. Temporal Cloud history is authoritative only for workflow execution. SSE time measures client observation.".into(),
        requirements,
        scenarios,
        reasoning,
        temporal,
        auxiliary,
        cost,
        telemetry,
        source_files: files
            .iter()
            .chain(reasoning_path.iter())
            .chain(temporal_paths.iter())
            .chain(auxiliary_paths.iter())
            .chain(cost_path.iter())
            .map(|path| path.display().to_string())
            .collect(),
    };
    fs::create_dir_all(&output)?;
    let results = serde_json::to_vec_pretty(&bundle)?;
    let html = render(&bundle)?;
    fs::write(output.join("results.json"), &results)?;
    fs::write(output.join("dashboard.html"), html.as_bytes())?;
    let checksums = format!(
        "{:x}  results.json\n{:x}  dashboard.html\n",
        Sha256::digest(&results),
        Sha256::digest(html.as_bytes())
    );
    fs::write(output.join("SHA256SUMS"), checksums)?;
    println!("dashboard={}", output.join("dashboard.html").display());
    Ok(())
}

fn paths_from_environment(name: &str) -> Vec<PathBuf> {
    std::env::var(name)
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn read_values(paths: &[PathBuf]) -> Result<Vec<Value>> {
    paths
        .iter()
        .map(|path| {
            serde_json::from_slice::<Value>(&fs::read(path)?)
                .with_context(|| format!("parse {}", path.display()))
        })
        .collect()
}

fn telemetry_summary(result_path: &Path, scenario: &Value) -> TelemetrySummary {
    let metric = |name: &str| {
        result_path
            .parent()
            .and_then(|parent| {
                fs::read(parent.join("cloud-monitoring").join(format!("{name}.json"))).ok()
            })
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .as_ref()
            .and_then(metric_max)
    };
    TelemetrySummary {
        scenario: scenario["scenario"].as_str().unwrap_or("unknown").into(),
        ingress_instances_max: metric("ingress-instance-count"),
        stream_instances_max: metric("stream-instance-count"),
        agent_worker_instances_max: metric("agent-worker-instance-count"),
        ingress_cpu_max: metric("ingress-cpu"),
        stream_cpu_max: metric("stream-cpu"),
        agent_worker_cpu_max: metric("agent-worker-cpu"),
        cloud_sql_cpu_max: metric("cloudsql-cpu"),
        cloud_sql_memory_max: metric("cloudsql-memory"),
        cloud_sql_backends_max: metric("cloudsql-backends"),
        cloud_sql_backends_waiting_max: metric("cloudsql-backends-in-wait"),
    }
}

fn metric_max(metric: &Value) -> Option<f64> {
    metric["timeSeries"]
        .as_array()?
        .iter()
        .flat_map(|series| series["points"].as_array().into_iter().flatten())
        .filter_map(|point| {
            let value = &point["value"];
            value["doubleValue"]
                .as_f64()
                .or_else(|| {
                    value["int64Value"]
                        .as_str()
                        .and_then(|item| item.parse().ok())
                })
                .or_else(|| value["int64Value"].as_f64())
                .or_else(|| value["distributionValue"]["mean"].as_f64())
        })
        .reduce(f64::max)
}

fn requirements(scenarios: &[Value]) -> Vec<Requirement> {
    let definitions = [
        ("23 messages/s daily average", RequirementKind::Rate(23.0)),
        ("232 messages/s modeled peak", RequirementKind::Rate(232.0)),
        (
            "464 messages/s boundary characterized",
            RequirementKind::BoundaryRate(464.0),
        ),
        ("controlled ramp to knee", RequirementKind::Name("ramp")),
        ("short burst above knee", RequirementKind::Name("burst")),
        ("idle to burst", RequirementKind::Name("idle-to-burst")),
        ("measured Luna work graph", RequirementKind::Luna),
        (
            "early explicit overload shedding",
            RequirementKind::EarlyOverloadShedding,
        ),
    ];
    definitions
        .into_iter()
        .map(|(name, kind)| {
            let matches = scenarios
                .iter()
                .filter(|scenario| kind.matches(scenario))
                .collect::<Vec<_>>();
            let passed = matches.iter().any(|scenario| kind.passes(scenario));
            let status = if passed {
                "PASS"
            } else if matches.is_empty() {
                "MISSING"
            } else {
                "FAIL"
            };
            Requirement {
                name: name.into(),
                status: status.into(),
                evidence: if matches.is_empty() {
                    "no recorded scenario".into()
                } else {
                    matches
                        .iter()
                        .filter_map(|scenario| scenario["scenario"].as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                },
            }
        })
        .collect()
}

fn auxiliary_requirements(evidence: &[Value]) -> Vec<Requirement> {
    vec![
        auxiliary_requirement(
            "four-device cursor resume",
            evidence,
            |value| value["device_count"].as_u64().is_some(),
            |value| {
                value["device_count"]
                    .as_u64()
                    .is_some_and(|count| count >= 4)
                    && value["zero_gaps"].as_bool() == Some(true)
                    && value["correct_order"].as_bool() == Some(true)
                    && value["identical_replay"].as_bool() == Some(true)
                    && value["resume_after_cursor"].as_bool() == Some(true)
            },
        ),
        auxiliary_requirement(
            "deployed AgentRun process-loss recovery",
            evidence,
            |value| {
                value["scenario"]
                    .as_str()
                    .is_some_and(|scenario| scenario.contains("process-loss"))
            },
            |value| {
                value["correctness_passed"].as_bool() == Some(true)
                    && value["accepted"].as_u64() == value["completed"].as_u64()
            },
        ),
        auxiliary_requirement(
            "hosted E2B provider conformance",
            evidence,
            |value| {
                value["provider"]
                    .as_str()
                    .is_some_and(|provider| provider.eq_ignore_ascii_case("e2b"))
            },
            |value| value["conformance_passed"].as_bool() == Some(true),
        ),
        auxiliary_requirement(
            "29-cut lifecycle failure matrix",
            evidence,
            |value| value["correctness"].as_array().is_some(),
            |value| {
                value["correctness"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        item["name"].as_str() == Some("full issue 13 failure matrix")
                            && item["passed"].as_bool() == Some(true)
                    })
                })
            },
        ),
        auxiliary_requirement(
            "approval-gated Mailpit SMTP",
            evidence,
            |value| value["correctness"].as_array().is_some(),
            |value| {
                value["correctness"].as_array().is_some_and(|items| {
                    items.iter().any(|item| {
                        item["name"].as_str() == Some("approval-gated SMTP batch")
                            && item["passed"].as_bool() == Some(true)
                    })
                })
            },
        ),
        auxiliary_requirement(
            "sandbox recovery and artifact verification",
            evidence,
            |value| value["failure_matrix"].as_array().is_some(),
            |value| {
                value["failure_matrix"].as_array().is_some_and(|cuts| {
                    ["Sandbox restore", "Artifact verification"]
                        .iter()
                        .all(|required| {
                            cuts.iter().any(|cut| {
                                cut["cut"].as_str() == Some(required)
                                    && cut["passed"].as_bool() == Some(true)
                            })
                        })
                })
            },
        ),
    ]
}

fn auxiliary_requirement(
    name: &str,
    evidence: &[Value],
    matches: impl Fn(&Value) -> bool,
    passes: impl Fn(&Value) -> bool,
) -> Requirement {
    let matching = evidence
        .iter()
        .filter(|value| matches(value))
        .collect::<Vec<_>>();
    Requirement {
        name: name.into(),
        status: if matching.is_empty() {
            "MISSING"
        } else if matching.iter().any(|value| passes(value)) {
            "PASS"
        } else {
            "FAIL"
        }
        .into(),
        evidence: if matching.is_empty() {
            "no recorded evidence".into()
        } else {
            format!("{} matching evidence record(s)", matching.len())
        },
    }
}

fn external_requirement(
    name: &str,
    value: Option<&Value>,
    passes: impl FnOnce(&Value) -> bool,
) -> Requirement {
    match value {
        Some(value) => Requirement {
            name: name.into(),
            status: if passes(value) { "PASS" } else { "FAIL" }.into(),
            evidence: format!(
                "{} via {}",
                value["model"].as_str().unwrap_or("unknown model"),
                value["provider"].as_str().unwrap_or("unknown provider")
            ),
        },
        None => Requirement {
            name: name.into(),
            status: "MISSING".into(),
            evidence: "no recorded result".into(),
        },
    }
}

fn cost_requirement(value: Option<&Value>) -> Requirement {
    match value {
        Some(value) => Requirement {
            name: "auditable Toronto cost model".into(),
            status:
                if value["classification"].as_str() == Some("planning estimate, not an invoice") {
                    "PASS"
                } else {
                    "FAIL"
                }
                .into(),
            evidence: format!(
                "{} per 1,000 messages, known lower bound",
                value["planning_estimate"]["known_lower_bound_per_1000_messages_usd"]
                    .as_f64()
                    .map(|cost| format!("${cost:.3}"))
                    .unwrap_or_else(|| "unknown".into())
            ),
        },
        None => Requirement {
            name: "auditable Toronto cost model".into(),
            status: "MISSING".into(),
            evidence: "no recorded result".into(),
        },
    }
}

fn temporal_capacity_requirement(value: Option<&Value>) -> Requirement {
    let demand =
        value.and_then(|value| value["temporal_cloud"]["target_action_demand_per_second"].as_f64());
    let limit = value
        .and_then(|value| value["temporal_cloud"]["namespace_limit_actions_per_second"].as_f64());
    Requirement {
        name: "Temporal peak action headroom".into(),
        status: match (demand, limit) {
            (Some(demand), Some(limit)) if demand <= limit => "PASS",
            (Some(_), Some(_)) => "FAIL",
            _ => "MISSING",
        }
        .into(),
        evidence: match (demand, limit) {
            (Some(demand), Some(limit)) => {
                format!("{demand:.1} actions/s demand against {limit:.0} actions/s limit")
            }
            _ => "no measured demand and namespace limit".into(),
        },
    }
}

#[derive(Clone, Copy)]
enum RequirementKind {
    Rate(f64),
    BoundaryRate(f64),
    Name(&'static str),
    Luna,
    EarlyOverloadShedding,
}

impl RequirementKind {
    fn matches(self, scenario: &Value) -> bool {
        match self {
            Self::Rate(rate) => scenario["rate_per_second"]
                .as_f64()
                .is_some_and(|actual| (actual - rate).abs() < f64::EPSILON),
            Self::BoundaryRate(rate) => scenario["rate_per_second"]
                .as_f64()
                .is_some_and(|actual| (actual - rate).abs() < f64::EPSILON),
            Self::Name(fragment) => {
                scenario["scenario"]
                    .as_str()
                    .is_some_and(|name| name.contains(fragment))
                    || scenario["arrival_pattern"]
                        .as_str()
                        .is_some_and(|pattern| pattern.contains(fragment))
            }
            Self::Luna => scenario["journey_profile"].as_str() == Some("luna-discovery"),
            Self::EarlyOverloadShedding => scenario["rate_per_second"]
                .as_f64()
                .is_some_and(|rate| rate >= 700.0),
        }
    }

    fn passes(self, scenario: &Value) -> bool {
        match self {
            Self::BoundaryRate(_) => scenario["caller_drop"].as_u64() == Some(0),
            Self::EarlyOverloadShedding => {
                scenario["caller_drop"].as_u64() == Some(0)
                    && scenario["errors"].as_array().is_some_and(|errors| {
                        errors.iter().any(|error| {
                            error
                                .as_str()
                                .is_some_and(|error| error.contains("overload-shed"))
                        })
                    })
            }
            _ => scenario["correctness_passed"].as_bool() == Some(true),
        }
    }
}

fn render(bundle: &DashboardBundle) -> Result<String> {
    let data = serde_json::to_string(bundle)?.replace("</", "<\\/");
    Ok(format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Osfo Toronto AgentRun confirmation</title>
<style>
:root{{--bg:#09111f;--panel:#111c2f;--line:#2a3b57;--text:#e8eef8;--muted:#94a3b8;--good:#34d399;--bad:#fb7185;--missing:#fbbf24;--blue:#60a5fa}}*{{box-sizing:border-box}}body{{margin:0;background:linear-gradient(150deg,#07101d,#0d1830);color:var(--text);font:14px/1.45 system-ui,sans-serif}}main{{max-width:1440px;margin:auto;padding:32px}}h1{{font-size:30px;margin:0 0 6px}}h2{{margin:28px 0 10px}}.muted{{color:var(--muted)}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}}.card,.panel{{background:rgba(17,28,47,.94);border:1px solid var(--line);border-radius:12px;padding:16px}}.value{{font-size:25px;font-weight:750}}.PASS{{color:var(--good)}}.FAIL{{color:var(--bad)}}.MISSING{{color:var(--missing)}}table{{width:100%;border-collapse:collapse;background:rgba(17,28,47,.94)}}th,td{{padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}}th:first-child,td:first-child{{text-align:left}}th{{position:sticky;top:0;background:#132039}}#requirements td:nth-child(3){{min-width:520px;text-align:left;white-space:normal}}.scroll{{overflow:auto;border:1px solid var(--line);border-radius:12px}}.bar{{height:10px;background:#1e2b43;border-radius:99px;overflow:hidden;min-width:120px}}.bar>i{{display:block;height:100%;background:var(--blue)}}code{{color:#bfdbfe}}
</style></head><body><main><h1>Toronto AgentRun lifecycle confirmation</h1><p class="muted" id="note"></p><div class="grid" id="summary"></div><h2>Required matrix</h2><div class="scroll"><table><thead><tr><th>Requirement</th><th>Status</th><th>Evidence</th></tr></thead><tbody id="requirements"></tbody></table></div><h2>Live Luna reasoning</h2><div class="grid" id="reasoning"></div><h2>Traffic and typed amplification</h2><div class="scroll"><table><thead><tr><th>Scenario</th><th>Gate</th><th>Offered</th><th>Accepted</th><th>Completed</th><th>Caller drop</th><th>DB terminal/s</th><th>Drain s</th><th>Quick/msg</th><th>AgentRuns/msg</th><th>Children/msg</th><th>Awaited/msg</th><th>Detached/msg</th><th>Workflows/msg</th><th>Activities/msg</th><th>Tools/msg</th><th>Approvals/msg</th><th>Proactive/msg</th><th>Reminders/msg</th><th>Sandboxes/msg</th><th>Artifacts/msg</th></tr></thead><tbody id="traffic"></tbody></table></div><h2>Latency percentiles, milliseconds</h2><div class="scroll"><table><thead><tr><th>Scenario</th><th>Admission p50</th><th>p95</th><th>p99</th><th>DB terminal p50</th><th>p95</th><th>p99</th><th>SSE p50</th><th>p95</th><th>p99</th></tr></thead><tbody id="latency"></tbody></table></div><h2>Actual Temporal Cloud execution</h2><div class="scroll"><table><thead><tr><th>Pattern</th><th>Gate</th><th>Offered</th><th>Completed</th><th>Completed/s</th><th>History events</th><th>p50 ms</th><th>p95 ms</th><th>p99 ms</th></tr></thead><tbody id="temporal"></tbody></table></div><h2>Temporal capacity and planning cost</h2><div class="grid" id="capacity-cost"></div><p class="muted" id="cost-note"></p><h2>Recovery and provider seam evidence</h2><div class="scroll"><table><thead><tr><th>Evidence</th><th>Status</th><th>Observed result</th></tr></thead><tbody id="auxiliary"></tbody></table></div><h2>Tier saturation</h2><div class="scroll"><table><thead><tr><th>Scenario</th><th>Ingress inst</th><th>Stream inst</th><th>Agent workers</th><th>Ingress CPU</th><th>Stream CPU</th><th>Worker CPU</th><th>SQL CPU</th><th>SQL memory</th><th>SQL backends</th><th>SQL waiting</th></tr></thead><tbody id="telemetry"></tbody></table></div><h2>Offered versus authoritative completion rate</h2><div class="panel" id="rates"></div><h2>Evidence index</h2><div class="panel"><ul id="sources"></ul><p class="muted">Grafana and OpenMetrics capture: evidence/temporal-cloud-luna-metrics-20260804T054500Z/. The checksummed JSON, raw samples, Cloud Monitoring responses, Query Insights responses, Temporal histories, and topology files are the durable evidence.</p></div></main>
<script>const D={data};const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}}[c]));const n=v=>v==null?'n/a':Number(v).toLocaleString(undefined,{{maximumFractionDigits:3}});const money=v=>v==null?'n/a':'$'+Number(v).toLocaleString(undefined,{{maximumFractionDigits:2}});const unitMoney=v=>v==null?'n/a':'$'+Number(v).toFixed(6);const pct=v=>v==null?'n/a':(100*Number(v)).toFixed(1)+'%';document.getElementById('note').textContent=D.note;document.getElementById('summary').innerHTML=`<div class="card"><div class="muted">Matrix verdict</div><div class="value ${{D.verdict}}">${{D.verdict}}</div></div><div class="card"><div class="muted">Traffic scenarios</div><div class="value">${{D.scenarios.length}}</div></div><div class="card"><div class="muted">Traffic samples</div><div class="value">${{n(D.scenarios.reduce((a,s)=>a+(s.offered||0),0))}}</div></div><div class="card"><div class="muted">Actual Temporal workflows</div><div class="value">${{n(D.temporal.reduce((a,s)=>a+(s.completed||0),0))}}</div></div>`;document.getElementById('requirements').innerHTML=D.requirements.map(r=>`<tr><td>${{esc(r.name)}}</td><td class="${{r.status}}">${{r.status}}</td><td>${{esc(r.evidence)}}</td></tr>`).join('');const R=D.reasoning;document.getElementById('reasoning').innerHTML=R?`<div class="card"><div class="muted">Model</div><div class="value">${{esc(R.model)}}</div></div><div class="card"><div class="muted">Decisions</div><div class="value">${{n(R.usage?.successful_decisions)}}</div></div><div class="card"><div class="muted">AgentRuns/message</div><div class="value">${{n(R.amplification?.total_agent_runs_per_message)}}</div></div><div class="card"><div class="muted">Workflows/message</div><div class="value">${{n(R.amplification?.temporal_workflows_per_message)}}</div></div><div class="card"><div class="muted">Reasoning p95</div><div class="value">${{n(R.usage?.latency?.p95_ms)}} ms</div></div><div class="card"><div class="muted">Planner cost/message</div><div class="value">${{unitMoney(R.usage?.cost_per_message_dollars)}}</div></div>`:'<div class="card MISSING">No reasoning evidence</div>';document.getElementById('traffic').innerHTML=D.scenarios.map(s=>`<tr><td>${{esc(s.scenario)}}</td><td class="${{s.correctness_passed?'PASS':'FAIL'}}">${{s.correctness_passed?'PASS':'FAIL'}}</td><td>${{n(s.offered)}}</td><td>${{n(s.accepted)}}</td><td>${{n(s.completed)}}</td><td>${{n(s.caller_drop)}}</td><td>${{n(s.authoritative_completed_during_offer_per_second)}}</td><td>${{n(s.drain_seconds)}}</td><td>${{n(s.amplification?.quick_replies_per_message)}}</td><td>${{n(s.amplification?.agent_runs_per_message)}}</td><td>${{n(s.amplification?.child_agent_runs_per_message)}}</td><td>${{n(s.amplification?.awaited_child_agent_runs_per_message)}}</td><td>${{n(s.amplification?.detached_child_agent_runs_per_message)}}</td><td>${{n(s.amplification?.workflow_instances_per_message)}}</td><td>${{n(s.amplification?.workflow_activities_per_message)}}</td><td>${{n(s.amplification?.tool_calls_per_message)}}</td><td>${{n(s.amplification?.approvals_per_message)}}</td><td>${{n(s.amplification?.proactive_messages_per_message)}}</td><td>${{n(s.amplification?.scheduled_reminders_per_message)}}</td><td>${{n(s.amplification?.sandbox_jobs_per_message)}}</td><td>${{n(s.amplification?.artifact_commits_per_message)}}</td></tr>`).join('');const p=(s,k,q)=>n(s[k]?.[q+'_ms']);document.getElementById('latency').innerHTML=D.scenarios.map(s=>`<tr><td>${{esc(s.scenario)}}</td><td>${{p(s,'admission_latency','p50')}}</td><td>${{p(s,'admission_latency','p95')}}</td><td>${{p(s,'admission_latency','p99')}}</td><td>${{p(s,'authoritative_completion_latency','p50')}}</td><td>${{p(s,'authoritative_completion_latency','p95')}}</td><td>${{p(s,'authoritative_completion_latency','p99')}}</td><td>${{p(s,'completion_latency','p50')}}</td><td>${{p(s,'completion_latency','p95')}}</td><td>${{p(s,'completion_latency','p99')}}</td></tr>`).join('');document.getElementById('temporal').innerHTML=D.temporal.map(s=>`<tr><td>${{esc(s.arrival_pattern)}}</td><td class="${{s.correctness_passed?'PASS':'FAIL'}}">${{s.correctness_passed?'PASS':'FAIL'}}</td><td>${{n(s.offered)}}</td><td>${{n(s.completed)}}</td><td>${{n(s.completed_per_second)}}</td><td>${{n(s.history_events)}}</td><td>${{n(s.completion_latency_ms?.p50)}}</td><td>${{n(s.completion_latency_ms?.p95)}}</td><td>${{n(s.completion_latency_ms?.p99)}}</td></tr>`).join('');const C=D.cost,TC=C?.temporal_cloud,PE=C?.planning_estimate;document.getElementById('capacity-cost').innerHTML=C?`<div class="card"><div class="muted">Temporal namespace limit</div><div class="value">${{n(TC?.namespace_limit_actions_per_second)}} APS</div></div><div class="card"><div class="muted">Target action demand</div><div class="value ${{TC?.target_action_demand_per_second>TC?.namespace_limit_actions_per_second?'FAIL':'PASS'}}">${{n(TC?.target_action_demand_per_second)}} APS</div></div><div class="card"><div class="muted">Observed actions/workflow</div><div class="value">${{n(C.measured_amplification?.temporal_actions_per_workflow)}}</div></div><div class="card"><div class="muted">Known monthly lower bound</div><div class="value">${{money(PE?.known_lower_bound_monthly_usd)}}</div></div><div class="card"><div class="muted">Lower bound/1,000 messages</div><div class="value">${{money(PE?.known_lower_bound_per_1000_messages_usd)}}</div></div><div class="card"><div class="muted">Planner model/month</div><div class="value">${{money(PE?.model_planner_monthly_usd)}}</div></div>`:'<div class="card MISSING">No cost evidence</div>';document.getElementById('cost-note').textContent=C?`${{C.classification}}. Excludes: ${{(C.exclusions||[]).join('; ')}}.`:'';const auxRow=v=>{{if(v.device_count)return['four-device cursor replay',v.zero_gaps&&v.correct_order&&v.identical_replay&&v.resume_after_cursor,`${{v.device_count}} devices, zero gaps, ordered identical replay`];if(String(v.scenario||'').includes('process-loss'))return['AgentRun process-loss recovery',v.correctness_passed&&v.accepted===v.completed,`${{n(v.completed)}} of ${{n(v.accepted)}} accepted completed`];if(String(v.provider||'').toLowerCase()==='e2b')return['E2B provider conformance',v.conformance_passed,`${{n(v.total_ms)}} ms, artifact ${{String(v.artifact_sha256||'').slice(0,12)}}…`];const f=(v.correctness||[]).find(x=>x.name==='full issue 13 failure matrix');if(f)return['lifecycle failure matrix',f.passed,f.evidence];return['supplemental evidence',false,'unclassified'];}};document.getElementById('auxiliary').innerHTML=D.auxiliary.map(auxRow).map(([name,pass,evidence])=>`<tr><td>${{esc(name)}}</td><td class="${{pass?'PASS':'FAIL'}}">${{pass?'PASS':'FAIL'}}</td><td>${{esc(evidence)}}</td></tr>`).join('');document.getElementById('sources').innerHTML=[...(D.source_files||[]),...((C&&C.sources)||[])].map(source=>`<li><code>${{esc(source)}}</code></li>`).join('');document.getElementById('telemetry').innerHTML=D.telemetry.map(t=>`<tr><td>${{esc(t.scenario)}}</td><td>${{n(t.ingress_instances_max)}}</td><td>${{n(t.stream_instances_max)}}</td><td>${{n(t.agent_worker_instances_max)}}</td><td>${{pct(t.ingress_cpu_max)}}</td><td>${{pct(t.stream_cpu_max)}}</td><td>${{pct(t.agent_worker_cpu_max)}}</td><td>${{pct(t.cloud_sql_cpu_max)}}</td><td>${{pct(t.cloud_sql_memory_max)}}</td><td>${{n(t.cloud_sql_backends_max)}}</td><td>${{n(t.cloud_sql_backends_waiting_max)}}</td></tr>`).join('');const max=Math.max(1,...D.scenarios.map(s=>s.rate_per_second||0));document.getElementById('rates').innerHTML=D.scenarios.map(s=>`<div style="display:grid;grid-template-columns:minmax(280px,1fr) 4fr 110px;gap:10px;align-items:center;margin:9px 0"><code>${{esc(s.scenario)}}</code><div><div class="bar"><i style="width:${{100*(s.rate_per_second||0)/max}}%"></i></div><div class="bar" style="margin-top:4px"><i style="background:var(--good);width:${{100*(s.authoritative_completed_during_offer_per_second||0)/max}}%"></i></div></div><span>${{n(s.authoritative_completed_during_offer_per_second)}} / ${{n(s.rate_per_second)}}</span></div>`).join('');</script></body></html>"#
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        RequirementKind, auxiliary_requirements, metric_max, temporal_capacity_requirement,
    };

    #[test]
    fn monitoring_summary_reads_scalars_and_distribution_means() {
        let metric = serde_json::json!({
            "timeSeries": [{"points": [
                {"value": {"doubleValue": 0.42}},
                {"value": {"int64Value": "7"}},
                {"value": {"distributionValue": {"count": "3", "mean": 0.81}}}
            ]}]
        });

        assert_eq!(metric_max(&metric), Some(7.0));
    }

    #[test]
    fn matrix_requirement_matches_the_recorded_arrival_pattern() {
        let scenario = serde_json::json!({
            "scenario": "idle30-burst",
            "arrival_pattern": "idle-to-burst"
        });

        assert!(RequirementKind::Name("idle-to-burst").matches(&scenario));
    }

    #[test]
    fn auxiliary_requirements_cover_recovery_delivery_and_provider_seams() {
        let evidence = vec![
            serde_json::json!({
                "device_count": 4,
                "zero_gaps": true,
                "correct_order": true,
                "identical_replay": true,
                "resume_after_cursor": true
            }),
            serde_json::json!({
                "scenario": "toronto-process-loss-worker16-to1-to16",
                "correctness_passed": true,
                "accepted": 4640,
                "completed": 4640
            }),
            serde_json::json!({
                "provider": "E2B",
                "conformance_passed": true
            }),
            serde_json::json!({
                "correctness": [
                    {
                        "name": "full issue 13 failure matrix",
                        "passed": true,
                        "evidence": "all 29 required injection families have passing evidence"
                    },
                    {
                        "name": "approval-gated SMTP batch",
                        "passed": true,
                        "evidence": "20 ToolCalls produced exactly 20 Mailpit messages"
                    }
                ],
                "failure_matrix": [
                    {"cut": "Artifact verification", "passed": true},
                    {"cut": "Sandbox restore", "passed": true}
                ]
            }),
        ];

        let requirements = auxiliary_requirements(&evidence);

        assert_eq!(requirements.len(), 6);
        assert!(requirements.iter().all(|item| item.status == "PASS"));
    }

    #[test]
    fn temporal_capacity_fails_when_measured_demand_exceeds_the_namespace_limit() {
        let evidence = serde_json::json!({
            "temporal_cloud": {
                "target_action_demand_per_second": 663.7,
                "namespace_limit_actions_per_second": 500
            }
        });

        let requirement = temporal_capacity_requirement(Some(&evidence));

        assert_eq!(requirement.status, "FAIL");
        assert!(requirement.evidence.contains("663.7"));
        assert!(requirement.evidence.contains("500"));
    }
}
