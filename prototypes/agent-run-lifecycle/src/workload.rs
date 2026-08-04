use crate::RunId;
use crate::confirmation::{JourneyMix, PrincipalMix};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum JourneyKind {
    BasicAgentRun,
    ChildFanout,
    AwaitedWorkflow,
    DetachedWorkflow,
    SandboxArtifact,
    ApprovalSmtp,
    FullReferenceJourney,
    MeasuredAgentDecision,
}

impl JourneyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BasicAgentRun => "basic-agent-run",
            Self::ChildFanout => "child-fanout",
            Self::AwaitedWorkflow => "awaited-workflow",
            Self::DetachedWorkflow => "detached-workflow",
            Self::SandboxArtifact => "sandbox-artifact",
            Self::ApprovalSmtp => "approval-smtp",
            Self::FullReferenceJourney => "full-reference-journey",
            Self::MeasuredAgentDecision => "measured-agent-decision",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "basic-agent-run" => Self::BasicAgentRun,
            "child-fanout" => Self::ChildFanout,
            "awaited-workflow" => Self::AwaitedWorkflow,
            "detached-workflow" => Self::DetachedWorkflow,
            "sandbox-artifact" => Self::SandboxArtifact,
            "approval-smtp" => Self::ApprovalSmtp,
            "full-reference-journey" => Self::FullReferenceJourney,
            "measured-agent-decision" => Self::MeasuredAgentDecision,
            _ => bail!("unsupported journey kind {value}"),
        })
    }
}

#[derive(Debug, Clone)]
pub struct WorkloadAdmission {
    pub idempotency_key: String,
    pub request_hash: String,
    pub principal_id: String,
    pub journey_kind: JourneyKind,
    pub persistence_profile: String,
    pub ordinal: u64,
}

impl WorkloadAdmission {
    pub fn new(
        idempotency_key: impl Into<String>,
        principal_id: impl Into<String>,
        journey_kind: JourneyKind,
        persistence_profile: impl Into<String>,
        ordinal: u64,
    ) -> Self {
        let idempotency_key = idempotency_key.into();
        Self {
            request_hash: format!("sha256:{idempotency_key}"),
            idempotency_key,
            principal_id: principal_id.into(),
            journey_kind,
            persistence_profile: persistence_profile.into(),
            ordinal,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AdmittedWorkload {
    pub run_id: RunId,
    pub idempotent_replay: bool,
}

#[derive(Debug, Clone)]
pub struct ClaimedWorkload {
    pub run_id: RunId,
    pub claim_epoch: u64,
    pub principal_id: String,
    pub journey_kind: JourneyKind,
    pub persistence_profile: String,
    pub ordinal: u64,
}

#[derive(Clone)]
pub struct WorkloadSelector {
    seed: u64,
    journey_mix: JourneyMix,
    principal_mix: PrincipalMix,
}

impl WorkloadSelector {
    pub fn new(seed: u64, journey_mix: JourneyMix, principal_mix: PrincipalMix) -> Self {
        Self {
            seed,
            journey_mix,
            principal_mix,
        }
    }

    pub fn journey(&self, ordinal: usize) -> JourneyKind {
        let slot = self.permuted_percentile(ordinal);
        let mut upper = usize::from(self.journey_mix.basic_agent_run_percent);
        if slot < upper {
            return JourneyKind::BasicAgentRun;
        }
        upper += usize::from(self.journey_mix.child_fanout_percent);
        if slot < upper {
            return JourneyKind::ChildFanout;
        }
        upper += usize::from(self.journey_mix.awaited_workflow_percent);
        if slot < upper {
            return JourneyKind::AwaitedWorkflow;
        }
        upper += usize::from(self.journey_mix.detached_workflow_percent);
        if slot < upper {
            return JourneyKind::DetachedWorkflow;
        }
        upper += usize::from(self.journey_mix.sandbox_artifact_percent);
        if slot < upper {
            return JourneyKind::SandboxArtifact;
        }
        upper += usize::from(self.journey_mix.approval_smtp_percent);
        if slot < upper {
            return JourneyKind::ApprovalSmtp;
        }
        JourneyKind::FullReferenceJourney
    }

    pub fn principal(&self, ordinal: usize) -> String {
        let slot = self.permuted_percentile(ordinal);
        if slot < usize::from(self.principal_mix.noisy_percent) {
            return "noisy".into();
        }
        let quiet_slot = slot - usize::from(self.principal_mix.noisy_percent);
        format!(
            "quiet-{}",
            quiet_slot % self.principal_mix.quiet_principal_count + 1
        )
    }

    fn permuted_percentile(&self, ordinal: usize) -> usize {
        ((ordinal % 100) * 37 + self.seed as usize % 100) % 100
    }
}
