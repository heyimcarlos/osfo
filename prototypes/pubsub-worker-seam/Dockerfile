FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/worker ./cmd/worker && \
    CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/harness ./cmd/harness

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/worker /worker
COPY --from=build /out/harness /harness
USER nonroot:nonroot
ENTRYPOINT ["/worker"]
