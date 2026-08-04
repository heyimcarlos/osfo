use std::{collections::VecDeque, convert::Infallible, sync::Arc, time::Duration};

use anyhow::Result;
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response, Sse, sse::Event},
    routing::{get, post},
};
use futures_util::{Stream, future::poll_fn, stream};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use tokio_postgres::AsyncMessage;

use crate::{
    ingress::{MessageAdmission, MessageReceipt, PostgresMessageStore, ThreadEvent},
    workload::JourneyKind,
};

#[derive(Clone)]
struct AppState {
    store: PostgresMessageStore,
    auth: Arc<AccountAuthenticator>,
    notifications: broadcast::Sender<String>,
}

struct AccountAuthenticator {
    account_id: String,
    token_digest: [u8; 32],
}

#[derive(Debug, Deserialize)]
struct MessageBody {
    message_id: String,
    content: String,
    journey_kind: Option<JourneyKind>,
}

#[derive(Debug, Deserialize)]
struct ReplayQuery {
    #[serde(default)]
    after: u64,
    #[serde(default = "default_replay_limit")]
    limit: usize,
    #[serde(default)]
    until_run_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReplayResponse {
    events: Vec<ThreadEvent>,
    next_cursor: u64,
}

pub async fn app(
    database_url: &str,
    account_id: &str,
    bearer_token: &str,
    pool_size: u32,
) -> Result<Router> {
    if account_id.trim().is_empty() || bearer_token.trim().is_empty() {
        anyhow::bail!("ingress account identity and bearer token are required");
    }
    if pool_size == 0 {
        anyhow::bail!("ingress database pool size must be positive");
    }
    let (notifications, _) = broadcast::channel(4_096);
    tokio::spawn(notification_listener(
        database_url.to_owned(),
        notifications.clone(),
    ));
    let state = AppState {
        store: PostgresMessageStore::connect(database_url, pool_size as usize)?,
        auth: Arc::new(AccountAuthenticator {
            account_id: account_id.into(),
            token_digest: digest(bearer_token.as_bytes()),
        }),
        notifications,
    };
    Ok(Router::new()
        .route("/healthz", get(health))
        .route("/v1/agent-runs/{run_id}/evidence", get(run_evidence))
        .route("/v1/threads/{thread_id}/messages", post(admit_message))
        .route("/v1/threads/{thread_id}/events", get(replay_events))
        .route("/v1/threads/{thread_id}/stream", get(stream_events))
        .with_state(state))
}

async fn run_evidence(
    State(state): State<AppState>,
    Path(run_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, HttpError> {
    let account_id = authorize(&headers, &state.auth)?;
    let evidence = state
        .store
        .run_evidence(&account_id, &run_id)
        .await
        .map_err(|_| HttpError::unavailable("run evidence unavailable"))?;
    match evidence {
        Some(evidence) => Ok(Json(evidence).into_response()),
        None => Ok((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "run not found"})),
        )
            .into_response()),
    }
}

