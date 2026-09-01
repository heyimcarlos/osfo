#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
control="$repo_root/.agents/skills/verify-osfo/helpers/control-osfo"
observer="$repo_root/apps/worker/test/support/agent-runtime-observer.ts"

if ! "$control" help | grep -F -q 'conversation-memory'; then
  printf 'conversation-memory must be listed in verifier help\n' >&2
  exit 1
fi
if ! grep -F -q 'getSubAgentByName' "$observer"; then
  printf 'conversation-memory observation must use the installed sub-Agent RPC helper\n' >&2
  exit 1
fi
if ! grep -F -q 'conversation === "1"' "$observer"; then
  printf 'conversation history must require the explicit observer query flag\n' >&2
  exit 1
fi
if ! grep -F -q 'path == "/v4/search"' "$control"; then
  printf 'conversation-memory must require an empty local Supermemory search response\n' >&2
  exit 1
fi
if ! grep -F -q 'features/conversation-memory.md' "$repo_root/.agents/skills/verify-osfo/SKILL.md"; then
  printf 'the verifier skill must route conversation-memory to its feature drive\n' >&2
  exit 1
fi
if [[ ! -s "$repo_root/.agents/skills/verify-osfo/features/conversation-memory.md" ]]; then
  printf 'conversation-memory needs an authoritative feature drive\n' >&2
  exit 1
fi

fixture_dir="$(mktemp -d)"
trap 'rm -r -- "$fixture_dir"' EXIT
run_id='verify-memory-fixture'
state_file="$fixture_dir/state.json"
provider_file="$fixture_dir/provider.json"
jq --null-input \
  --arg corrected "cedar-cocoa-$run_id" \
  --arg superseded "spruce-soda-$run_id" \
  '{
    inspectable: true,
    identity: { activeTelegramLinkCount: 1 },
    registered: true,
    conversation: {
      _tag: "ConversationEvidence",
      agent: { currentSessionId: "session-current" },
      route: {
        currentSessionId: "session-current",
        historicalSessionIds: ["session-old"]
      },
      historicalSessions: [{
        _tag: "SessionHistoryFound",
        sessionId: "session-old",
        messages: [
          {
            id: "message-ordinary-user",
            role: "user",
            parts: [{
              type: "text",
              text: "Give me a normal run-owned reply for verify-memory-fixture."
            }]
          },
          {
            id: "message-ordinary-assistant",
            role: "assistant",
            parts: [{
              type: "text",
              text: "Committed Osfo result: Give me a normal run-owned reply for verify-memory-fixture."
            }]
          },
          {
            id: "message-initial-user",
            role: "user",
            parts: [{
              type: "text",
              text: ("Remember that my run-owned verification drink is " + $superseded + ".")
            }]
          },
          {
            id: "message-initial-assistant",
            role: "assistant",
            parts: [
              {
                type: "tool-set_context",
                state: "output-available",
                toolCallId: "verification-set_context-initial::cf-wai-tool-call::fixture-initial"
              },
              { type: "text", text: "I remembered your run-owned verification drink." }
            ]
          },
          {
            id: "message-correction-user",
            role: "user",
            parts: [{
              type: "text",
              text: ("Correction: remember that my run-owned verification drink is " + $corrected + ", not " + $superseded + ".")
            }]
          },
          {
            id: "message-correction-assistant",
            role: "assistant",
            parts: [
              {
                type: "tool-set_context",
                state: "output-available",
                toolCallId: "verification-set_context-correction::cf-wai-tool-call::fixture-correction"
              },
              { type: "text", text: "I corrected your run-owned verification drink." }
            ]
          }
        ]
      }],
      currentSession: {
        _tag: "SessionHistoryFound",
        sessionId: "session-current",
        messages: [
          {
            id: "message-question",
            role: "user",
            parts: [{ type: "text", text: "What is my run-owned verification drink?" }]
          },
          {
            id: "message-answer",
            role: "assistant",
            parts: [
              { type: "step-start" },
              {
                type: "text",
                text: ("Your run-owned verification drink is " + $corrected + "."),
                state: "done"
              }
            ]
          }
        ]
      }
    }
  }' >"$state_file"
