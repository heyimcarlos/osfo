use osfo_agent_run_lifecycle_prototype::{ArtifactStore, MinioArtifactStore};

#[test]
fn artifact_bucket_is_immutable_and_checksum_verified() {
    let client_container = std::env::var("MINIO_CLIENT_CONTAINER")
        .unwrap_or_else(|_| "osfo-lifecycle-artifact-client".into());
    let bucket = std::env::var("MINIO_BUCKET").unwrap_or_else(|_| "osfo-lifecycle-local".into());
    let mut store = MinioArtifactStore::new(client_container, bucket);

    let artifact = store
        .put_immutable("seed-130013/briefing.txt", b"briefing\n")
        .expect("commit immutable artifact");
    assert_eq!(artifact.size_bytes, 9);
    assert_eq!(
        artifact.sha256,
        "4d958129226715d3c4b7d68a53a9be2040025d9b0f844ced223ab9a71ad01751"
    );
    assert_eq!(
        store
            .put_immutable("seed-130013/briefing.txt", b"briefing\n")
            .expect("idempotent artifact replay"),
        artifact
    );
    assert!(
        store
            .put_immutable("seed-130013/briefing.txt", b"different\n")
            .is_err()
    );
    assert_eq!(
        store.get_verified(&artifact).expect("read artifact"),
        b"briefing\n"
    );
}
