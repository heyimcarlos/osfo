use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthThresholds {
    pub minimum_acceptance_ratio: f64,
    pub maximum_claim_p95_ms: f64,
    pub maximum_oldest_pending_ms: f64,
    pub maximum_error_ratio: f64,
}

impl Default for HealthThresholds {
    fn default() -> Self {
        Self {
            minimum_acceptance_ratio: 0.95,
            maximum_claim_p95_ms: 1_000.0,
            maximum_oldest_pending_ms: 2_000.0,
            maximum_error_ratio: 0.01,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageHealthInput {
    pub offered: u64,
    pub admitted: u64,
    pub errors: u64,
    pub offered_rps: f64,
    pub achieved_admission_rps: f64,
    pub claim_p95_ms: f64,
    pub oldest_pending_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StageVerdict {
    pub healthy: bool,
    pub reasons: Vec<String>,
}

pub fn classify_stage(input: &StageHealthInput, thresholds: &HealthThresholds) -> StageVerdict {
    let mut reasons = Vec::new();
    let acceptance_ratio = if input.offered == 0 {
        1.0
    } else {
        input.admitted as f64 / input.offered as f64
    };
    let error_ratio = if input.offered == 0 {
        0.0
    } else {
        input.errors as f64 / input.offered as f64
    };
    let throughput_ratio = if input.offered_rps == 0.0 {
        1.0
    } else {
        input.achieved_admission_rps / input.offered_rps
    };

    if acceptance_ratio < thresholds.minimum_acceptance_ratio {
        reasons.push(format!(
            "acceptance ratio {:.3} below {:.3}",
            acceptance_ratio, thresholds.minimum_acceptance_ratio
        ));
    }
    if throughput_ratio < thresholds.minimum_acceptance_ratio {
        reasons.push(format!(
            "achieved admission throughput {:.1}/s is {:.1}% of offered {:.1}/s",
            input.achieved_admission_rps,
            throughput_ratio * 100.0,
            input.offered_rps
        ));
    }
    if input.claim_p95_ms > thresholds.maximum_claim_p95_ms {
        reasons.push(format!(
            "claim p95 {:.1} ms above {:.1} ms",
            input.claim_p95_ms, thresholds.maximum_claim_p95_ms
        ));
    }
    if input.oldest_pending_ms > thresholds.maximum_oldest_pending_ms {
        reasons.push(format!(
            "oldest pending {:.1} ms above {:.1} ms",
            input.oldest_pending_ms, thresholds.maximum_oldest_pending_ms
        ));
    }
    if error_ratio > thresholds.maximum_error_ratio {
        reasons.push(format!(
            "error ratio {:.3} above {:.3}",
            error_ratio, thresholds.maximum_error_ratio
        ));
    }

    StageVerdict {
        healthy: reasons.is_empty(),
        reasons,
    }
}
