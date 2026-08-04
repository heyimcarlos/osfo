use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{Context, Result};

use crate::latency::PrometheusHistogram;

#[derive(Debug, Clone, Default)]
pub struct MetricsSnapshot {
    pub stage: String,
    pub offered: u64,
    pub received: u64,
    pub caller_drop: u64,
    pub accepted: u64,
    pub completed: u64,
    pub failed: u64,
    pub shed_or_rejected: u64,
    pub temporal_delivery_retries: u64,
    pub errors: u64,
    pub pending: i64,
    pub running: i64,
    pub waiting: i64,
    pub database_connections: i64,
    pub lock_waiters: i64,
    pub end_to_end_latencies: BTreeMap<String, PrometheusHistogram>,
}

#[derive(Debug, Clone, Default)]
pub struct MetricsRegistry {
    inner: Arc<RwLock<MetricsSnapshot>>,
}

impl MetricsRegistry {
    pub fn replace(&self, snapshot: MetricsSnapshot) {
        if let Ok(mut current) = self.inner.write() {
            *current = snapshot;
        }
    }

    pub fn snapshot(&self) -> MetricsSnapshot {
        self.inner
            .read()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn render(&self) -> String {
        let snapshot = self.snapshot();
        let stage = escape_label(&snapshot.stage);
        let mut output = format!(
            "# HELP osfo_evidence_offered_total Journeys offered to the evidence runner.\n\
# TYPE osfo_evidence_offered_total counter\n\
osfo_evidence_offered_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_received_total Offered journeys that reached the admission seam.\n\
# TYPE osfo_evidence_received_total counter\n\
osfo_evidence_received_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_caller_drop_total Offered journeys dropped by the caller before the admission seam.\n\
# TYPE osfo_evidence_caller_drop_total counter\n\
osfo_evidence_caller_drop_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_accepted_total AgentRuns durably accepted by PostgreSQL.\n\
# TYPE osfo_evidence_accepted_total counter\n\
osfo_evidence_accepted_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_shed_or_rejected_total Received journeys rejected before durable acceptance.\n\
# TYPE osfo_evidence_shed_or_rejected_total counter\n\
osfo_evidence_shed_or_rejected_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_temporal_delivery_retries_total Idempotent Temporal outcome delivery retries after a failed attempt.\n\
# TYPE osfo_evidence_temporal_delivery_retries_total counter\n\
osfo_evidence_temporal_delivery_retries_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_completed_total Journeys reaching the expected terminal state.\n\
# TYPE osfo_evidence_completed_total counter\n\
osfo_evidence_completed_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_errors_total Journey errors observed by the runner.\n\
# TYPE osfo_evidence_errors_total counter\n\
osfo_evidence_errors_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_failed_total Accepted AgentRuns reaching a failed terminal state.\n\
# TYPE osfo_evidence_failed_total counter\n\
osfo_evidence_failed_total{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_in_flight Accepted AgentRuns without a terminal state.\n\
# TYPE osfo_evidence_in_flight gauge\n\
osfo_evidence_in_flight{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_agent_runs Authoritative AgentRun rows by nonterminal state.\n\
# TYPE osfo_evidence_agent_runs gauge\n\
osfo_evidence_agent_runs{{stage=\"{stage}\",state=\"pending\"}} {}\n\
osfo_evidence_agent_runs{{stage=\"{stage}\",state=\"running\"}} {}\n\
osfo_evidence_agent_runs{{stage=\"{stage}\",state=\"waiting\"}} {}\n\
# HELP osfo_evidence_database_connections PostgreSQL sessions for the Osfo database.\n\
# TYPE osfo_evidence_database_connections gauge\n\
osfo_evidence_database_connections{{stage=\"{stage}\"}} {}\n\
# HELP osfo_evidence_database_lock_waiters PostgreSQL sessions waiting on locks.\n\
# TYPE osfo_evidence_database_lock_waiters gauge\n\
osfo_evidence_database_lock_waiters{{stage=\"{stage}\"}} {}\n",
            snapshot.offered,
            snapshot.received,
            snapshot.caller_drop,
            snapshot.accepted,
            snapshot.shed_or_rejected,
            snapshot.temporal_delivery_retries,
            snapshot.completed,
            snapshot.errors,
            snapshot.failed,
            snapshot
                .accepted
                .saturating_sub(snapshot.completed.saturating_add(snapshot.failed)),
            snapshot.pending,
            snapshot.running,
            snapshot.waiting,
            snapshot.database_connections,
            snapshot.lock_waiters,
        );
        for (outcome, histogram) in &snapshot.end_to_end_latencies {
            output.push_str(&render_histogram(&stage, outcome, histogram));
        }
        output
    }

    pub fn serve(&self, address: &str) -> Result<MetricsServer> {
        let listener = TcpListener::bind(address)
            .with_context(|| format!("bind Prometheus metrics endpoint at {address}"))?;
        listener.set_nonblocking(true)?;
        let registry = self.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let thread_stopped = stopped.clone();
        let handle = thread::spawn(move || {
            while !thread_stopped.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => serve_connection(stream, &registry),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(MetricsServer {
            stopped,
            handle: Some(handle),
        })
    }
}

pub struct MetricsServer {
    stopped: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for MetricsServer {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn serve_connection(mut stream: TcpStream, registry: &MetricsRegistry) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let mut request = [0_u8; 1024];
    let count = stream.read(&mut request).unwrap_or(0);
    let first_line = String::from_utf8_lossy(&request[..count]);
    let (status, content_type, body) = if first_line.starts_with("GET /metrics ") {
        ("200 OK", "text/plain; version=0.0.4", registry.render())
    } else if first_line.starts_with("GET /healthz ") {
        ("200 OK", "text/plain", "ok\n".into())
    } else {
        ("404 Not Found", "text/plain", "not found\n".into())
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn finite(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

fn render_histogram(stage: &str, outcome: &str, histogram: &PrometheusHistogram) -> String {
    let outcome = escape_label(outcome);
    let mut output = String::from(
        "# HELP osfo_evidence_end_to_end_latency_milliseconds End-to-end journey latency.\n\
# TYPE osfo_evidence_end_to_end_latency_milliseconds histogram\n",
    );
    for (bound, count) in &histogram.cumulative_buckets {
        output.push_str(&format!(
            "osfo_evidence_end_to_end_latency_milliseconds_bucket{{stage=\"{stage}\",outcome=\"{outcome}\",le=\"{}\"}} {count}\n",
            finite(*bound)
        ));
    }
    output.push_str(&format!(
        "osfo_evidence_end_to_end_latency_milliseconds_bucket{{stage=\"{stage}\",outcome=\"{outcome}\",le=\"+Inf\"}} {}\n",
        histogram.count
    ));
    output.push_str(&format!(
        "osfo_evidence_end_to_end_latency_milliseconds_sum{{stage=\"{stage}\",outcome=\"{outcome}\"}} {}\n",
        finite(histogram.sum_milliseconds)
    ));
    output.push_str(&format!(
        "osfo_evidence_end_to_end_latency_milliseconds_count{{stage=\"{stage}\",outcome=\"{outcome}\"}} {}\n",
        histogram.count
    ));
    output
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{MetricsRegistry, MetricsSnapshot};
    use crate::latency::PrometheusHistogram;

    #[test]
    fn prometheus_scrape_exposes_stage_counters_and_database_gauges() {
        let registry = MetricsRegistry::default();
        registry.replace(MetricsSnapshot {
            stage: "steady-15".into(),
            offered: 151,
            received: 150,
            caller_drop: 1,
            accepted: 150,
            completed: 149,
            shed_or_rejected: 0,
            temporal_delivery_retries: 2,
            errors: 1,
            failed: 1,
            pending: 1,
            running: 2,
            waiting: 3,
            database_connections: 9,
            lock_waiters: 0,
            end_to_end_latencies: BTreeMap::from([(
                "completed".into(),
                PrometheusHistogram {
                    cumulative_buckets: vec![(10.0, 1), (25.0, 2), (50.0, 3)],
                    count: 3,
                    sum_milliseconds: 59.5,
                },
            )]),
        });

        let scrape = registry.render();

        assert!(scrape.contains("osfo_evidence_offered_total{stage=\"steady-15\"} 151"));
        assert!(scrape.contains("osfo_evidence_received_total{stage=\"steady-15\"} 150"));
        assert!(scrape.contains("osfo_evidence_caller_drop_total{stage=\"steady-15\"} 1"));
        assert!(scrape.contains("osfo_evidence_shed_or_rejected_total{stage=\"steady-15\"} 0"));
        assert!(
            scrape.contains("osfo_evidence_temporal_delivery_retries_total{stage=\"steady-15\"} 2")
        );
        assert!(
            scrape.contains("osfo_evidence_agent_runs{stage=\"steady-15\",state=\"waiting\"} 3")
        );
        assert!(scrape.contains("osfo_evidence_database_connections{stage=\"steady-15\"} 9"));
        assert!(scrape.contains(
            "osfo_evidence_end_to_end_latency_milliseconds_bucket{stage=\"steady-15\",outcome=\"completed\",le=\"50\"} 3"
        ));
        assert!(scrape.contains(
            "osfo_evidence_end_to_end_latency_milliseconds_count{stage=\"steady-15\",outcome=\"completed\"} 3"
        ));
        assert!(scrape.contains(
            "osfo_evidence_end_to_end_latency_milliseconds_sum{stage=\"steady-15\",outcome=\"completed\"} 59.5"
        ));
    }
}
