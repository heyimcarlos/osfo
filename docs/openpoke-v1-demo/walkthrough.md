# OpenPoke v1 walkthrough

## Part 1: What was built and why

Start with the user journey: every device is a view of one canonical Thread,
and device identity never becomes conversation authority. The captured local
journey proves that independently connected observer tabs can disconnect while
another tab advances the Thread, then resume strictly from their own prior
ThreadCursor. It does not exercise a sending tab closing mid-response.

The protocol is ordinary authenticated HTTP for commands and cursor-based SSE
for replay followed by live delivery. SSE fits the one-way server stream and
keeps command retries separate. A reconnect sends the last durably applied
opaque cursor. PostgreSQL returns later ThreadEvents in ThreadPosition order.
Stable event identities make at-least-once replay duplicate-safe.

The durable command path is:

```text
HTTP admission
  -> one PostgreSQL transaction
  -> append-oriented outbox
  -> N1 Principal-first relay
  -> one ordered Pub/Sub subscription
  -> fixed StreamingPull worker point claim
  -> fenced execution
  -> durable ThreadEvents
  -> cursor replay and live SSE
```

PostgreSQL owns receipts, canonical Thread history, AgentRun lifecycle, leases,
epochs, budgets, and outbox obligations. Pub/Sub is a durable delivery buffer,
not authority. Direct dual-write was rejected because database-first strands
work and publish-first can create ghost work. Authenticated Pub/Sub push was a
historical candidate. The selected worker delivery seam is now fixed
StreamingPull because work can outlive an HTTP request and the warm fixed fleet
has predictable recovery capacity.

The presentation packet includes the current architecture, exact 100k-DAU
arithmetic, copied records from sealed load and failure lanes, five sealed
Grafana views, 13 deterministic post-run cards, a local authenticated
three-tab recording, and a verifier that fails closed on absent or changed
artifacts. Every gate stays `PASS`, `FAIL`, or `MISSING` at its measured scope.

## Part 2: What failed or was skipped, and how to test it

The second 30-minute Montreal repetition accepted and reconciled all work, but
the receipt gate failed: 9,105 of 417,600 receipts exceeded 1 second. That is a
2.18031609% late rate. Correctness did not compensate for the user-visible
latency failure.

Production topology cell D is an honest `FAIL`: 417,600 were offered, 410,372
were accepted, 7,228 ended caller-unknown, only 35.123084% received a receipt
within 1 second, and receipt p99 was 13,007.533 ms. Accepted-work reconciliation
still passed with 410,372 Good Root Outcomes and 615,590 / 615,590 AgentRuns
succeeded. Correctness does not erase the admission and receipt failure. The
stable A/B/C/D matrix summary is now copied into this packet. All four cells
failed admission while reconciling accepted work exactly. The comparison
supports retained history as a degradation cause. A larger WAL envelope cut
WAL and checkpoint churn, but did not qualify admission. Both sealed provider
roots ended with zero manifest-owned cloud residue and empty resource
inventories.

Full `us-east4` production qualification remains `MISSING`. Continue with an
open-arrival overload sweep. Freeze identity sets, workload seeds, topology,
raw samples, resource captures, and checksums. Find the first rate where
goodput, receipts, First Meaningful ThreadEvent latency, correctness, backlog,
or bounded resources fail. Do not call the last offered rate a ceiling unless
every lower gate passed.

Full outage recovery is also `MISSING`. The declared 15-minute outage at 348
AgentRuns/s accumulates 313,200 runs. The final matrix used the 400,000-AgentRun
reserve candidate, so sizing is no longer the missing input. The matrix tested
admission, not the declared outage or recovery. After admission stability is
repaired, keep 232 commands/s running during outage and recovery, cut the
selected worker fleet, require visible recovery progress within 5 minutes,
full drain within 20 minutes, and reconcile every run, attempt, fence, budget,
and ThreadEvent.

