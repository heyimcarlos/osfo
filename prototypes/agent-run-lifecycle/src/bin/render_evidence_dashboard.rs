use std::{env, fs, path::PathBuf};

use anyhow::{Context, Result};
use osfo_agent_run_lifecycle_prototype::evidence::{
    EvidenceBundle, load_frozen_telemetry, render_dashboard_with_telemetry,
};

fn main() -> Result<()> {
    let evidence_dir = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .context("usage: render_evidence_dashboard EVIDENCE_DIR")?;
    let bundle: EvidenceBundle =
        serde_json::from_slice(&fs::read(evidence_dir.join("results.json"))?)?;
    let telemetry = load_frozen_telemetry(&evidence_dir)?;
    fs::write(
        evidence_dir.join("dashboard.html"),
        render_dashboard_with_telemetry(&bundle, &telemetry)?,
    )?;
    Ok(())
}
