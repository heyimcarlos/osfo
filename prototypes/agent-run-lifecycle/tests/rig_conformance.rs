use osfo_agent_run_lifecycle_prototype::rig_lane::{
    DEFAULT_OPENROUTER_MODEL, OPENROUTER_API_BASE_URL, RigLiveProvider, run_rig_mock_conformance,
};

#[tokio::test]
async fn rig_mock_model_maps_to_authority_free_runtime_result() {
    let report = run_rig_mock_conformance()
        .await
        .expect("run Rig conformance lane");

    assert_eq!(report.rig_version, "0.41.0");
    assert_eq!(report.output, "typed deterministic outcome");
    assert_eq!(report.model_requests, 1);
    assert!(!report.checkpoint_is_authority);
}

#[test]
fn openrouter_live_provider_uses_the_openai_compatible_chat_api() {
    assert_eq!(
        RigLiveProvider::OpenRouter.provider_name(),
        "OpenRouter Chat Completions API"
    );
    assert_eq!(
        RigLiveProvider::OpenRouter.api_base_url(),
        OPENROUTER_API_BASE_URL
    );
    assert_eq!(
        RigLiveProvider::OpenRouter.api_key_variable(),
        "OPENROUTER_API_KEY"
    );
    assert_eq!(DEFAULT_OPENROUTER_MODEL, "openai/gpt-5.6-luna");
}