Current saturation evidence is incomplete. One selected production lane must
capture CPU, memory, open connections, Pub/Sub backlog and oldest age,
PostgreSQL backends and waits, table and index growth, WAL, checkpoint behavior,
relay window use, worker streams, execution slots, and per-tier limits on one
locked timeline.

The local authenticated three-tab recording is `PASS` for its exact scope.
Real Chrome tabs A, B, and C use one Principal and Thread with independent tab
state, cursors, and projections. Each observer tab disconnects, another tab
advances the Thread, the observer resumes from its own cursor, and all three
converge with PostgreSQL through position 15. The recording is not proof of a
sending tab closing mid-response, session expiry, authorization revocation,
target-load concurrency, or production behavior. Those stronger journeys must
be exercised before making any stronger claim.

The bounded Mailpit retry control passed, but a production external-action
guarantee is `MISSING`. Test an exact committed Action, stable idempotency key,
attempt recorded before contact, lost acknowledgement after provider apply,
duplicate delivery, and final ActionReceipt. Require one external effect and
never blindly retry an unknown outcome.

Thirteen run-specific cards are now present for the selected historical lanes.
They are deterministic post-run renders from sealed records, not in-run screen
captures. Each card exposes its run ID, timestamps, workload, exact scoped
verdict, and original source-manifest hash. They improve reviewability without
changing any load result or production qualification.

## Part 3: OpenPoke architecture and next improvements

