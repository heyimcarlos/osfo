use anyhow::{Result, bail};
#[cfg(feature = "lifecycle-evidence")]
use rig_agent::{
    core::{client::CompletionClient, providers::openai},
    extractor::ExtractorBuilder,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[cfg(feature = "lifecycle-evidence")]
use serde_json::json;

#[cfg(feature = "lifecycle-evidence")]
use crate::rig_lane::{DEFAULT_OPENROUTER_MODEL, OPENROUTER_API_BASE_URL};

pub const REASONING_EFFORT: &str = "medium";
pub const DISCOVERY_PROMPT_VERSION: &str = "osfo-agent-decision-v1";
pub const MAX_DECISION_ATTEMPTS: u64 = 2;
pub const AGENT_DECISION_PREAMBLE: &str = "Act as the Osfo root agent planner. Decide the smallest work graph needed for the synthetic user message. A quick reply is a root response with no delegation, workflow, approval, or tool. Child agents are Osfo AgentRuns, never Temporal child workflows. Use Temporal only for durable multi-step work, waits, approvals, retries, proactive delivery, or schedules. Count each external action as a tool call and each Temporal activity separately. Do not invent work to make the graph look agentic.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiscoveryCase {
    pub label: &'static str,
    pub message: &'static str,
}

pub fn synthetic_discovery_corpus() -> Vec<DiscoveryCase> {
    vec![
        DiscoveryCase {
            label: "quick-conversation",
            message: "Say hello and tell me one short joke.",
        },
        DiscoveryCase {
            label: "quick-factual-answer",
            message: "What is the capital of Canada? Answer in one sentence.",
        },
        DiscoveryCase {
            label: "clarification",
            message: "Book it for next week.",
        },
        DiscoveryCase {
            label: "research-zero-child",
            message: "Explain in two sentences why PostgreSQL SKIP LOCKED helps queue consumers. Do not browse or delegate.",
        },
        DiscoveryCase {
            label: "research-one-child",
            message: "Delegate one focused research task to compare two durable workflow engines, then summarize the result after it returns.",
        },
        DiscoveryCase {
            label: "research-many-children",
            message: "Prepare a market comparison across four independent product categories. Use one research child per category, await all of them, then synthesize a short report.",
        },
        DiscoveryCase {
            label: "awaited-child",
            message: "Ask a specialist child agent to inspect a synthetic error log and wait for its diagnosis before replying.",
        },
        DiscoveryCase {
            label: "detached-child",
            message: "Start a background child agent to organize a synthetic reading list. Acknowledge immediately and let the child finish independently.",
        },
        DiscoveryCase {
            label: "multi-step-workflow",
            message: "Run a durable three-step workflow: gather a synthetic inventory snapshot, validate it, then publish a summary. Retry transient failures.",
        },
        DiscoveryCase {
            label: "approval-gated-email",
            message: "Draft a synthetic project update, request my approval, and only after approval send it to the local Mailpit test inbox.",
        },
        DiscoveryCase {
            label: "scheduled-reminder",
            message: "Remind me tomorrow at 9 AM to review the synthetic benchmark report.",
        },
        DiscoveryCase {
            label: "recurring-work",
            message: "Every weekday at 9 AM, check a synthetic status feed and proactively tell me only when its state changes.",
        },
        DiscoveryCase {
            label: "sandbox-artifact",
            message: "Use a sandbox to create a small CSV from synthetic rows and save it as a downloadable artifact.",
        },
        DiscoveryCase {
            label: "proactive-message",
            message: "Watch a synthetic build until it completes and proactively notify me with the final status.",
        },
    ]
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum DecisionClass {
    DirectReply,
    Clarification,
    Research,
    DurableWorkflow,
    ExternalEffect,
    ScheduledWork,
    SandboxWork,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[schemars(deny_unknown_fields)]
pub struct AgentDecision {
    /// The dominant reason this work graph was selected.
    pub decision_class: DecisionClass,
    /// True only for a quick user-visible response with no delegated work.
    pub quick_reply: bool,
    /// Total Osfo child AgentRuns created by the root AgentRun.
    pub child_agent_runs: u16,
    /// Child AgentRuns whose results the root must await before replying.
    pub awaited_child_agent_runs: u16,
    /// Child AgentRuns allowed to complete independently after the root replies.
    pub detached_child_agent_runs: u16,
    /// Durable Temporal workflows started by this root decision. One scheduled reminder requires one Temporal workflow.
    pub temporal_workflows: u16,
    /// External or non-deterministic Temporal activities scheduled by those workflows.
    pub temporal_activities: u16,
    /// Human approval decisions required before external effects execute.
    pub approvals: u16,
    /// External actions selected by the agent. One approval-gated external action counts as one tool call.
    pub tool_calls: u16,
    /// Messages delivered later without a new incoming user message.
    pub proactive_messages: u16,
    /// One-time durable reminders scheduled for future delivery.
    pub scheduled_reminders: u16,
    /// Isolated sandbox executions requested by the agent.
    pub sandbox_jobs: u16,
    /// Immutable artifact objects committed from this work graph.
    pub artifact_commits: u16,
}

#[derive(Clone, Copy)]
struct WeightedDecision {
    weight: u64,
    decision: AgentDecision,
}

#[allow(clippy::too_many_arguments)]
const fn recipe(
    decision_class: DecisionClass,
    quick_reply: bool,
    child_agent_runs: u16,
    awaited_child_agent_runs: u16,
    detached_child_agent_runs: u16,
    temporal_workflows: u16,
    temporal_activities: u16,
    approvals: u16,
    tool_calls: u16,
    proactive_messages: u16,
    scheduled_reminders: u16,
    sandbox_jobs: u16,
    artifact_commits: u16,
) -> AgentDecision {
    AgentDecision {
        decision_class,
        quick_reply,
        child_agent_runs,
        awaited_child_agent_runs,
        detached_child_agent_runs,
        temporal_workflows,
        temporal_activities,
        approvals,
        tool_calls,
        proactive_messages,
        scheduled_reminders,
        sandbox_jobs,
        artifact_commits,
    }
}

const RECORDED_LUNA_DISTRIBUTION: [WeightedDecision; 13] = [
    WeightedDecision {
        weight: 12,
        decision: recipe(
            DecisionClass::DirectReply,
            true,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 3,
        decision: recipe(
            DecisionClass::DurableWorkflow,
            false,
            0,
            0,
            0,
            1,
            3,
            0,
            0,
            0,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 5,
        decision: recipe(
            DecisionClass::ScheduledWork,
            false,
            0,
            0,
            0,
            1,
            1,
            0,
            0,
            1,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 1,
        decision: recipe(
            DecisionClass::DurableWorkflow,
            false,
            0,
            0,
            0,
            1,
            2,
            0,
            0,
            1,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 2,
        decision: recipe(
            DecisionClass::ScheduledWork,
            false,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            1,
            1,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 1,
        decision: recipe(
            DecisionClass::ScheduledWork,
            false,
            0,
            0,
            0,
            1,
            1,
            0,
            0,
            1,
            1,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 3,
        decision: recipe(
            DecisionClass::Research,
            false,
            1,
            0,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 6,
        decision: recipe(
            DecisionClass::Research,
            false,
            1,
            1,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 3,
        decision: recipe(
            DecisionClass::Research,
            false,
            4,
            4,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 3,
        decision: recipe(
            DecisionClass::SandboxWork,
            false,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            1,
            1,
        ),
    },
    WeightedDecision {
        weight: 1,
        decision: recipe(
            DecisionClass::ExternalEffect,
            false,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
            0,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 1,
        decision: recipe(
            DecisionClass::ExternalEffect,
            false,
            0,
            0,
            0,
            1,
            0,
            1,
            1,
            0,
            0,
            0,
            0,
        ),
    },
    WeightedDecision {
        weight: 1,
        decision: recipe(
            DecisionClass::ExternalEffect,
            false,
            0,
            0,
            0,
            1,
            1,
            1,
            1,
            0,
            0,
            0,
            1,
        ),
    },
];

pub fn measured_replay_decision(ordinal: u64) -> AgentDecision {
    let mut slot = ordinal % 42;
    for weighted in RECORDED_LUNA_DISTRIBUTION {
        if slot < weighted.weight {
            return weighted.decision;
        }
        slot -= weighted.weight;
    }
    unreachable!("recorded Luna distribution has exactly 42 samples")
}

impl AgentDecision {
    pub fn validate(&self) -> Result<()> {
        if self.awaited_child_agent_runs + self.detached_child_agent_runs > self.child_agent_runs {
            bail!("awaited and detached children exceed total child AgentRuns");
        }
        if self.quick_reply
            && (self.child_agent_runs > 0
                || self.temporal_workflows > 0
                || self.approvals > 0
                || self.tool_calls > 0)
        {
            bail!("a quick reply cannot delegate workflows, children, approvals, or tools");
        }
        if self.approvals > self.tool_calls {
            bail!("approvals exceed tool calls");
        }
        if self.temporal_activities > 0 && self.temporal_workflows == 0 {
            bail!("Temporal activities require a Temporal workflow");
        }
        if self.scheduled_reminders > self.temporal_workflows {
            bail!("scheduled reminders exceed Temporal workflows");
        }
        if self.child_agent_runs > 63 {
            bail!("a root decision exceeds the prototype's 64 AgentRun graph bound");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiscoverySummary {
    pub messages: u64,
    pub quick_replies: u64,
    pub root_agent_runs: u64,
    pub child_agent_runs: u64,
    pub total_agent_runs: u64,
    pub awaited_child_agent_runs: u64,
    pub detached_child_agent_runs: u64,
    pub temporal_workflows: u64,
    pub temporal_activities: u64,
    pub approvals: u64,
    pub tool_calls: u64,
    pub proactive_messages: u64,
    pub scheduled_reminders: u64,
    pub sandbox_jobs: u64,
    pub artifact_commits: u64,
    pub total_agent_runs_per_message: f64,
    pub temporal_workflows_per_message: f64,
}

impl DiscoverySummary {
    pub fn from_decisions(decisions: &[AgentDecision]) -> Result<Self> {
        for decision in decisions {
            decision.validate()?;
        }
        let messages = decisions.len() as u64;
        let child_agent_runs = decisions
            .iter()
            .map(|decision| u64::from(decision.child_agent_runs))
            .sum::<u64>();
        let root_agent_runs = messages;
        let total_agent_runs = root_agent_runs + child_agent_runs;
        let temporal_workflows = decisions
            .iter()
            .map(|decision| u64::from(decision.temporal_workflows))
            .sum::<u64>();
        let per_message = |value| {
            if messages == 0 {
                0.0
            } else {
                value as f64 / messages as f64
            }
        };
        Ok(Self {
            messages,
            quick_replies: decisions
                .iter()
                .filter(|decision| decision.quick_reply)
                .count() as u64,
            root_agent_runs,
            child_agent_runs,
            total_agent_runs,
            awaited_child_agent_runs: sum(decisions, |decision| decision.awaited_child_agent_runs),
            detached_child_agent_runs: sum(decisions, |decision| {
                decision.detached_child_agent_runs
            }),
            temporal_workflows,
            temporal_activities: sum(decisions, |decision| decision.temporal_activities),
            approvals: sum(decisions, |decision| decision.approvals),
            tool_calls: sum(decisions, |decision| decision.tool_calls),
            proactive_messages: sum(decisions, |decision| decision.proactive_messages),
            scheduled_reminders: sum(decisions, |decision| decision.scheduled_reminders),
            sandbox_jobs: sum(decisions, |decision| decision.sandbox_jobs),
            artifact_commits: sum(decisions, |decision| decision.artifact_commits),
            total_agent_runs_per_message: per_message(total_agent_runs),
            temporal_workflows_per_message: per_message(temporal_workflows),
        })
    }
}

fn sum(decisions: &[AgentDecision], field: impl Fn(&AgentDecision) -> u16) -> u64 {
    decisions
        .iter()
        .map(|decision| u64::from(field(decision)))
        .sum()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LiveAgentDecisionReport {
    pub model: String,
    pub reasoning_effort: String,
    pub decision: AgentDecision,
    pub provider_calls: u64,
    pub validation_retries: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub latency_milliseconds: f64,
}

#[cfg(feature = "lifecycle-evidence")]
pub async fn run_live_agent_decision(
    model: Option<&str>,
    synthetic_message: &str,
) -> Result<LiveAgentDecisionReport> {
    let model = model.unwrap_or(DEFAULT_OPENROUTER_MODEL);
    let api_key = std::env::var("OPENROUTER_API_KEY")?;
    let client = openai::CompletionsClient::builder()
        .api_key(api_key)
        .base_url(OPENROUTER_API_BASE_URL)
        .build()?;
    let extractor = ExtractorBuilder::<_, AgentDecision>::new(client.completion_model(model))
        .preamble(AGENT_DECISION_PREAMBLE)
        .additional_params(json!({
            "reasoning": {"effort": REASONING_EFFORT, "exclude": true},
            "provider": {"require_parameters": true},
            "seed": 130013
        }))
        .max_tokens(2_000)
        .retries(0)
        .build();
    let started = std::time::Instant::now();
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut reasoning_tokens = 0;
    let mut total_tokens = 0;
    let mut prompt = synthetic_message.to_owned();
    for attempt in 0..MAX_DECISION_ATTEMPTS {
        let response = extractor.extract_with_usage(prompt.clone()).await?;
        input_tokens += response.usage.input_tokens;
        output_tokens += response.usage.output_tokens;
        reasoning_tokens += response.usage.reasoning_tokens;
        total_tokens += response.usage.total_tokens;
        match response.data.validate() {
            Ok(()) => {
                return Ok(LiveAgentDecisionReport {
                    model: model.to_owned(),
                    reasoning_effort: REASONING_EFFORT.into(),
                    decision: response.data,
                    provider_calls: attempt + 1,
                    validation_retries: attempt,
                    input_tokens,
                    output_tokens,
                    reasoning_tokens,
                    total_tokens,
                    latency_milliseconds: started.elapsed().as_secs_f64() * 1_000.0,
                });
            }
            Err(error) if attempt + 1 < MAX_DECISION_ATTEMPTS => {
                prompt = format!(
                    "{synthetic_message}\n\nThe previous typed plan failed this invariant: {error}. Return a corrected plan that satisfies every schema description."
                );
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("MAX_DECISION_ATTEMPTS is positive")
}
