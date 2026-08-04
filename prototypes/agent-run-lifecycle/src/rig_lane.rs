use anyhow::Result;
use rig_agent::{
    AgentBuilder,
    core::{client::CompletionClient, providers::openai},
    test_utils::MockCompletionModel,
};

pub const OPENROUTER_API_BASE_URL: &str = "https://openrouter.ai/api/v1";
pub const DEFAULT_OPENROUTER_MODEL: &str = "openai/gpt-5.6-luna";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RigLiveProvider {
    OpenRouter,
}

impl RigLiveProvider {
    pub const fn provider_name(self) -> &'static str {
        match self {
            Self::OpenRouter => "OpenRouter Chat Completions API",
        }
    }

    pub const fn api_base_url(self) -> &'static str {
        match self {
            Self::OpenRouter => OPENROUTER_API_BASE_URL,
        }
    }

    pub const fn api_key_variable(self) -> &'static str {
        match self {
            Self::OpenRouter => "OPENROUTER_API_KEY",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RigConformanceReport {
    pub rig_version: String,
    pub output: String,
    pub model_requests: usize,
    pub checkpoint_is_authority: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RigLiveConformanceReport {
    pub rig_version: String,
    pub provider: String,
    pub model: String,
    pub output: String,
    pub checkpoint_is_authority: bool,
}

pub async fn run_rig_mock_conformance() -> Result<RigConformanceReport> {
    let model = MockCompletionModel::text("typed deterministic outcome");
    let response = AgentBuilder::new(model.clone())
        .preamble("Return the pinned deterministic fixture outcome.")
        .build()
        .runner("Execute fixture seed 130013")
        .max_turns(1)
        .run()
        .await?;

    Ok(RigConformanceReport {
        rig_version: "0.41.0".into(),
        output: response.output().to_owned(),
        model_requests: model.requests().len(),
        checkpoint_is_authority: false,
    })
}

pub async fn run_rig_live_conformance(
    provider: RigLiveProvider,
    model: &str,
) -> Result<RigLiveConformanceReport> {
    let api_key = std::env::var(provider.api_key_variable())?;
    let client = openai::CompletionsClient::builder()
        .api_key(api_key)
        .base_url(provider.api_base_url())
        .build()?;
    let response = AgentBuilder::new(client.completion_model(model))
        .preamble("Return exactly the requested conformance token with no other text.")
        .build()
        .runner("Return exactly OSFO_PROVIDER_OK")
        .max_turns(1)
        .run()
        .await?;

    Ok(RigLiveConformanceReport {
        rig_version: "0.41.0".into(),
        provider: provider.provider_name().into(),
        model: model.to_owned(),
        output: response.output().trim().to_owned(),
        checkpoint_is_authority: false,
    })
}
