# Resumable streaming comparables

Research date: 2026-08-01. Repository evidence is pinned to the revisions
linked below.

## Decision frame

- **Question**: how do mature agent runtimes and messaging systems deliver
  incremental output, recover after disconnects, and synchronize several
  clients?
- **Boundary**: compare transport behavior with durable resume semantics. This
  ticket does not rank or select an Osfo transport.
- **Central finding**: no transport supplies durable replay. Reopening a
  connection and recovering missed committed events are separate operations.

```text
transport reconnect:   broken pipe -> new pipe
durable resume:         client cursor -> retained ordered log -> replay -> live tail
```

## Transport behavior

| Transport | Connection and clients | Control | Slow consumers | Native reconnect limit |
| --- | --- | --- | --- | --- |
| SSE / `EventSource` | One long-lived HTTP response, UTF-8 text, with a native browser API. Ordinary non-browser HTTP clients can parse the wire format. HTTP proxies may buffer incremental responses unless configured not to, Nginx enables proxy buffering by default. | Server to client only. Client commands require another HTTP request. | The browser API exposes event callbacks, not a pull or acknowledgement interface. Servers still need bounded per-client queues and a disconnect policy. | The browser reconnects and sends `Last-Event-ID` after an event containing `id:`. That value belongs to the live `EventSource`; the standard neither durably saves it, retains events, nor defines how the server interprets it. See the [WHATWG SSE processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#processing-model), [event ID rules](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-last-event-id-header), and [Nginx buffering behavior](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering). |
| WebSocket | A persistent browser and non-browser, text or binary, full-duplex connection after an HTTP upgrade. Reverse proxies need explicit upgrade support and idle timeout policy. | Native bidirectional messages, so cancel, acknowledgement, and subscription control can share the connection. | Browser senders can observe `bufferedAmount`, but the API has no incoming pull interface. Production servers must bound queues; Centrifuge disconnects once its per-client byte queue exceeds `MaxQueueSize`. | The standard exposes open, close, and message state, but no automatic reconnect, cursor, or replay. These are SDK or application protocol features. See the [WHATWG WebSocket interface](https://websockets.spec.whatwg.org/#the-websocket-interface), [Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html), and [Centrifuge's bounded writer](https://github.com/centrifugal/centrifuge/blob/9cf1e2a1c196620e5a60bb95c57bad6babeb744d/writer.go#L294-L322). |
| HTTP streaming | One ordinary long-lived HTTP response whose application framing may be SSE, NDJSON, or another format. HTTP/1.1 chunks and HTTP/2 or HTTP/3 data frames are not application event boundaries. Browser Fetch exposes the body as a `ReadableStream`; command-line and server clients use normal HTTP stacks. It shares SSE's proxy buffering and timeout concerns. | Normally server to client. A separate POST can emulate the reverse direction, as in [Centrifugo's HTTP-streaming transport](https://centrifugal.dev/docs/transports/http_stream). | Web Streams exposes `desiredSize` and pull-based backpressure inside the client stream pipeline. That does not replace bounded network and server queues. | Fetch does not recreate a failed response or define an event cursor. The application must reopen the request and supply its own resume position. See [HTTP/1.1 chunked coding](https://www.rfc-editor.org/rfc/rfc9112.html#section-7.1), the [Fetch body contract](https://fetch.spec.whatwg.org/#body-mixin), and [Web Streams backpressure](https://streams.spec.whatwg.org/#backpressure). |
| Long polling | A sequence of ordinary, finite HTTP requests. It works with essentially every browser, proxy, and non-browser HTTP client, at the cost of repeated headers and request latency. | Each receive poll is request and response. Sending commands uses another request, so there is no full-duplex connection. | The next poll provides natural pull pacing and each response can be bounded. A client that falls behind still needs retained history or a state reload. | There is no connection to resume. The application repeats the poll with a cursor. Matrix uses the prior `next_batch` as `since`, may return a limited timeline with a gap, and requires a history query to fill it. See [Matrix syncing](https://spec.matrix.org/v1.19/client-server-api/#syncing). |

The connection trade-off is operational, not semantic. HTTP-based delivery
fits ordinary request infrastructure but must disable or control intermediary
buffering for incremental output. WebSocket avoids response buffering after its
upgrade, but proxies must support the tunnel and keep it alive. Socket.IO starts
with long polling, upgrades to WebSocket when possible, and preserves message
order across that upgrade, yet still defaults to at-most-once delivery. Its
server has no missed-event buffer unless recovery is added above the transport
([transport upgrade](https://socket.io/docs/v4/how-it-works/#upgrade-mechanism),
[delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)).

## Resume semantics in mature systems

| System | Cursor, replay, duplicates, and ordering | Durability owner |
| --- | --- | --- |
| LangGraph Agent Server | A run `join_stream` is explicitly unbuffered, so joining late loses earlier output. The distinct thread stream supports replay from `Last-Event-ID`, including replay from the beginning. This proves that SSE framing alone is not the resume contract; endpoint retention semantics are. See [run versus thread streaming](https://docs.langchain.com/langsmith/streaming#join-and-stream) and [thread resume](https://docs.langchain.com/langsmith/streaming#resume-from-last-event). | The endpoint, not SSE, must own retained event history and cursor interpretation. The cited documentation does not identify that storage contract. A client-held run ID alone is insufficient because the run stream is unbuffered. |
| Socket.IO | Low-level transport order is preserved even while upgrading from long polling to WebSocket. Default delivery is at most once. Optional connection recovery sends a private session ID plus the client's last processed offset and replays missed packets only within a configured retention window; failed recovery requires full synchronization. For durable server-to-client at-least-once delivery, its own guide prescribes unique event IDs, a database, and a client offset. See [ordering and database replay](https://socket.io/docs/v4/delivery-guarantees/) and [bounded connection recovery](https://socket.io/docs/v4/connection-state-recovery). | The selected adapter owns bounded packet retention for connection recovery. Durable application delivery remains application database responsibility. Redis Pub/Sub cannot support packet recovery, while Redis Streams can. |
| Centrifuge / Centrifugo | Recoverable subscriptions track an `offset` plus stream `epoch`. A reconnect requests publications after that position. Recovery can return `recovered: false` when history is insufficient, at which point state must be loaded again. Replayed updates may overlap a freshly loaded snapshot, so the application must use offsets, last-write-wins, or idempotent updates. See the [client recovery contract](https://centrifugal.dev/docs/transports/client_api#subscription-recovery-state). | History is optional and bounded. The memory broker loses it on restart; Redis reliability follows Redis configuration. The production library says this history is not the sole source of missed publications and the application database is still required ([pinned repository guidance](https://github.com/centrifugal/centrifuge/blob/9cf1e2a1c196620e5a60bb95c57bad6babeb744d/README.md#L270-L278)). |
| Vercel `resumable-stream` | A stream ID plus a character offset lets another consumer receive the producer's buffered prefix and then its live chunks. The producer continues after the original HTTP reader disconnects. The code notes a same-ID creation race and keeps buffered chunks in the producer process, then fans them out with Redis Pub/Sub ([runtime](https://github.com/vercel/resumable-stream/blob/aa490f28b4199099a7bda98b7d3ab856aaeace5f/src/runtime.ts#L127-L218)). A character count is a raw string continuation marker, not a stable semantic event identity. | Redis stores only a 24-hour sentinel and carries live Pub/Sub messages; the replay buffer is process memory. The API explicitly tells callers to save completed output in a database ([contract](https://github.com/vercel/resumable-stream/blob/aa490f28b4199099a7bda98b7d3ab856aaeace5f/src/types.ts#L26-L44)). This is live stream handoff, not durable conversation history. |
| Matrix `/sync` | Each client repeats long polls with its previous `next_batch` token as `since`. The homeserver may bound a response and report a gap, which the client fills from history. Matrix orders sync events by arrival at the homeserver and warns that using other APIs can produce duplicates, so clients deduplicate by globally unique event ID ([sync and gap rules](https://spec.matrix.org/v1.19/client-server-api/#syncing)). | The homeserver owns durable room events and token interpretation. Each device keeps its own progress token and derived local state. |

## Decision-useful invariants

These findings constrain a future Osfo transport decision without making it:

1. Give every client or device its own cursor. One Thread-wide delivery cursor
   cannot represent several independently connected consumers.
2. Keep stable event identity separate from order. Replay is after an
   authoritative Thread position; duplicate-safe application uses event ID.
3. Commit before delivery. A cursor can only promise recovery for events that
   the durability owner retained before exposing them to any transport.
4. Specify at-least-once replay and apply-once clients. Advance a cursor only
   after applying an event. A disconnect at the delivery boundary is inherently
   ambiguous, so duplicate delivery is normal.
5. Join replay to the live tail without a gap. Fetch history after the cursor,
   then subscribe from the exact returned head or use one atomic server-side
   operation.
6. Make retention failure explicit. An expired, unknown, or too-old cursor must
   produce a typed gap result and a full-state or history recovery path.
7. Bound every live client's queue. Backpressure can slow writes, but it cannot
   allow one consumer to grow server memory without limit. Disconnecting a slow
   client is safe only when durable replay remains available.
8. Separate connection control from run control. Losing SSE, WebSocket, HTTP
   streaming, or a poll must not implicitly cancel an AgentRun unless product
   policy explicitly couples them.

The durable authority therefore owns retention, per-Thread order, cursor
validation, replay boundaries, and duplicate identity. SSE `Last-Event-ID`, a
WebSocket reconnect payload, an HTTP query parameter, or a long-poll `since`
token are only ways to carry that contract.
