FROM alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1

LABEL osfo.workspace-prepared="true"

RUN mkdir -p /workspace && chown 65532:65532 /workspace

USER 65532:65532
WORKDIR /workspace
