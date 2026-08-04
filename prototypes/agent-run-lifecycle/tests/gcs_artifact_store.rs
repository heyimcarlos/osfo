use osfo_agent_run_lifecycle_prototype::{ArtifactStore, GcsArtifactStore};

#[test]
fn regional_gcs_bucket_commits_create_only_verified_artifact() {
    let Ok(bucket) = std::env::var("OSFO_ARTIFACT_BUCKET") else {
        eprintln!("skipped: OSFO_ARTIFACT_BUCKET is not configured");
        return;
    };
    let mut store = GcsArtifactStore::new(bucket);

    let artifact = store
        .put_immutable("adapter-contract/seed-130013.txt", b"briefing\n")
        .expect("commit Cloud Storage artifact");
    assert_eq!(
        artifact.sha256,
        "4d958129226715d3c4b7d68a53a9be2040025d9b0f844ced223ab9a71ad01751"
    );
    assert_eq!(
        store.get_verified(&artifact).expect("verify GCS bytes"),
        b"briefing\n"
    );
    assert!(
        store
            .put_immutable("adapter-contract/seed-130013.txt", b"different\n")
            .is_err()
    );
}
