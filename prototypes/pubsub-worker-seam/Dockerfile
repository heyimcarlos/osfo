FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/worker ./cmd/worker && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/harness ./cmd/harness && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/b2-ingress ./cmd/b2-ingress && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/b2-harness ./cmd/b2-harness && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/b2-load ./cmd/b2-load

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/worker /worker
COPY --from=build /out/harness /harness
COPY --from=build /out/b2-ingress /b2-ingress
COPY --from=build /out/b2-harness /b2-harness
COPY --from=build /out/b2-load /b2-load
USER nonroot:nonroot
ENTRYPOINT ["/worker"]
