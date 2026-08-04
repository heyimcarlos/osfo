use std::{fs, time::Duration};

use osfo_agent_run_lifecycle_prototype::latency::{LatencyRecorder, LatencySample};

#[test]
fn raw_latency_evidence_streams_to_disk_and_keeps_bounded_histograms() {
    let path = std::env::temp_dir().join(format!(
        "osfo-latency-evidence-{}-{}.csv",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    let _ = fs::remove_file(&path);
    let recorder = LatencyRecorder::create(&path).unwrap();

    recorder
        .record_batch(
            "steady-700-cold",
            41,
            "completed",
            &[
                LatencySample::from_duration("admission", Duration::from_micros(1_250)),
                LatencySample::from_duration("end_to_end_journey", Duration::from_micros(42_500)),
            ],
        )
        .unwrap();
    recorder
        .record_batch(
            "steady-700-cold",
            42,
            "failed",
            &[LatencySample::from_duration(
                "end_to_end_journey",
                Duration::from_micros(57_500),
            )],
        )
        .unwrap();

    let live = recorder.prometheus_histogram("end_to_end_journey");
    assert_eq!(live.count, 2);
    assert_eq!(live.sum_milliseconds, 100.0);

    let evidence = recorder.finish().unwrap();
    let end_to_end = evidence.summaries.get("end_to_end_journey").unwrap();
    assert_eq!(end_to_end.sample_count, 2);
    assert!(end_to_end.p50_ms >= 42.0 && end_to_end.p50_ms <= 43.0);
    assert!(end_to_end.p99_ms >= 57.0 && end_to_end.p99_ms <= 58.0);
    assert_eq!(evidence.row_count, 3);
    assert_eq!(evidence.sha256.len(), 64);

    let raw = fs::read_to_string(&path).unwrap();
    assert!(raw.starts_with("stage,ordinal,outcome,family,microseconds\n"));
    assert!(raw.contains("steady-700-cold,42,failed,end_to_end_journey,57500"));
    fs::remove_file(path).unwrap();
}