jq --null-input \
  --arg corrected "cedar-cocoa-$run_id" \
  --arg runId "$run_id" \
  --arg superseded "spruce-soda-$run_id" \
  '{
    model: [
      {
        kind: "tool-selection",
        operationId: "verification-set_context-initial",
        selectedTool: "set_context",
        arguments: {
          action: "append",
          block: "userContext",
          content: ("My run-owned verification drink is " + $superseded + ".")
        }
      },
      {
        kind: "tool-selection",
        operationId: "verification-set_context-correction",
        selectedTool: "set_context",
        arguments: {
          action: "replace",
          block: "userContext",
          content: ("My run-owned verification drink is " + $corrected + ".")
        }
      },
      {
        kind: "agent",
        latestAgentSequence: 12,
        operationId: null,
        sequence: 12,
        subject: "{\"content\":\"What is my run-owned verification drink?\",\"role\":\"user\"}",
        recallRequest: {
          copiedHistoricalTurnCount: 0,
          correctedOutsideUserContextCount: 0,
          nonSystemMessages: [
            { content: "What is my run-owned verification drink?", role: "user" }
          ],
          requestMessageCount: 2,
          supersededCount: 0,
          systemMessageCount: 1,
          userContextSections: [
            ("My run-owned verification drink is " + $corrected + ".")
          ]
        }
      }
    ],
    telegram: [
      { body: ({ text: ("Committed Osfo result: Give me a normal run-owned reply for " + $runId + ".") } | tojson) },
      { body: ({ text: "Started a new Osfo session." } | tojson) },
      { body: ({ text: ("Your run-owned verification drink is " + $corrected + ".") } | tojson) }
    ],
    supermemory: {
      containers: [],
      ledger: [
        {
          method: "POST",
          path: "/v4/profile",
          dynamicProfileCount: 0,
          staticProfileCount: 0,
          searchResultCount: 0,
          sequence: 10
        },
        { method: "POST", path: "/v4/search", searchResultCount: 0, sequence: 11 }
      ]
    }
  }' >"$provider_file"

"$control" assert-conversation-memory-evidence "$run_id" "$state_file" "$provider_file"

for availability_field in registered inspectable; do
  jq --arg field "$availability_field" '.[$field] = false' \
    "$state_file" >"$fixture_dir/$availability_field-false.json"
  if "$control" assert-conversation-memory-evidence \
    "$run_id" "$fixture_dir/$availability_field-false.json" "$provider_file"; then
    printf '%s=false must fail Conversation Memory evidence\n' "$availability_field" >&2
    exit 1
  fi
done
jq '.conversation.historicalSessions[0].messages = [{
  id: "synthetic-summary", role: "assistant",
  parts: [{ type: "text", text: "normal run-owned reply set_context summary" }]
}]' "$state_file" >"$fixture_dir/synthetic-history.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$fixture_dir/synthetic-history.json" "$provider_file"; then
  printf 'synthetic historical summaries must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq 'del(.conversation.historicalSessions[0].messages[3].parts[0])' \
  "$state_file" >"$fixture_dir/missing-session-write.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$fixture_dir/missing-session-write.json" "$provider_file"; then
  printf 'missing historical set_context traces must fail Conversation Memory evidence\n' >&2
  exit 1
fi
for invalid_tool_call_id in missing wrong-prefix empty-suffix malformed-extra; do
  case "$invalid_tool_call_id" in
  missing)
    jq 'del(.conversation.historicalSessions[0].messages[3].parts[0].toolCallId)' \
      "$state_file" >"$fixture_dir/$invalid_tool_call_id-tool-call-id.json"
    ;;
  wrong-prefix)
    jq '.conversation.historicalSessions[0].messages[3].parts[0].toolCallId =
      "unrelated-write::cf-wai-tool-call::fixture-initial"' \
      "$state_file" >"$fixture_dir/$invalid_tool_call_id-tool-call-id.json"
    ;;
  empty-suffix)
    jq '.conversation.historicalSessions[0].messages[3].parts[0].toolCallId =
      "verification-set_context-initial::cf-wai-tool-call::"' \
      "$state_file" >"$fixture_dir/$invalid_tool_call_id-tool-call-id.json"
    ;;
  malformed-extra)
    jq '.conversation.historicalSessions[0].messages[3].parts[0].toolCallId =
      "verification-set_context-initial::cf-wai-tool-call::fixture::cf-wai-tool-call::extra"' \
      "$state_file" >"$fixture_dir/$invalid_tool_call_id-tool-call-id.json"
    ;;
  esac
  if "$control" assert-conversation-memory-evidence \
    "$run_id" "$fixture_dir/$invalid_tool_call_id-tool-call-id.json" "$provider_file"; then
    printf '%s historical toolCallId must fail Conversation Memory evidence\n' \
      "$invalid_tool_call_id" >&2
    exit 1
  fi
