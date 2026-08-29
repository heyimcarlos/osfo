.approvalPresentation.operation == "integration.effect" and
.approvalPresentation.actionDefinitionVersion == "osfo-scheduled-email-start-v1" and
.approvalPresentation.actionId == .actionId and
.approvalPresentation.fields == [
  { label: "Gmail mailbox", name: "gmailResource", value: "primary" },
  { label: "Recipients", name: "recipients", value: ([$recipient] | tojson) },
  { label: "Subject", name: "subject", value: $subject },
  { label: "Message", name: "body", value: $body },
  { label: "Send at", name: "scheduledAt", value: $dueAt }
]
