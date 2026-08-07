-- Custom SQL migration file, put your code below! --
CREATE FUNCTION notify_thread_event_insert() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('osfo_thread_events', NEW.thread_id::text);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER thread_events_notify_insert
AFTER INSERT ON thread_events
FOR EACH ROW
EXECUTE FUNCTION notify_thread_event_insert();