Inspected OpenPoke revision:
[5b5f635935a64ab37884c025d70abb0ed731c094](https://github.com/shlokkhemani/openpoke/tree/5b5f635935a64ab37884c025d70abb0ed731c094).
This is a static source inspection of that revision. It is not deployed, load,
failure-recovery, live-model, or production-qualification evidence.

### What fails first

The first process-replacement failure is command admission, before streaming or
worker throughput becomes the limiting factor:

```text
browser POST
  -> chat proxy POST (stream: false)
  -> chat_send
  -> handle_chat_request
  -> asyncio.create_task(InteractionAgentRuntime.execute(...))
  -> empty HTTP 202 returned
       X process exits: acknowledged work has no durable command or owner
  -> non-streaming OpenRouter completion
  -> optional in-process execution task and direct external action
  -> reply appended to one local conversation file
  -> browser polls global history and guesses which reply completed its turn
```

The call graph is confirmed by the exported UI
[POST](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/web/app/api/chat/route.ts#L22-L56),
[chat_send](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/routes/chat.py#L10-L45),
[handle_chat_request](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/conversation/chat_handler.py#L22-L49),
[InteractionAgentRuntime.execute](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/agents/interaction_agent/runtime.py#L65-L89),
and
[request_chat_completion](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/openrouter_client/client.py#L49-L82).
The loss after 202 is an inference from the absence of a durable admission
record between task creation and acknowledgement. No crash experiment was run.

### Source facts and scale implications

| Seam | Confirmed in the pinned source | Inference for process replacement, multiple devices, or horizontal scale |
| --- | --- | --- |
| Command | [ChatRequest](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/models/chat.py#L26-L35) carries messages, model, system, and stream, but no Principal, Thread, command identity, idempotency key, or expected position. `handle_chat_request` extracts the latest user text, schedules an event-loop task, and returns an empty 202. | A crash can erase acknowledged work. A client retry has no stable identity with which to distinguish replay from a new command. |
| Response delivery | The UI proxy sends `stream: false`; the OpenRouter client also sends `stream: false` and buffers one JSON response. Browser [sendMessage](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/web/app/page.tsx#L110-L190) polls global history for up to 30 seconds, matching equal user text and the last assistant message. | There is no cursor or response-stream resume point. Concurrent devices or equal messages can attribute another turn's last reply to the wrong request. |
| Conversation state | [ConversationLog](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/conversation/log.py#L19-L82) owns one fixed local file and a process-local thread lock; [get_conversation_log](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/conversation/log.py#L214-L218) returns its module singleton. The runtime reads the transcript before appending the new user message. | Separate replicas can diverge on separate disks. The lock cannot serialize processes, and concurrent turns can read the same predecessor and interleave. |
| Authentication and isolation | FastAPI [app](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/app.py#L49-L83) installs CORS, routes, a scheduler, and a watcher. The chat send, history, and global clear handlers have no authentication dependency. Gmail exposes one process-global [get_active_gmail_user_id](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/gmail/client.py#L18-L40), while browser [ensureUserId](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/web/components/SettingsModal.tsx#L122-L149) creates a localStorage identifier. | A second user is not isolated from global chat state, and replicas can select different active Gmail users. The device-generated identifier is not an authenticated Principal. |
| Persistence | `ConversationLog` and [WorkingMemoryLog](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/conversation/summarization/working_memory_log.py#L16-L48) use fixed host-local files. [TriggerStore](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/triggers/store.py#L13-L68) uses local SQLite. | Host replacement can lose state, and independent replicas do not share one conversation, account, or scheduling authority. Local locks do not make these stores multi-process safe. |
| Workers | Every API process starts its own scheduler and email watcher. [TriggerScheduler](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/trigger_scheduler.py#L26-L116) keeps `_in_flight` in memory, creates a task for due work, and advances the schedule only after execution succeeds. | Replicas can select the same due trigger. A crash after an external effect but before schedule advancement permits repeat execution. |
| Queue and capacity | Interactive dispatch uses one process-global [ExecutionBatchManager](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/agents/execution_agent/batch_manager.py#L36-L145). Its pending map, lock, and single current batch are memory-only. Dispatch uses event-loop tasks, and the [requirements](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/requirements.txt#L1-L7) list no broker client. | There is no durable bounded queue, capacity admission, claim lease, fencing, or cross-process handoff. Unrelated concurrent turns can join one process-global batch, and queued work disappears with the process. |
| External actions | [gmail_execute_draft](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/agents/execution_agent/tools/gmail.py#L375-L427) and the sibling send operations enter [_execute](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/agents/execution_agent/tools/gmail.py#L324-L343), which calls the public [execute_gmail_tool](https://github.com/shlokkhemani/openpoke/blob/5b5f635935a64ab37884c025d70abb0ed731c094/server/services/gmail/client.py#L466-L494) before recording success or failure. `gmail_execute_draft` accepts only a provider draft ID, with no durable ToolCall identity reused as an Action or stable idempotency key. | A lost provider acknowledgement creates an unknown outcome. Retrying can duplicate a send, forward, or reply because no durable Action Attempt recorded before contact or ActionReceipt supports reconciliation. |

### Prioritized improvement sequence

1. Authenticate a Principal, then scope every command, history read, clear,
   stream, Gmail binding, trigger, and tool action to a Principal and Thread.
2. Before returning 202, atomically commit the idempotent command, UserMessage,
   ThreadPosition, Acceptance Receipt, capacity decision, root AgentRun, and
   outbox record in shared PostgreSQL.
3. Persist immutable ThreadEvents before delivery. Replace global history
   polling with an opaque ThreadCursor, ordered replay, and one transition to
   live SSE for every independently authenticated device.
4. Move execution behind a bounded durable broker and point-addressed database
   claims. Add finite leases, monotonic fencing, harmless redelivery, explicit
   queue depth, and admission shedding before overload.
5. Classify effectful ToolCalls as Actions and retain the ToolCall identity.
   Evaluate the Operation Gate, require Approval only when it resolves to
   `require approval`, record an Action Attempt before contact, pass provider
   idempotency where supported, reconcile uncertainty, and publish an
   ActionReceipt.
6. Move triggers, working memory, roster, Gmail connection and seen state,
   timezone, and journals into account-scoped shared storage. Claim due work
   atomically so only one worker owns it.
7. Split transport, relay, and workers into replaceable deployment roles, then
   qualify process loss, multi-device ordering, overload, recovery, saturation,
   and cost. The source inspection alone proves none of those production gates.
