def events_for($agent_run_id):
  [.[] | select(.payload.agentRunId? == $agent_run_id)];

events_for($agent_run_id) as $events
| if any($events[]; .eventType == "AgentRunFailed") then
    "failed"
  elif any($events[]; .eventType == "AgentRunCanceled") then
    "canceled"
  elif
    any($events[]; .eventType == "AssistantOutputCompleted")
    and any($events[]; .eventType == "AgentRunSucceeded")
  then
    "succeeded"
  else
    "pending"
  end
