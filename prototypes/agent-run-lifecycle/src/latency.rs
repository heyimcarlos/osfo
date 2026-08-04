use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use anyhow::{Context, Result, anyhow};
use hdrhistogram::Histogram;
use sha2::{Digest, Sha256};

use crate::evidence::MetricSummary;

pub const PROMETHEUS_BOUNDS_MILLISECONDS: [f64; 14] = [
    1.0, 2.5, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1_000.0, 2_500.0, 5_000.0, 10_000.0,
    30_000.0,
];

const MAX_RECORDED_MICROSECONDS: u64 = 3_600_000_000;

#[derive(Debug, Clone)]
pub struct LatencySample {
    pub family: String,
    pub microseconds: u64,
}

impl LatencySample {
    pub fn from_duration(family: impl Into<String>, duration: Duration) -> Self {
        Self {
            family: family.into(),
            microseconds: duration.as_micros().min(u128::from(u64::MAX)) as u64,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PrometheusHistogram {
    pub cumulative_buckets: Vec<(f64, u64)>,
    pub count: u64,
    pub sum_milliseconds: f64,
}

#[derive(Debug)]
pub struct LatencyEvidence {
    pub summaries: BTreeMap<String, MetricSummary>,
    pub row_count: u64,
    pub sha256: String,
}

pub struct LatencyRecorder {
    path: PathBuf,
    state: Mutex<RecorderState>,
}

struct RecorderState {
    writer: BufWriter<File>,
    histograms: BTreeMap<String, Histogram<u64>>,
    sums_microseconds: BTreeMap<String, u128>,
    row_count: u64,
}

impl LatencyRecorder {
    pub fn create(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("create latency evidence directory {}", parent.display())
            })?;
        }
        let mut writer = BufWriter::new(
            File::create(&path)
                .with_context(|| format!("create raw latency evidence {}", path.display()))?,
        );
        writer.write_all(b"stage,ordinal,outcome,family,microseconds\n")?;
        Ok(Self {
            path,
            state: Mutex::new(RecorderState {
                writer,
                histograms: BTreeMap::new(),
                sums_microseconds: BTreeMap::new(),
                row_count: 0,
            }),
        })
    }

    pub fn record_batch(
        &self,
        stage: &str,
        ordinal: usize,
        outcome: &str,
        samples: &[LatencySample],
    ) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("latency recorder lock poisoned"))?;
        for sample in samples {
            write_csv_field(&mut state.writer, stage)?;
            write!(state.writer, ",{ordinal},")?;
            write_csv_field(&mut state.writer, outcome)?;
            state.writer.write_all(b",")?;
            write_csv_field(&mut state.writer, &sample.family)?;
            writeln!(state.writer, ",{}", sample.microseconds)?;

            let histogram = state
                .histograms
                .entry(sample.family.clone())
                .or_insert_with(new_histogram);
            histogram.record(sample.microseconds.clamp(1, MAX_RECORDED_MICROSECONDS))?;
            *state
                .sums_microseconds
                .entry(sample.family.clone())
                .or_default() += u128::from(sample.microseconds);
            state.row_count += 1;
        }
        Ok(())
    }

    pub fn prometheus_histogram(&self, family: &str) -> PrometheusHistogram {
        let Ok(state) = self.state.lock() else {
            return PrometheusHistogram::default();
        };
        let Some(histogram) = state.histograms.get(family) else {
            return PrometheusHistogram::default();
        };
        PrometheusHistogram {
            cumulative_buckets: PROMETHEUS_BOUNDS_MILLISECONDS
                .into_iter()
                .map(|bound| {
                    let upper_microseconds = (bound * 1_000.0) as u64;
                    (bound, histogram.count_between(0, upper_microseconds))
                })
                .collect(),
            count: histogram.len(),
            sum_milliseconds: state
                .sums_microseconds
                .get(family)
                .copied()
                .unwrap_or_default() as f64
                / 1_000.0,
        }
    }

    pub fn finish(self) -> Result<LatencyEvidence> {
        let state = self
            .state
            .into_inner()
            .map_err(|_| anyhow!("latency recorder lock poisoned"))?;
        finish_state(self.path, state)
    }
}

fn new_histogram() -> Histogram<u64> {
    Histogram::new_with_bounds(1, MAX_RECORDED_MICROSECONDS, 3)
        .expect("static latency histogram bounds must be valid")
}

fn finish_state(path: PathBuf, mut state: RecorderState) -> Result<LatencyEvidence> {
    state.writer.flush()?;
    drop(state.writer);
    let summaries = state
        .histograms
        .into_iter()
        .map(|(family, histogram)| {
            let to_ms = |value| value as f64 / 1_000.0;
            let summary = MetricSummary {
                p50_ms: to_ms(histogram.value_at_quantile(0.50)),
                p90_ms: to_ms(histogram.value_at_quantile(0.90)),
                p95_ms: to_ms(histogram.value_at_quantile(0.95)),
                p99_ms: to_ms(histogram.value_at_quantile(0.99)),
                maximum_ms: to_ms(histogram.max()),
                sample_count: histogram.len() as usize,
            };
            (family, summary)
        })
        .collect();
    Ok(LatencyEvidence {
        summaries,
        row_count: state.row_count,
        sha256: sha256_file(&path)?,
    })
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn write_csv_field(writer: &mut impl Write, value: &str) -> Result<()> {
    if value.contains([',', '"', '\n', '\r']) {
        writer.write_all(b"\"")?;
        writer.write_all(value.replace('"', "\"\"").as_bytes())?;
        writer.write_all(b"\"")?;
    } else {
        writer.write_all(value.as_bytes())?;
    }
    Ok(())
}
