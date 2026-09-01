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
  .providerConnectionDeletion == {
    connectionBinding: $connectionBinding,
    directProviderAbsence: true,
    status: "deleted",
    unrelatedConnectionPreserved: true
  }
then
  {
    commit: $commit,
    result: "PASS"
  }
else
  error("Immediate Gmail finish evidence is invalid")
end
