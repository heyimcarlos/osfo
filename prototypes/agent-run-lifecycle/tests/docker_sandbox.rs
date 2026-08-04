use std::time::Duration;

use osfo_agent_run_lifecycle_prototype::{DockerSandboxProvider, SandboxProvider, SandboxSpec};

#[test]
fn docker_sandbox_exports_authoritative_bytes_without_becoming_authority() {
    let image = std::env::var("OSFO_SANDBOX_IMAGE").unwrap_or_else(|_| {
        "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"
            .into()
    });
    let mut provider = DockerSandboxProvider::new();
    let sandbox = provider
        .create(SandboxSpec {
            sandbox_id: "contract-001".into(),
            image,
            cpu_limit: 0.5,
            memory_bytes: 64 * 1024 * 1024,
            process_limit: 32,
        })
        .expect("create constrained sandbox");

    assert_eq!(
        provider
            .execute(&sandbox, "id -u", Duration::from_secs(2))
            .expect("read sandbox uid")
            .stdout
            .trim(),
        "65532"
    );
    assert!(
        !provider
            .execute(&sandbox, "touch /root-denied", Duration::from_secs(2))
            .expect("test read-only root")
            .success
    );
    assert!(
        !provider
            .execute(
                &sandbox,
                "wget -q -T 1 -O /dev/null https://example.com",
                Duration::from_secs(2),
            )
            .expect("test disabled network")
            .success
    );
    assert!(
        provider
            .execute(
                &sandbox,
                "printf 'briefing\\n' > /workspace/briefing.txt",
                Duration::from_secs(2),
            )
            .expect("write workspace artifact")
            .success
    );

    let artifact = provider
        .export(&sandbox, "briefing.txt")
        .expect("export immutable bytes");
    assert_eq!(artifact.bytes, b"briefing\n");
    assert_eq!(
        artifact.sha256,
        "4d958129226715d3c4b7d68a53a9be2040025d9b0f844ced223ab9a71ad01751"
    );

    let replay = provider
        .create(SandboxSpec {
            sandbox_id: "contract-001".into(),
            image: std::env::var("OSFO_SANDBOX_IMAGE").unwrap_or_else(|_| {
                "alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"
                    .into()
            }),
            cpu_limit: 0.5,
            memory_bytes: 64 * 1024 * 1024,
            process_limit: 32,
        })
        .expect("reconcile unknown create acknowledgement");
    assert_eq!(replay, sandbox);
    assert_eq!(
        provider
            .export(&replay, "briefing.txt")
            .expect("export after create reconciliation")
            .sha256,
        artifact.sha256
    );

    provider.stop(&sandbox).expect("stop sandbox");
    assert!(provider.resume(&sandbox).expect("resume sandbox"));
    assert_eq!(
        provider
            .export(&sandbox, "briefing.txt")
            .expect("export after resume")
            .sha256,
        artifact.sha256
    );
    provider.delete(&sandbox).expect("delete sandbox");
    assert!(!provider.resume(&sandbox).expect("missing sandbox"));
}
