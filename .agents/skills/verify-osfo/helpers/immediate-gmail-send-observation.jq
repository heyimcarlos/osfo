def exact_presentation($recipient; $subject; $body):
  .title == "Send Gmail message" and
  .description == "Send the exact Gmail message shown here." and
  .consequences == ["Send this exact message to the listed external recipients."] and
  .fields == [
    {"label":"Gmail mailbox","name":"gmailResource","value":"primary"},
    {"label":"Integration manifest","name":"manifestVersion","value":"gmail-v1"},
    {"label":"Recipients","name":"recipients","value":([$recipient] | tojson)},
    {"label":"Subject","name":"subject","value":$subject},
    {"label":"Message","name":"body","value":$body}
  ];

def exact_browser($recipient; $subject; $body):
  type == "object" and
  .action == {
    control: "Approve exact Gmail send",
    decision: "approve",
    visibleConsequence: "Send this exact message to the listed external recipients.",
    visibleFields: {
      body: $body,
      gmailResource: "primary",
      manifestVersion: "gmail-v1",
      recipients: [$recipient],
      subject: $subject
    },
    visibleTitle: "Send Gmail message"
  } and
  .result == {
    approvedNotice: "Immediate Gmail send approved.",
    outcome: "Gmail message sent",
    replayView: {
      pendingApprovalCount: 0,
      terminalCardCount: 1,
      terminalStatus: "applied"
    }
  };

(.durable.actionId | type == "string" and length > 0) and
(.durable.presentationId | type == "string" and length > 0) and
(.durable.userId | type == "string" and length > 0) and
(.durable.approvalConnectionBinding | test("^[0-9a-f]{64}$")) and
.durable.presentation.actionId == .durable.actionId and
.durable.presentation.presentationId == .durable.presentationId and
(.durable.presentation | exact_presentation($recipient; $subject; $body)) and
.durable.terminal.actionId == .durable.actionId and
.durable.terminal.presentationId == .durable.presentationId and
.durable.terminal.userId == .durable.userId and
.durable.terminal.status == "applied" and
.durable.integrationAction._tag == "Applied" and
.durable.integrationAction.result.operation == "GMAIL_SEND_EMAIL" and
.durable.integrationAction.result.toolkit == "gmail" and
(.durable.integrationAction.providerRequestId | type == "string" and length > 0) and
(.durable.integrationAction.result.evidence.providerLogId | type == "string" and length > 0) and
(.durable.integrationAction.result.evidence.providerResourceId | type == "string" and length > 0) and
.postgres.userId == .durable.userId and
(.postgres.agentId | type == "string" and length > 0) and
(.postgres.authSessionId | type == "string" and length > 0) and
.postgres.gmailSendUsage == [{
  allowanceKind: "gmailSends",
  basis: "observed",
  quantity: "1",
  sourceId: .durable.actionId,
  sourceType: "integrationAction"
}] and
.http.approvalRequests == 1 and .http.approvalSuccesses == 1 and
(.provider.integration | length) == 1 and
.provider.integration[0].providerTool == "GMAIL_SEND_EMAIL" and
.provider.integration[0].input == {
  body: $body,
  recipient_email: $recipient,
  subject: $subject
} and
.provider.integration[0].connectionBinding == .durable.approvalConnectionBinding and
.provider.integration[0].providerRequestId == .durable.integrationAction.providerRequestId and
.provider.integration[0].logId == .durable.integrationAction.result.evidence.providerLogId and
.provider.integration[0].providerResourceId == .durable.integrationAction.result.evidence.providerResourceId and
(.provider.model | length) == 1 and
.provider.model[0].kind == "tool-selection" and
.provider.model[0].selectedTool == "gmailSendEmail" and
(.provider.model[0].operationId as $modelOperationId |
  (.durable.actionId | startswith($modelOperationId + "::cf-wai-tool-call::"))) and
.provider.model[0].subject == ($recipient + "|" + $subject + "|" + $body) and
(.browser | exact_browser($recipient; $subject; $body)) and
.replayQualification == {
  commit: $commit,
  guarantee: "second approval POST rejected with provider and accounting ledgers unchanged",
  result: "PASS",
  test: "uses trusted Agent setup, then proves public immediate Gmail approval and status HTTP"
}