done
jq '.conversation.historicalSessions[0].messages[5].parts[0].toolCallId =
  .conversation.historicalSessions[0].messages[3].parts[0].toolCallId' \
  "$state_file" >"$fixture_dir/duplicate-tool-call-id.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$fixture_dir/duplicate-tool-call-id.json" "$provider_file"; then
  printf 'historical set_context toolCallIds must be distinct\n' >&2
  exit 1
fi
jq '.conversation.currentSession.messages[1].parts += [{
  type: "reasoning", text: "arbitrary extra current Session content"
}]' "$state_file" >"$fixture_dir/extra-current-assistant-part.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$fixture_dir/extra-current-assistant-part.json" "$provider_file"; then
  printf 'extra current recall assistant parts must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq '.conversation.currentSession.messages += [.conversation.historicalSessions[0].messages[0]]' \
  "$state_file" >"$fixture_dir/copied-history.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$fixture_dir/copied-history.json" "$provider_file"; then
  printf 'copied historical messages must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq '.model += [.model[0]]' "$provider_file" >"$fixture_dir/third-set-context.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/third-set-context.json"; then
  printf 'a third set_context selection must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq '.model += [{ kind: "tool-selection", selectedTool: "sessionRecall" }]' \
  "$provider_file" >"$fixture_dir/session-recall.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/session-recall.json"; then
  printf 'Session Recall selection must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq --arg runId "$run_id" '.model[-1].recallRequest.nonSystemMessages += [{
  content: ("Give me a normal run-owned reply for " + $runId + "."), role: "user"
}] | .model[-1].recallRequest.requestMessageCount += 1' \
  "$provider_file" >"$fixture_dir/copied-recall-request.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/copied-recall-request.json"; then
  printf 'copied old turns in the recall model request must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq '.model[-1].recallRequest.copiedHistoricalTurnCount = 1' \
  "$provider_file" >"$fixture_dir/copied-assistant-recall-request.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/copied-assistant-recall-request.json"; then
  printf 'copied historical assistant replies must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq '.model[-1].latestAgentSequence = 13 |
  .model += [{ kind: "agent", operationId: null, subject: "later model request" }]' \
  "$provider_file" >"$fixture_dir/later-agent-request.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/later-agent-request.json"; then
  printf 'a later model request must fail final recall evidence\n' >&2
  exit 1
fi
jq '.model[-1].recallRequest.correctedOutsideUserContextCount = 1' \
  "$provider_file" >"$fixture_dir/corrected-outside-user-context.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/corrected-outside-user-context.json"; then
  printf 'corrected recall evidence outside User Context must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq --arg corrected "cedar-cocoa-$run_id" \
  '.model[-1].recallRequest.userContextSections = [
    ("Synthetic summary of an old Session. My run-owned verification drink is " + $corrected + ".")
  ]' "$provider_file" >"$fixture_dir/synthetic-user-context.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/synthetic-user-context.json"; then
  printf 'synthetic recall summaries in User Context must fail Conversation Memory evidence\n' >&2
  exit 1
fi
jq '(.supermemory.ledger[] | select(.path == "/v4/profile")).sequence = 7' \
  "$provider_file" >"$fixture_dir/uncorrelated-supermemory.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/uncorrelated-supermemory.json"; then
  printf 'earlier empty Supermemory calls must fail recall correlation\n' >&2
  exit 1
fi
jq '(.supermemory.ledger[] | select(.path == "/v4/search")).searchResultCount = 1' \
  "$provider_file" >"$fixture_dir/nonempty-search.json"
if "$control" assert-conversation-memory-evidence \
  "$run_id" "$state_file" "$fixture_dir/nonempty-search.json"; then
  printf 'nonempty Supermemory search must fail Conversation Memory evidence\n' >&2
  exit 1
fi

printf 'conversation memory verifier checks passed\n'
