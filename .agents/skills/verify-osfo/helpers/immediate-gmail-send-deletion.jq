.immediateGmailProofExpected == true and
(.immediateGmailActionId | type == "string" and length > 0) and
(.immediateGmailPresentationId | type == "string" and length > 0) and
.immediateGmailAgentFacetExists == false and
.immediateGmailConnectionStateExists == false and
.agentRuntime.inspectable == false and
.agentRuntime.registered == false and
.userExists == false
