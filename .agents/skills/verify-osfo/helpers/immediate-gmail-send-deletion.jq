.immediateGmailProofExpected == true and
(.immediateGmailActionId | type == "string" and length > 0) and
(.immediateGmailPresentationId | type == "string" and length > 0) and
.immediateGmailDeletionFeature == "account-deletion-replay" and
.immediateGmailDeletionQualification == {
  commit: $commit,
  guarantee: "every Immediate Gmail owned key erased while unrelated Agent storage survives",
  result: "PASS",
  test: "deletes every immediate Gmail owned key without touching unrelated Agent storage"
} and
.immediateGmailProviderConnectionDeletion == {issue: "#187", status: "not-qualified"} and
.agentRuntime.inspectable == false and
.agentRuntime.registered == false and
.userExists == false
