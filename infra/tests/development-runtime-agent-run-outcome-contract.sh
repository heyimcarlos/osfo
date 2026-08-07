#!/usr/bin/env bash

set -euo pipefail

filter=infra/tests/development-runtime-agent-run-outcome.jq
proof_run=96ae49eb-b1ab-41cb-a468-b68893ec82c3
other_run=71c5311f-9b88-480e-a6b3-f572c868a9a1

classify() {
  jq -r --arg agent_run_id "$proof_run" -f "$filter"
}

unrelated_success=$(jq -nc --arg run "$other_run" '[
  {eventType:"AssistantOutputCompleted",payload:{agentRunId:$run}},
  {eventType:"AgentRunSucceeded",payload:{agentRunId:$run}}
]')
[[ $(classify <<<"$unrelated_success") == pending ]]

proof_success=$(jq -nc --arg proof "$proof_run" --arg other "$other_run" '[
  {eventType:"AssistantOutputCompleted",payload:{agentRunId:$other}},
  {eventType:"AgentRunSucceeded",payload:{agentRunId:$other}},
  {eventType:"AssistantOutputCompleted",payload:{agentRunId:$proof}},
  {eventType:"AgentRunSucceeded",payload:{agentRunId:$proof}}
]')
[[ $(classify <<<"$proof_success") == succeeded ]]

proof_failure=$(jq -nc --arg proof "$proof_run" --arg other "$other_run" '[
  {eventType:"AssistantOutputCompleted",payload:{agentRunId:$other}},
  {eventType:"AgentRunSucceeded",payload:{agentRunId:$other}},
  {eventType:"AssistantOutputInterrupted",payload:{agentRunId:$proof,cause:"modelCallFailed"}},
  {eventType:"AgentRunFailed",payload:{agentRunId:$proof,cause:"modelCallFailed"}}
]')
[[ $(classify <<<"$proof_failure") == failed ]]

proof_cancellation=$(jq -nc --arg proof "$proof_run" '[
  {eventType:"AssistantOutputInterrupted",payload:{agentRunId:$proof,cause:"agentRunCanceled"}},
  {eventType:"AgentRunCanceled",payload:{agentRunId:$proof}}
]')
[[ $(classify <<<"$proof_cancellation") == canceled ]]

incomplete_success=$(jq -nc --arg proof "$proof_run" '[
  {eventType:"AssistantOutputCompleted",payload:{agentRunId:$proof}}
]')
[[ $(classify <<<"$incomplete_success") == pending ]]

printf 'PASS: development runtime AgentRun outcome correlation rejects unrelated and failed runs\n'
