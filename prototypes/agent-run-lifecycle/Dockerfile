FROM rust:1.94.1-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS builder

WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY schema.sql ./
COPY src ./src
RUN cargo build --locked --release --no-default-features --features deployed-ingress \
    --bin ingress_service --bin agent_run_worker --bin dispatch_schema_migrate \
    --bin dispatch_schema_initialize

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /build/target/release/ingress_service /usr/local/bin/ingress_service
COPY --from=builder /build/target/release/agent_run_worker /usr/local/bin/agent_run_worker
COPY --from=builder /build/target/release/dispatch_schema_migrate /usr/local/bin/dispatch_schema_migrate
COPY --from=builder /build/target/release/dispatch_schema_initialize /usr/local/bin/dispatch_schema_initialize

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/ingress_service"]
