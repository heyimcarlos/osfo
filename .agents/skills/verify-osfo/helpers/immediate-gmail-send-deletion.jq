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
.immediateGmailProviderConnectionDeletion.status == "deleted" and
.immediateGmailProviderConnectionDeletion.revokeOperationCount == 1 and
.immediateGmailProviderConnectionDeletion.deleteOperationCount == 1 and
.immediateGmailProviderConnectionDeletion.directProviderAbsence == true and
(.immediateGmailProviderConnectionDeletion.unrelatedConnectionBefore as $before |
  .immediateGmailProviderConnectionDeletion.unrelatedConnectionAfter == $before and
  ($before | keys | sort) == ["connectedAccountId", "status", "userId"] and
  ($before.connectedAccountId | type == "string" and length > 0) and
  $before.status == "ACTIVE" and
  ($before.userId | type == "string" and length > 0)) and
(.immediateGmailProviderConnectionDeletion.connectionBinding |
  test("^[0-9a-f]{64}$")) and
.agentRuntime.inspectable == false and
.agentRuntime.registered == false and
.userExists == false
