if length != 1 then error("expected one provider execution") else . end |
.[0] | . as $execution | select(
  .userId == $userId and .providerTool == "GMAIL_SEND_EMAIL" and
  (.providerSessionId | type == "string" and length > 0) and
  ([$sessions[] | select(.providerSessionId == $execution.providerSessionId)] == [{
    providerSessionId: $execution.providerSessionId,
    userId: $userId
  }]) and
  .input == {
    body: $body,
    is_html: false,
    recipient_email: $recipient,
    subject: $subject,
    user_id: "me"
  } and
  .providerRequestId == $requestId and .logId == $logId and .resourceId == $resourceId
)