async fn health(State(state): State<AppState>) -> StatusCode {
    if state.store.ping().await.is_ok() {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

async fn admit_message(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<MessageBody>,
) -> Result<(StatusCode, Json<MessageReceipt>), HttpError> {
    let account_id = authorize(&headers, &state.auth)?;
    let idempotency_key = required_header(&headers, "idempotency-key")?;
    let request_hash = request_hash(&thread_id, &body);
    let admission = MessageAdmission {
        account_id,
        thread_id,
        idempotency_key,
        request_hash,
        message_id: body.message_id,
        content: body.content,
        journey_kind: body.journey_kind.unwrap_or(JourneyKind::BasicAgentRun),
    };
    let receipt = state
        .store
        .admit_message(&admission)
        .await
        .map_err(|error| HttpError::bad_request(error.to_string()))?;
    let status = if receipt.idempotent_replay {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(receipt)))
}

async fn replay_events(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<ReplayQuery>,
    headers: HeaderMap,
) -> Result<Json<ReplayResponse>, HttpError> {
    let account_id = authorize(&headers, &state.auth)?;
    let events = state
        .store
        .replay(&account_id, &thread_id, query.after, query.limit)
        .await
        .map_err(|_| HttpError::unavailable("event replay unavailable"))?;
    let next_cursor = events
        .last()
        .map(|event| event.sequence)
        .unwrap_or(query.after);
    Ok(Json(ReplayResponse {
        events,
        next_cursor,
    }))
}

async fn stream_events(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<ReplayQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, HttpError> {
    let account_id = authorize(&headers, &state.auth)?;
    let header_cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let cursor = header_cursor.unwrap_or(query.after);
    let wake_key = format!("{account_id}:{thread_id}");
    let stream = stream::unfold(
        StreamCursor {
            store: state.store,
            receiver: state.notifications.subscribe(),
            account_id,
            thread_id,
            wake_key,
            cursor,
            pending: VecDeque::new(),
            until_run_id: query.until_run_id,
            finished: false,
        },
        |mut state| async move {
            loop {
                if state.finished {
                    return None;
                }
                if let Some(event) = state.pending.pop_front() {
                    state.cursor = event.sequence;
                    state.finished = state.until_run_id.as_deref() == Some(event.run_id.as_str())
                        && event.event_type == "assistant.message.completed";
                    let payload = serde_json::to_string(&event)
                        .unwrap_or_else(|_| "{\"error\":\"event encoding failed\"}".into());
                    let sse = Event::default()
                        .id(event.sequence.to_string())
                        .event(event.event_type)
                        .data(payload);
                    return Some((Ok(sse), state));
                }
                match state
                    .store
                    .replay(&state.account_id, &state.thread_id, state.cursor, 100)
                    .await
                {
                    Ok(events) if !events.is_empty() => {
                        state.pending.extend(events);
                        continue;
                    }
                    Ok(_) | Err(_) => {}
                }
                tokio::select! {
                    received = state.receiver.recv() => {
                        match received {
                            Ok(key) if key == state.wake_key => {},
                            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => {
                                tokio::time::sleep(Duration::from_secs(1)).await;
                            }
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
            }
        },
    );
    Ok(Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

struct StreamCursor {
    store: PostgresMessageStore,
    receiver: broadcast::Receiver<String>,
    account_id: String,
    thread_id: String,
    wake_key: String,
    cursor: u64,
    pending: VecDeque<ThreadEvent>,
    until_run_id: Option<String>,
    finished: bool,
}

async fn notification_listener(database_url: String, sender: broadcast::Sender<String>) {
    loop {
        if let Ok((client, connection)) =
            tokio_postgres::connect(&database_url, tokio_postgres::NoTls).await
            && client
                .batch_execute("LISTEN osfo_thread_events")
                .await
                .is_ok()
        {
            let mut connection = std::pin::pin!(connection);
            while let Some(message) =
                poll_fn(|context| connection.as_mut().poll_message(context)).await
            {
                match message {
                    Ok(AsyncMessage::Notification(notification)) => {
                        let _ = sender.send(notification.payload().to_owned());
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

fn request_hash(thread_id: &str, body: &MessageBody) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"osfo-message-v1\0");
    hasher.update(thread_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(body.message_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(body.content.as_bytes());
    hasher.update(b"\0");
    hasher.update(
        body.journey_kind
            .unwrap_or(JourneyKind::BasicAgentRun)
            .as_str()
            .as_bytes(),
    );
    format!("sha256:{:x}", hasher.finalize())
}

fn authorize(
    headers: &HeaderMap,
    authenticator: &AccountAuthenticator,
) -> Result<String, HttpError> {
    let value = headers
        .get("x-osfo-ingress-token")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
        })
        .ok_or_else(|| HttpError::unauthorized("valid bearer authentication is required"))?;
    let candidate = digest(value.as_bytes());
    if candidate.ct_eq(&authenticator.token_digest).unwrap_u8() != 1 {
        return Err(HttpError::unauthorized(
            "valid bearer authentication is required",
        ));
    }
    Ok(authenticator.account_id.clone())
}

fn required_header(headers: &HeaderMap, name: &'static str) -> Result<String, HttpError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| HttpError::bad_request(format!("{name} header is required")))
}

fn digest(value: &[u8]) -> [u8; 32] {
    Sha256::digest(value).into()
}

fn default_replay_limit() -> usize {
    100
}

struct HttpError {
    status: StatusCode,
    message: String,
}

impl HttpError {
    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            message: message.into(),
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}
