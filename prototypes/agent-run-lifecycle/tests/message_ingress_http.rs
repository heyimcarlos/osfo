use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use osfo_agent_run_lifecycle_prototype::{
    PostgresLifecycle, RunId, ingress::PostgresMessageStore, ingress_http,
};
use tower::ServiceExt;

static DATABASE_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn database_url() -> String {
    osfo_agent_run_lifecycle_prototype::load_local_environment();
    std::env::var("OSFO_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@127.0.0.1:55432/osfo_lifecycle".into())
}

#[tokio::test]
async fn bearer_identity_scopes_message_admission_and_replay() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    let reset_url = url.clone();
    tokio::task::spawn_blocking(move || {
        PostgresLifecycle::connect(&reset_url)
            .expect("connect lifecycle")
            .reset()
            .expect("reset schema");
    })
    .await
    .expect("reset worker");
    let app = ingress_http::app(&url, "account-a", "test-token", 4)
        .await
        .expect("build app");

    let unauthorized = app
        .clone()
        .oneshot(
            Request::post("/v1/threads/thread-a/messages")
                .header("content-type", "application/json")
                .header("idempotency-key", "idem-http-1")
                .body(Body::from(
                    r#"{"message_id":"message-1","content":"hello"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("unauthorized response");
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let admitted = app
        .clone()
        .oneshot(
            Request::post("/v1/threads/thread-a/messages")
                .header("x-osfo-ingress-token", "test-token")
                .header("content-type", "application/json")
                .header("idempotency-key", "idem-http-1")
                .body(Body::from(
                    r#"{"message_id":"message-1","content":"hello"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("admission response");
    assert_eq!(admitted.status(), StatusCode::CREATED);

    let replayed = app
        .oneshot(
            Request::get("/v1/threads/thread-a/events?after=0&limit=100")
                .header("authorization", "Bearer test-token")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("replay response");
    assert_eq!(replayed.status(), StatusCode::OK);
    let body = replayed
        .into_body()
        .collect()
        .await
        .expect("collect body")
        .to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).expect("response JSON");
    assert_eq!(json["events"][0]["sequence"], 1);
    assert_eq!(json["events"][0]["event_type"], "user.message.accepted");
}

#[tokio::test]
async fn sse_stream_resumes_from_the_durable_sequence_cursor() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    let reset_url = url.clone();
    tokio::task::spawn_blocking(move || {
        PostgresLifecycle::connect(&reset_url)
            .expect("connect lifecycle")
            .reset()
            .expect("reset schema");
    })
    .await
    .expect("reset worker");
    let app = ingress_http::app(&url, "account-a", "test-token", 4)
        .await
        .expect("build app");
    let admitted = app
        .clone()
        .oneshot(
            Request::post("/v1/threads/thread-a/messages")
                .header("authorization", "Bearer test-token")
                .header("content-type", "application/json")
                .header("idempotency-key", "idem-stream-1")
                .body(Body::from(
                    r#"{"message_id":"message-stream-1","content":"hello"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("admission response");
    assert_eq!(admitted.status(), StatusCode::CREATED);

    let streamed = app
        .oneshot(
            Request::get("/v1/threads/thread-a/stream?after=0")
                .header("authorization", "Bearer test-token")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("stream response");
    assert_eq!(streamed.status(), StatusCode::OK);
    assert_eq!(streamed.headers()["content-type"], "text/event-stream");
    let frame = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        streamed.into_body().frame(),
    )
    .await
    .expect("first SSE frame timeout")
    .expect("first SSE frame")
    .expect("valid SSE frame");
    let data = frame.into_data().expect("SSE data frame");
    let text = std::str::from_utf8(&data).expect("UTF-8 SSE frame");
    assert!(text.contains("id: 1"));
    assert!(text.contains("event: user.message.accepted"));
}

#[tokio::test]
async fn sse_stream_can_close_after_the_matching_run_completes() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    let reset_url = url.clone();
    tokio::task::spawn_blocking(move || {
        PostgresLifecycle::connect(&reset_url)
            .expect("connect lifecycle")
            .reset()
            .expect("reset schema");
    })
    .await
    .expect("reset worker");
    let app = ingress_http::app(&url, "account-a", "test-token", 4)
        .await
        .expect("build app");
    let admitted = app
        .clone()
        .oneshot(
            Request::post("/v1/threads/thread-terminal/messages")
                .header("authorization", "Bearer test-token")
                .header("content-type", "application/json")
                .header("idempotency-key", "idem-terminal-1")
                .body(Body::from(
                    r#"{"message_id":"message-terminal-1","content":"hello"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("admission response");
    let receipt = admitted
        .into_body()
        .collect()
        .await
        .expect("collect receipt")
        .to_bytes();
    let receipt: serde_json::Value = serde_json::from_slice(&receipt).expect("receipt JSON");
    let run_id = receipt["run_id"].as_str().expect("run ID").to_owned();
    let event_sequence = receipt["event_sequence"].as_u64().expect("event sequence");

    let store = PostgresMessageStore::connect(&url, 2).expect("connect message store");
    let claimed = store
        .claim_next("test-worker", std::time::Duration::from_secs(30))
        .await
        .expect("claim query")
        .expect("claimed run");
    assert_eq!(claimed.run_id, RunId::from(run_id.as_str()));
    store
        .commit_assistant_output(&claimed.run_id, claimed.claim_epoch, "done")
        .await
        .expect("complete run");

    let streamed = app
        .oneshot(
            Request::get(format!(
                "/v1/threads/thread-terminal/stream?after={event_sequence}&until_run_id={run_id}"
            ))
            .header("authorization", "Bearer test-token")
            .body(Body::empty())
            .expect("request"),
        )
        .await
        .expect("stream response");
    let body = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        streamed.into_body().collect(),
    )
    .await
    .expect("terminal SSE stream did not close")
    .expect("collect terminal stream")
    .to_bytes();
    let text = std::str::from_utf8(&body).expect("UTF-8 SSE body");
    assert!(text.contains("event: assistant.message.completed"));
    assert!(text.contains(&run_id));
}

#[tokio::test]
async fn authenticated_run_evidence_reports_database_owned_amplification() {
    let _database_guard = DATABASE_TEST_LOCK.lock().await;
    let url = database_url();
    let reset_url = url.clone();
    tokio::task::spawn_blocking(move || {
        PostgresLifecycle::connect(&reset_url)
            .expect("connect lifecycle")
            .reset()
            .expect("reset schema");
    })
    .await
    .expect("reset worker");
    let app = ingress_http::app(&url, "account-a", "test-token", 4)
        .await
        .expect("build app");
    let admitted = app
        .clone()
        .oneshot(
            Request::post("/v1/threads/thread-evidence/messages")
                .header("authorization", "Bearer test-token")
                .header("content-type", "application/json")
                .header("idempotency-key", "idem-evidence-1")
                .body(Body::from(
                    r#"{"message_id":"message-evidence-1","content":"hello"}"#,
                ))
                .expect("request"),
        )
        .await
        .expect("admission response");
    let body = admitted
        .into_body()
        .collect()
        .await
        .expect("collect admission")
        .to_bytes();
    let receipt: serde_json::Value = serde_json::from_slice(&body).expect("receipt JSON");
    let run_id = receipt["run_id"].as_str().expect("run ID");

    let evidence = app
        .oneshot(
            Request::get(format!("/v1/agent-runs/{run_id}/evidence"))
                .header("authorization", "Bearer test-token")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("evidence response");
    assert_eq!(evidence.status(), StatusCode::OK);
    let body = evidence
        .into_body()
        .collect()
        .await
        .expect("collect evidence")
        .to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).expect("evidence JSON");
    assert_eq!(json["root_state"], "pending");
    assert_eq!(json["total_agent_runs"], 1);
    assert_eq!(json["child_agent_runs"], 0);
    assert_eq!(json["thread_events"], 1);
}
