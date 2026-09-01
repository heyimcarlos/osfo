if
  .actionId == $actionId and
  .presentationId == $presentationId and
  .deletionFeature == "account-deletion-replay" and
  .directoryAgent == {inspectable: false, registered: false} and
  .userExists == false and
  .ownedKeyDeletionQualification == {
    commit: $commit,
    guarantee: "every Immediate Gmail owned key erased while unrelated Agent storage survives",
    result: "PASS",
    test: "deletes every immediate Gmail owned key without touching unrelated Agent storage"
  } and
  (.observedAt | fromdateiso8601) > 0 and
  .providerConnectionDeletion.connectionBinding == $connectionBinding and
  .providerConnectionDeletion.deleteOperationCount == 1 and
  .providerConnectionDeletion.directProviderAbsence == true and
  .providerConnectionDeletion.revokeOperationCount == 1 and
  .providerConnectionDeletion.status == "deleted" and
  (.providerConnectionDeletion.unrelatedConnectionBefore as $before |
    .providerConnectionDeletion.unrelatedConnectionAfter == $before and
    ($before | keys | sort) == ["connectedAccountId", "status", "userId"] and
    ($before.connectedAccountId | type == "string" and length > 0) and
    $before.status == "ACTIVE" and
    ($before.userId | type == "string" and length > 0))
then
  {
    commit: $commit,
    result: "PASS"
  }
else
  error("Immediate Gmail finish evidence is invalid")
end
