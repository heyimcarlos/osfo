ALTER TABLE "threads" ADD COLUMN "state_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_events" DROP CONSTRAINT "thread_events_payload_shape_check";--> statement-breakpoint
ALTER TABLE "thread_events" DISABLE TRIGGER "thread_events_immutable";--> statement-breakpoint
UPDATE "thread_events" event
SET "payload" = event."payload" || jsonb_build_object(
  'content', jsonb_build_array(jsonb_build_object('type', 'text', 'text', message."content"))
)
FROM "user_messages" message
WHERE message."user_message_id" = event."user_message_id";--> statement-breakpoint
ALTER TABLE "thread_events" ENABLE TRIGGER "thread_events_immutable";--> statement-breakpoint
UPDATE "threads" thread
SET "state_revision" = (
  SELECT count(*)::integer
  FROM "thread_events" event
  WHERE event."thread_id" = thread."thread_id"
);--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_payload_content_check" CHECK (jsonb_typeof("payload" -> 'content') = 'array'
        AND jsonb_array_length("payload" -> 'content') = 1
        AND ("payload" -> 'content' -> 0) = jsonb_build_object(
          'type', 'text',
          'text', "payload" -> 'content' -> 0 ->> 'text'
        )
        AND length("payload" -> 'content' -> 0 ->> 'text') BETWEEN 1 AND 16384);--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_state_revision_check" CHECK ("state_revision" >= 0);--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_payload_shape_check" CHECK ("payload" = jsonb_build_object(
        'userMessageId', "payload" ->> 'userMessageId',
        'agentRunId', "payload" ->> 'agentRunId',
        'content', "payload" -> 'content'
      ));
