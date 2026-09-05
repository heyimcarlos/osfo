(.userExists or .agentExists or .authSessionExists or .deletionCaseExists or
      .channelLinkExists or .acceptedInviteExists or .channelAuditExists or
      .billingExists or .allowanceExists or .whatsAppWakeUpExists or
      .whatsAppWakeUpSourceExists or .researchReportExists or
      .researchProviderOperationExists or .researchSynthesisOperationExists or
      .researchNotificationExists or .documentBuildExists or
      .documentNotificationExists or .documentAccountingExists or
      .documentUsageEventExists or .phoneVerificationExists) == false and
      .agentRuntime.inspectable == false and .agentRuntime.registered == false and
      .accountHttp.presentationRequests == $presentationRequests and
      .accountHttp.presentationSuccesses == $presentationRequests and
      .accountHttp.deleteRequests == $deleteRequests and
      .accountHttp.deleteSuccesses == $deleteRequests and
      .targetR2Exists == false and .unrelatedR2Exists == true and
      (.researchProofExpected == false or
        (.researchManifestExists == false and .researchSourceExists == false and
          .researchSynthesisExists == false and
          .researchArtifactExists == false))
