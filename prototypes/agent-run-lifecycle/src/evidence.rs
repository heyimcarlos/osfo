use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    path::Path,
};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::confirmation::{ConfirmationVerdict, TrafficAccounting};

pub use crate::confirmation::REQUIRED_FAILURE_INJECTIONS;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceManifest {
    pub schema_version: u32,
    pub seed: u64,
    pub question: String,
    pub stages: Vec<StageManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageManifest {
    pub name: String,
    pub workload: String,
    pub arrival_pattern: String,
    pub offered_per_second: f64,
    pub duration_seconds: u64,
    pub worker_count: usize,
    pub persistence_profile: String,
    #[serde(default = "default_maximum_arrival_lag_milliseconds")]
    pub maximum_arrival_lag_milliseconds: u64,
    #[serde(default = "percentiles_enabled")]
    pub report_percentiles: bool,
}

fn percentiles_enabled() -> bool {
    true
}

fn default_maximum_arrival_lag_milliseconds() -> u64 {
    250
}

impl EvidenceManifest {
    pub fn from_json(input: &str) -> Result<Self> {
        let manifest: Self = serde_json::from_str(input).context("parse evidence manifest")?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 2 {
            bail!(
                "unsupported evidence schema version {}",
                self.schema_version
            );
        }
        if self.question.trim().is_empty() || self.stages.is_empty() {
            bail!("the evidence question and at least one stage are required");
        }
        let mut names = HashSet::new();
        for stage in &self.stages {
            if !names.insert(&stage.name) {
                bail!("duplicate stage name: {}", stage.name);
            }
            if stage.offered_per_second <= 0.0
                || stage.duration_seconds == 0
                || stage.worker_count == 0
            {
                bail!("stage {} has a non-positive load setting", stage.name);
            }
            if stage.maximum_arrival_lag_milliseconds == 0 {
                bail!(
                    "stage {} must declare a positive arrival-lag bound",
                    stage.name
                );
            }
            let planned = stage.offered_per_second * stage.duration_seconds as f64;
            if stage.report_percentiles && planned < 100.0 {
                bail!(
                    "stage {} needs at least 100 samples before p99 is reported",
                    stage.name
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricSummary {
    pub p50_ms: f64,
    pub p90_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub maximum_ms: f64,
    pub sample_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeSample {
    pub elapsed_seconds: f64,
    pub offered: u64,
    #[serde(default)]
    pub received: u64,
    #[serde(default)]
    pub caller_drop: u64,
    pub accepted: u64,
    #[serde(default)]
    pub shed_or_rejected: u64,
    pub completed: u64,
    #[serde(default)]
    pub failed: u64,
    pub errors: u64,
    pub pending: i64,
    pub running: i64,
    pub waiting: i64,
    pub database_connections: i64,
    pub lock_waiters: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioEvidence {
    pub name: String,
    #[serde(default)]
    pub started_at_unix_milliseconds: u64,
    #[serde(default)]
    pub ended_at_unix_milliseconds: u64,
    pub workload: String,
    pub persistence_profile: String,
    pub offered: u64,
    pub accepted: u64,
    pub completed: u64,
    pub shed: u64,
    #[serde(default)]
    pub traffic: TrafficAccounting,
    pub errors: Vec<String>,
    pub elapsed_seconds: f64,
    pub drain_seconds: f64,
    pub offered_per_second: f64,
    pub completed_per_second: f64,
    pub metrics: BTreeMap<String, MetricSummary>,
    pub samples: Vec<TimeSample>,
    #[serde(default)]
    pub raw_latency_file: Option<String>,
    #[serde(default)]
    pub raw_latency_sha256: Option<String>,
    #[serde(default)]
    pub raw_latency_rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrectnessCheck {
    pub name: String,
    pub passed: bool,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureEvidence {
    pub cut: String,
    pub injection: String,
    pub observed_recovery: String,
    pub invariant: String,
    pub passed: bool,
    #[serde(default)]
    pub samples_ms: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceBundle {
    pub schema_version: u32,
    pub generated_at: String,
    pub question: String,
    pub environment: BTreeMap<String, String>,
    pub scenarios: Vec<ScenarioEvidence>,
    pub correctness: Vec<CorrectnessCheck>,
    pub failure_matrix: Vec<FailureEvidence>,
    pub notes: Vec<String>,
    #[serde(default)]
    pub confirmation_verdict: Option<ConfirmationVerdict>,
}

impl EvidenceBundle {
    #[cfg(test)]
    fn example() -> Self {
        Self {
            schema_version: 2,
            generated_at: "2026-08-03T00:00:00Z".into(),
            question: "Where is the tested capacity knee?".into(),
            environment: BTreeMap::from([("database".into(), "PostgreSQL 17".into())]),
            scenarios: vec![ScenarioEvidence {
                name: "warm-up".into(),
                started_at_unix_milliseconds: 0,
                ended_at_unix_milliseconds: 0,
                workload: "reference journey".into(),
                persistence_profile: "cold".into(),
                offered: 100,
                accepted: 100,
                completed: 100,
                shed: 0,
                traffic: TrafficAccounting {
                    offered: 100,
                    received: 100,
                    caller_drop: 0,
                    accepted: 100,
                    shed_or_rejected: 0,
                    completed: 100,
                    failed: 0,
                    canceled: 0,
                    still_in_flight: 0,
                },
                errors: Vec::new(),
                elapsed_seconds: 20.0,
                drain_seconds: 0.1,
                offered_per_second: 5.0,
                completed_per_second: 5.0,
                metrics: BTreeMap::from([(
                    "end_to_end_journey".into(),
                    MetricSummary {
                        p50_ms: 10.0,
                        p90_ms: 20.0,
                        p95_ms: 25.0,
                        p99_ms: 30.0,
                        maximum_ms: 35.0,
                        sample_count: 100,
                    },
                )]),
                samples: Vec::new(),
                raw_latency_file: None,
                raw_latency_sha256: None,
                raw_latency_rows: 0,
            }],
            correctness: vec![CorrectnessCheck {
                name: "zero lost accepted work".into(),
                passed: true,
                evidence: "100 accepted, 100 terminal".into(),
            }],
            failure_matrix: Vec::new(),
            notes: Vec::new(),
            confirmation_verdict: None,
        }
    }
}

pub fn render_dashboard(bundle: &EvidenceBundle) -> Result<String> {
    render_dashboard_with_telemetry(bundle, &serde_json::json!({}))
}

pub fn render_dashboard_with_telemetry(
    bundle: &EvidenceBundle,
    telemetry: &serde_json::Value,
) -> Result<String> {
    let mut data = serde_json::to_string(bundle)?;
    data = data.replace('<', "\\u003c");
    let mut telemetry = serde_json::to_string(telemetry)?;
    telemetry = telemetry.replace('<', "\\u003c");
    Ok(DASHBOARD_TEMPLATE
        .replace("__OSFO_EVIDENCE__", &data)
        .replace("__OSFO_TELEMETRY__", &telemetry))
}

pub fn load_frozen_telemetry(evidence_dir: &Path) -> Result<serde_json::Value> {
    let telemetry_dir = evidence_dir.join("telemetry");
    let query_dir = telemetry_dir.join("queries");
    if !query_dir.is_dir() {
        return Ok(serde_json::json!({}));
    }
    let summary = fs::read(telemetry_dir.join("summary.json"))?;
    let summary: serde_json::Value = serde_json::from_slice(&summary)?;
    let mut series = BTreeMap::new();
    for entry in fs::read_dir(query_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let response: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
        let name = path
            .file_stem()
            .and_then(|value| value.to_str())
            .context("telemetry query result has a non-UTF-8 name")?;
        series.insert(name.to_owned(), response["data"]["result"].clone());
    }
    Ok(serde_json::json!({"summary": summary, "series": series}))
}

pub fn merge_frozen_telemetry(inputs: Vec<serde_json::Value>) -> serde_json::Value {
    let inputs = inputs
        .into_iter()
        .filter(|input| input["series"].is_object())
        .collect::<Vec<_>>();
    if inputs.is_empty() {
        return serde_json::json!({});
    }
    let query_count = inputs
        .iter()
        .filter_map(|input| input["summary"]["query_count"].as_u64())
        .sum::<u64>();
    let successful_queries = inputs
        .iter()
        .filter_map(|input| input["summary"]["successful_queries"].as_u64())
        .sum::<u64>();
    let range_start = inputs
        .iter()
        .filter_map(|input| input["summary"]["range_start_unix_seconds"].as_f64())
        .min_by(f64::total_cmp)
        .unwrap_or_default();
    let range_end = inputs
        .iter()
        .filter_map(|input| input["summary"]["range_end_unix_seconds"].as_f64())
        .max_by(f64::total_cmp)
        .unwrap_or_default();
    let mut required_jobs = BTreeSet::new();
    let mut healthy_jobs = BTreeSet::new();
    let mut series = BTreeMap::<String, Vec<serde_json::Value>>::new();
    for input in &inputs {
        for job in input["summary"]["required_jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
        {
            required_jobs.insert(job.to_owned());
        }
        for job in input["summary"]["healthy_jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
        {
            healthy_jobs.insert(job.to_owned());
        }
        for (name, values) in input["series"].as_object().into_iter().flatten() {
            series
                .entry(name.clone())
                .or_default()
                .extend(values.as_array().into_iter().flatten().cloned());
        }
    }
    serde_json::json!({
        "summary": {
            "profile": "merged-frozen-evidence",
            "run_count": inputs.len(),
            "range_start_unix_seconds": range_start,
            "range_end_unix_seconds": range_end,
            "required_jobs": required_jobs,
            "healthy_jobs": healthy_jobs,
            "query_count": query_count,
            "successful_queries": successful_queries,
            "complete": inputs.iter().all(|input| input["summary"]["complete"].as_bool() == Some(true)),
        },
        "series": series,
        "runs": inputs.iter().map(|input| input["summary"].clone()).collect::<Vec<_>>(),
    })
}

pub fn summarize_milliseconds(mut values: Vec<f64>) -> MetricSummary {
    values.sort_by(f64::total_cmp);
    MetricSummary {
        p50_ms: percentile(&values, 0.50),
        p90_ms: percentile(&values, 0.90),
        p95_ms: percentile(&values, 0.95),
        p99_ms: percentile(&values, 0.99),
        maximum_ms: values.last().copied().unwrap_or_default(),
        sample_count: values.len(),
    }
}

pub fn merge_bundles(bundles: Vec<EvidenceBundle>) -> EvidenceBundle {
    let mut environment = BTreeMap::new();
    let mut scenarios = Vec::new();
    let mut correctness = Vec::new();
    let mut failure_matrix = Vec::new();
    let mut notes = Vec::new();
    let mut generated_at = String::new();
    for bundle in bundles {
        generated_at = generated_at.max(bundle.generated_at);
        let profile_prefix = bundle
            .environment
            .get("database-profile")
            .map(|profile| {
                if names_cloud_sql(profile) {
                    "cloud-sql"
                } else {
                    "local"
                }
            })
            .unwrap_or("lane");
        environment.extend(bundle.environment);
        for mut scenario in bundle.scenarios {
            if scenarios
                .iter()
                .any(|existing: &ScenarioEvidence| existing.name == scenario.name)
            {
                scenario.name = format!("{profile_prefix}-{}", scenario.name);
            }
            scenarios.push(scenario);
        }
        correctness.extend(
            bundle
                .correctness
                .into_iter()
                .filter(|check| check.name != "full issue 13 failure matrix"),
        );
        failure_matrix.extend(bundle.failure_matrix);
        notes.extend(bundle.notes);
    }
    failure_matrix
        .sort_by(|left, right| (&left.cut, &left.injection).cmp(&(&right.cut, &right.injection)));
    failure_matrix
        .dedup_by(|left, right| left.cut == right.cut && left.injection == right.injection);
    let cloud_sql = environment
        .iter()
        .any(|(key, value)| names_cloud_sql(&format!("{key} {value}")));
    correctness.push(CorrectnessCheck {
        name: "Cloud SQL topology exercised".into(),
        passed: cloud_sql,
        evidence: if cloud_sql {
            "at least one evidence lane identifies its Osfo authority as Cloud SQL".into()
        } else {
            "no merged lane identifies a Cloud SQL authority run".into()
        },
    });
    let observed = failure_matrix
        .iter()
        .filter(|row| row.passed)
        .map(|row| row.injection.as_str())
        .collect::<HashSet<_>>();
    let missing = REQUIRED_FAILURE_INJECTIONS
        .iter()
        .filter(|injection| !observed.contains(**injection))
        .copied()
        .collect::<Vec<_>>();
    correctness.push(CorrectnessCheck {
        name: "full issue 13 failure matrix".into(),
        passed: missing.is_empty(),
        evidence: if missing.is_empty() {
            format!(
                "all {} required injection families have passing evidence",
                REQUIRED_FAILURE_INJECTIONS.len()
            )
        } else {
            format!(
                "{} of {} required injection families remain missing: {}",
                missing.len(),
                REQUIRED_FAILURE_INJECTIONS.len(),
                missing.join(", ")
            )
        },
    });
    EvidenceBundle {
        schema_version: 3,
        generated_at,
        question: "Does the complete production-shaped AgentRun lifecycle satisfy issue 13 across load, real services, Cloud SQL, durability, and injected failures?".into(),
        environment,
        scenarios,
        correctness,
        failure_matrix,
        notes,
        confirmation_verdict: None,
    }
}

fn names_cloud_sql(value: &str) -> bool {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>()
        .contains("cloudsql")
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let index = ((values.len() - 1) as f64 * quantile).ceil() as usize;
    values[index]
}

const DASHBOARD_TEMPLATE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentRun lifecycle evidence</title>
<style>
:root{color-scheme:dark;--bg:#08111f;--panel:#101c2d;--line:#253853;--text:#edf4ff;--muted:#9db0c9;--good:#38d996;--bad:#ff6b7a;--blue:#62a8ff;--amber:#ffc857;--violet:#be8cff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% 0,#173156 0,transparent 38%),var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}main{max-width:1500px;margin:auto;padding:28px}.eyebrow{color:var(--blue);letter-spacing:.14em;text-transform:uppercase}.hero{display:flex;gap:24px;align-items:end;justify-content:space-between}.hero h1{font:700 38px/1.05 system-ui;margin:8px 0 12px}.hero p{max-width:880px;color:var(--muted)}.status{border:1px solid var(--line);padding:12px 16px;border-radius:10px;background:#0c1728}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:22px 0}.telemetry-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.chart{border:1px solid var(--line);border-radius:10px;padding:12px;background:#0a1525}.chart h3{font:650 15px system-ui;margin:0 0 6px}.card,.panel{border:1px solid var(--line);background:linear-gradient(180deg,#122138,#0d1828);border-radius:12px;padding:16px}.card .value{font:700 28px system-ui}.label,.muted{color:var(--muted)}.panel{margin:14px 0;overflow:auto}.panel h2{font:650 20px system-ui;margin:0 0 12px}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:right;padding:9px 10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}.pass{color:var(--good)}.fail{color:var(--bad)}.missing{color:var(--amber)}canvas{width:100%;height:320px;display:block}.telemetry-grid canvas{height:260px}.legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted)}code{color:#c9dcff}@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.telemetry-grid{grid-template-columns:1fr}.hero{display:block}}
</style>
</head>
<body><main>
<div class="hero"><div><div class="eyebrow">Osfo evidence bundle v3</div><h1>Production-shaped AgentRun lifecycle</h1><p id="question"></p></div><div class="status" id="status"></div></div>
<section class="grid" id="summary"></section>
<section class="panel"><h2>Confirmation verdict</h2><table id="gates"></table></section>
<section class="panel" id="cloud-capacity-panel"><h2>Cloud SQL capacity envelope</h2><div class="legend"><span style="color:#62a8ff">● completed/s</span><span style="color:#ffc857">● end-to-end p99 ms</span></div><canvas id="cloud-capacity" width="1400" height="320"></canvas></section>
<section class="panel" id="local-capacity-panel"><h2>Local PostgreSQL capacity envelope</h2><div class="legend"><span style="color:#62a8ff">● completed/s</span><span style="color:#ffc857">● end-to-end p99 ms</span></div><canvas id="local-capacity" width="1400" height="320"></canvas></section>
<section class="panel" id="telemetry-panel"><h2>Frozen dependency telemetry</h2><p class="muted" id="telemetry-status"></p><div class="telemetry-grid">
<div class="chart"><h3>Traffic rate</h3><div class="legend"><span style="color:#62a8ff">● offered/s</span><span style="color:#38d996">● accepted/s</span><span style="color:#ffc857">● completed/s</span></div><canvas id="traffic-telemetry" width="700" height="260"></canvas></div>
<div class="chart"><h3>Dependency utilization</h3><div class="legend"><span style="color:#62a8ff">● runner CPU</span><span style="color:#38d996">● Cloud SQL CPU</span><span style="color:#ffc857">● Temporal actions</span></div><canvas id="utilization-telemetry" width="700" height="260"></canvas></div>
<div class="chart"><h3>Authoritative backlog</h3><div class="legend"><span style="color:#62a8ff">● pending</span><span style="color:#ffc857">● waiting</span><span style="color:#be8cff">● running</span></div><canvas id="backlog-telemetry" width="700" height="260"></canvas></div>
<div class="chart"><h3>Temporal latency and backlog</h3><div class="legend"><span style="color:#62a8ff">● Cloud service p99</span><span style="color:#ffc857">● SDK queue p99</span><span style="color:#be8cff">● Cloud backlog</span></div><canvas id="temporal-telemetry" width="700" height="260"></canvas></div>
</div></section>
<section class="panel" id="cost-panel"><h2>Cost evidence</h2><p class="muted" id="cost-status"></p><table id="cost"></table></section>
<section class="panel"><h2>Scenario results</h2><table id="scenarios"></table></section>
<section class="panel"><h2>Latency families</h2><table id="latencies"></table></section>
<section class="panel"><h2>Correctness gates</h2><table id="correctness"></table></section>
<section class="panel"><h2>Failure matrix</h2><table id="failures"></table></section>
<section class="panel"><h2>Environment and exact versions</h2><table id="environment"></table></section>
<section class="panel"><h2>Interpretation limits</h2><ul id="notes"></ul></section>
</main><script>
window.OSFO_EVIDENCE=__OSFO_EVIDENCE__;
window.OSFO_TELEMETRY=__OSFO_TELEMETRY__;
const d=window.OSFO_EVIDENCE,t=window.OSFO_TELEMETRY,fmt=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2}),v=d.confirmation_verdict,verdict=v?.verdict||'MISSING',validity=v?.evidence_validity||'MISSING',target=v?.target_result||'MISSING',statusClass=x=>x==='PASS'?'pass':x==='FAIL'?'fail':'missing';
document.querySelector('#question').textContent=d.question;document.querySelector('#status').innerHTML=`<div class="label">Confirmation verdict</div><strong class="${statusClass(verdict)}">${verdict}</strong><div>Evidence validity: <strong class="${statusClass(validity)}">${validity}</strong></div><div>Target result: <strong class="${statusClass(target)}">${target}</strong></div><div class="muted">Generated ${d.generated_at}</div>`;
const offered=d.scenarios.reduce((a,x)=>a+x.offered,0),completed=d.scenarios.reduce((a,x)=>a+x.completed,0),failures=d.failure_matrix.filter(x=>x.passed).length;
document.querySelector('#summary').innerHTML=[['Offered AgentRuns',fmt(offered)],['Completed',fmt(completed)],['Evidence validity',validity],['Target result',target]].map(([a,b])=>`<div class="card"><div class="label">${a}</div><div class="value ${statusClass(b)}">${b}</div></div>`).join('');
const table=(sel,heads,rows)=>{document.querySelector(sel).innerHTML=`<thead><tr>${heads.map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(x=>`<td>${x}</td>`).join('')}</tr>`).join('')}</tbody>`};
const gates=v?[['Correctness',v.correctness_gate],['Telemetry',v.telemetry_gate],['Workload fidelity',v.workload_fidelity_gate],['Safe overload',v.safe_overload_gate],['Recovery',v.recovery_gate],['Topology',v.topology_gate],['Load matrix',v.load_matrix_gate],['Failure matrix',v.failure_matrix_gate]]:[['Correctness','MISSING'],['Telemetry','MISSING'],['Workload fidelity','MISSING'],['Safe overload','MISSING'],['Recovery','MISSING'],['Topology','MISSING'],['Load matrix','MISSING'],['Failure matrix','MISSING']];table('#gates',['gate','result'],gates.map(([name,result])=>[name,`<strong class="${statusClass(result)}">${result}</strong>`]));
const cost=t.cost||null,costSummary=cost?.summary||{},costPanel=document.querySelector('#cost-panel');costPanel.hidden=!cost;if(cost){table('#cost',['measurement','USD','status'],[['Known GCP catalog estimate',`$${fmt(costSummary.gcp_known_catalog_estimate)}`,'ESTIMATE'],['Temporal Actions first-tier list-rate equivalent',`$${fmt(costSummary.temporal_actions_first_tier_list_rate_equivalent)}`,'NOTIONAL'],['Actual combined invoice cost','not yet available',`<strong class="${statusClass(costSummary.combined_actual_invoice_status)}">${costSummary.combined_actual_invoice_status||'MISSING'}</strong>`]]);document.querySelector('#cost-status').textContent='Catalog estimates are not invoice totals. See cost.json for exact SKUs, measured intervals, exclusions, and continuing resource cost.'}
table('#scenarios',['stage','profile','offered','accepted','completed','shed','errors','completed/s','drain s'],d.scenarios.map(x=>[x.name,x.persistence_profile,fmt(x.offered),fmt(x.accepted),fmt(x.completed),fmt(x.shed),x.errors.length,fmt(x.completed_per_second),fmt(x.drain_seconds)]));
const families=[...new Set(d.scenarios.flatMap(x=>Object.keys(x.metrics)))];table('#latencies',['stage','family','n','p50 ms','p90 ms','p95 ms','p99 ms','max ms'],d.scenarios.flatMap(s=>families.filter(f=>s.metrics[f]).map(f=>{const m=s.metrics[f];return[s.name,f,m.sample_count,fmt(m.p50_ms),fmt(m.p90_ms),fmt(m.p95_ms),fmt(m.p99_ms),fmt(m.maximum_ms)]})));
table('#correctness',['gate','result','evidence'],d.correctness.map(x=>[x.name,`<strong class="${x.passed?'pass':'fail'}">${x.passed?'PASS':'FAIL'}</strong>`,x.evidence]));
table('#failures',['cut','injection','observed recovery','invariant','result','samples'],d.failure_matrix.map(x=>[x.cut,x.injection,x.observed_recovery,x.invariant,`<strong class="${x.passed?'pass':'fail'}">${x.passed?'PASS':'FAIL'}</strong>`,x.samples_ms.length]));
table('#environment',['component','value'],Object.entries(d.environment));document.querySelector('#notes').innerHTML=d.notes.map(x=>`<li>${x}</li>`).join('');
const drawCapacity=(id,stages)=>{const c=document.querySelector(id),ctx=c.getContext('2d'),pad=50,w=c.width-pad*2,h=c.height-pad*2,maxRate=Math.max(1,...stages.map(x=>x.completed_per_second)),maxP99=Math.max(1,...stages.map(x=>x.metrics.end_to_end_journey?.p99_ms||0));ctx.strokeStyle='#253853';ctx.lineWidth=1;for(let i=0;i<5;i++){const y=pad+h*i/4;ctx.beginPath();ctx.moveTo(pad,y);ctx.lineTo(pad+w,y);ctx.stroke()}const draw=(color,get,max)=>{ctx.strokeStyle=color;ctx.lineWidth=3;ctx.beginPath();stages.forEach((s,i)=>{const x=pad+(stages.length===1?0:w*i/(stages.length-1)),y=pad+h-h*get(s)/max;i?ctx.lineTo(x,y):ctx.moveTo(x,y);ctx.fillStyle=color;ctx.fillRect(x-3,y-3,6,6)});ctx.stroke()};draw('#62a8ff',x=>x.completed_per_second,maxRate);draw('#ffc857',x=>x.metrics.end_to_end_journey?.p99_ms||0,maxP99);ctx.fillStyle='#9db0c9';ctx.font='12px ui-monospace';stages.forEach((s,i)=>{const x=pad+(stages.length===1?0:w*i/(stages.length-1));ctx.save();ctx.translate(x,c.height-8);ctx.rotate(-.35);ctx.fillText(s.name,0,0);ctx.restore()})};
const loadStages=d.scenarios.filter(x=>x.offered>=100&&x.offered_per_second>0),profile=String(d.environment['database-profile']||'').replace(/[^a-z0-9]/gi,'').toLowerCase(),cloudProfile=profile.includes('cloudsql'),cloudStages=loadStages.filter(x=>cloudProfile||x.name.startsWith('cloud-')),localStages=loadStages.filter(x=>!cloudProfile&&!x.name.startsWith('cloud-'));document.querySelector('#local-capacity-panel').hidden=!localStages.length;document.querySelector('#cloud-capacity-panel').hidden=!cloudStages.length;drawCapacity('#local-capacity',localStages);drawCapacity('#cloud-capacity',cloudStages);
const metricPoints=name=>(t.series?.[name]||[]).flatMap(series=>(series.values||[]).map(([at,value])=>[Number(at),Number(value)])).filter(([,value])=>Number.isFinite(value)).sort((a,b)=>a[0]-b[0]);
const drawTimeSeries=(id,lines,unit)=>{const c=document.querySelector(id),ctx=c.getContext('2d'),all=lines.flatMap(x=>x.points);if(!all.length){ctx.fillStyle='#9db0c9';ctx.font='13px ui-monospace';ctx.fillText('No frozen samples for this panel',24,40);return}const pad={l:58,r:16,t:18,b:34},w=c.width-pad.l-pad.r,h=c.height-pad.t-pad.b,minX=Math.min(...all.map(x=>x[0])),maxX=Math.max(...all.map(x=>x[0])),maxY=Math.max(1e-9,...all.map(x=>x[1]));ctx.strokeStyle='#253853';ctx.fillStyle='#9db0c9';ctx.font='11px ui-monospace';for(let i=0;i<5;i++){const y=pad.t+h*i/4,value=maxY*(1-i/4);ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(pad.l+w,y);ctx.stroke();ctx.fillText(`${fmt(value)}${unit}`,4,y+4)}lines.forEach(line=>{ctx.strokeStyle=line.color;ctx.lineWidth=2;ctx.beginPath();line.points.forEach(([at,value],i)=>{const x=pad.l+w*(at-minX)/Math.max(1,maxX-minX),y=pad.t+h-h*value/maxY;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke()});ctx.fillStyle='#9db0c9';ctx.fillText('start',pad.l,c.height-10);ctx.fillText(`${fmt(maxX-minX)}s`,c.width-64,c.height-10)};
const colors={blue:'#62a8ff',green:'#38d996',amber:'#ffc857',violet:'#be8cff'};
drawTimeSeries('#traffic-telemetry',[{color:colors.blue,points:metricPoints('offered_rate')},{color:colors.green,points:metricPoints('accepted_rate')},{color:colors.amber,points:metricPoints('completed_rate')}],'');
drawTimeSeries('#utilization-telemetry',[{color:colors.blue,points:metricPoints('runner_cpu_utilization').map(([x,y])=>[x,y*100])},{color:colors.green,points:metricPoints('cloud_sql_cpu_utilization').map(([x,y])=>[x,y*100])},{color:colors.amber,points:metricPoints('temporal_cloud_action_utilization').map(([x,y])=>[x,y*100])}],'%');
const samplePoints=field=>d.scenarios.flatMap(stage=>stage.samples.map(sample=>[stage.started_at_unix_milliseconds/1000+sample.elapsed_seconds,Number(sample[field]||0)]));
drawTimeSeries('#backlog-telemetry',[{color:colors.blue,points:samplePoints('pending')},{color:colors.amber,points:samplePoints('waiting')},{color:colors.violet,points:samplePoints('running')}],'');
drawTimeSeries('#temporal-telemetry',[{color:colors.blue,points:metricPoints('temporal_cloud_service_p99')},{color:colors.amber,points:metricPoints('temporal_sdk_workflow_queue_p99')},{color:colors.violet,points:metricPoints('temporal_cloud_backlog')}],'');
const telemetrySummary=t.summary||{},queryCount=Number(telemetrySummary.query_count||0),successfulQueries=Number(telemetrySummary.successful_queries||0);document.querySelector('#telemetry-status').textContent=queryCount?`Telemetry queries: ${successfulQueries} / ${queryCount}. Required targets healthy: ${(telemetrySummary.healthy_jobs||[]).length} / ${(telemetrySummary.required_jobs||[]).length}. Frozen range: ${fmt((telemetrySummary.range_end_unix_seconds||0)-(telemetrySummary.range_start_unix_seconds||0))}s.`:'No frozen dependency query set is embedded in this report.';
</script></body></html>"#;

#[cfg(test)]
mod tests {
    use super::{
        EvidenceBundle, EvidenceManifest, merge_bundles, merge_frozen_telemetry, render_dashboard,
        render_dashboard_with_telemetry,
    };

    #[test]
    fn manifest_rejects_a_stage_without_enough_samples_for_p99() {
        let input = r#"{
          "schema_version": 2,
          "seed": 130013,
          "question": "Where is the tested capacity knee?",
          "stages": [{
            "name": "too-small",
            "workload": "steady",
            "arrival_pattern": "uniform",
            "offered_per_second": 5.0,
            "duration_seconds": 10,
            "worker_count": 8,
            "persistence_profile": "cold"
          }]
        }"#;

        let error = EvidenceManifest::from_json(input).unwrap_err();

        assert!(error.to_string().contains("at least 100 samples"));
    }

    #[test]
    fn dashboard_is_self_contained_and_names_every_stage() {
        let bundle = EvidenceBundle::example();

        let html = render_dashboard(&bundle).unwrap();

        assert!(html.starts_with("<!doctype html>"));
        assert!(html.contains("warm-up"));
        assert!(html.contains("window.OSFO_EVIDENCE"));
        assert!(!html.contains("https://"));
        assert!(!html.contains("src=\"/"));
        assert!(html.contains("\"confirmation_verdict\":null"));
        assert!(html.contains("Evidence validity"));
        assert!(html.contains("MISSING"));
        assert!(html.contains("x.offered>=100&&x.offered_per_second>0"));
    }

    #[test]
    fn dashboard_embeds_frozen_dependency_time_series() {
        let bundle = EvidenceBundle::example();
        let telemetry = serde_json::json!({
            "summary": {"query_count": 69, "successful_queries": 69, "complete": true},
            "cost": {
                "summary": {
                    "gcp_known_catalog_estimate": 24.14522,
                    "temporal_actions_first_tier_list_rate_equivalent": 10.899819,
                    "combined_actual_invoice_status": "MISSING"
                }
            },
            "series": {
                "runner_cpu_utilization": [{
                    "metric": {},
                    "values": [[1785785995.0, "0.81"], [1785785996.0, "0.83"]]
                }]
            }
        });

        let html = render_dashboard_with_telemetry(&bundle, &telemetry).unwrap();

        assert!(html.contains("window.OSFO_TELEMETRY"));
        assert!(html.contains("runner_cpu_utilization"));
        assert!(html.contains("Frozen dependency telemetry"));
        assert!(html.contains("Cost evidence"));
        assert!(html.contains("combined_actual_invoice_status"));
        assert!(html.contains("\"query_count\":69"));
        assert!(html.contains("Telemetry queries:"));
    }

    #[test]
    fn frozen_telemetry_merge_preserves_every_run_and_query_series() {
        let first = serde_json::json!({
            "summary": {
                "query_count": 2,
                "successful_queries": 2,
                "complete": true,
                "range_start_unix_seconds": 10.0,
                "range_end_unix_seconds": 20.0,
                "required_jobs": ["runner"],
                "healthy_jobs": ["runner"]
            },
            "series": {"runner_cpu_utilization": [{"values": [[10, "0.5"]]}]}
        });
        let second = serde_json::json!({
            "summary": {
                "query_count": 2,
                "successful_queries": 2,
                "complete": true,
                "range_start_unix_seconds": 30.0,
                "range_end_unix_seconds": 40.0,
                "required_jobs": ["runner", "temporal-cloud"],
                "healthy_jobs": ["runner", "temporal-cloud"]
            },
            "series": {"runner_cpu_utilization": [{"values": [[30, "0.8"]]}]}
        });

        let merged = merge_frozen_telemetry(vec![first, second]);

        assert_eq!(merged["summary"]["run_count"], 2);
        assert_eq!(merged["summary"]["query_count"], 4);
        assert_eq!(merged["summary"]["successful_queries"], 4);
        assert_eq!(merged["summary"]["range_start_unix_seconds"], 10.0);
        assert_eq!(merged["summary"]["range_end_unix_seconds"], 40.0);
        assert_eq!(
            merged["series"]["runner_cpu_utilization"]
                .as_array()
                .expect("merged series")
                .len(),
            2
        );
        assert_eq!(merged["runs"].as_array().expect("run summaries").len(), 2);
    }

    #[test]
    fn merge_cannot_claim_issue_acceptance_without_cloud_and_every_failure_cut() {
        let merged = merge_bundles(vec![EvidenceBundle::example()]);

        assert!(
            merged
                .correctness
                .iter()
                .any(|check| check.name == "Cloud SQL topology exercised" && !check.passed)
        );
        assert!(
            merged
                .correctness
                .iter()
                .any(|check| check.name == "full issue 13 failure matrix" && !check.passed)
        );
    }

    #[test]
    fn merge_recognizes_the_deployed_cloud_sql_profile_name() {
        let mut bundle = EvidenceBundle::example();
        bundle.environment.insert(
            "database-profile".into(),
            "Cloud_SQL_PostgreSQL_same-region_confirmation".into(),
        );

        let merged = merge_bundles(vec![bundle]);

        assert!(
            merged
                .correctness
                .iter()
                .any(|check| check.name == "Cloud SQL topology exercised" && check.passed)
        );
    }
}
