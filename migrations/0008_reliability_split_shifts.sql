-- Existing daily entries keep their identity. A split is an unpaid break inside it.
ALTER TABLE schedule_entries ADD COLUMN break_start TEXT;
ALTER TABLE schedule_entries ADD COLUMN break_end TEXT;
ALTER TABLE schedule_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER schedule_entry_revision AFTER UPDATE ON schedule_entries
WHEN NEW.revision = OLD.revision
BEGIN
  UPDATE schedule_entries SET revision = OLD.revision + 1 WHERE id = NEW.id;
END;
CREATE TABLE schedule_confirmations (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX schedule_confirmations_expiry ON schedule_confirmations(expires_at);
ALTER TABLE notifications ADD COLUMN event_key TEXT;
CREATE UNIQUE INDEX notifications_event_key ON notifications(event_key);
ALTER TABLE notifications ADD COLUMN audience_owner_chat_id INTEGER;
ALTER TABLE notifications ADD COLUMN audience_initialized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN lease_token TEXT;
ALTER TABLE notifications ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
CREATE TABLE notification_queue (
  notification_id INTEGER NOT NULL REFERENCES notifications(id),
  chat_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(notification_id, chat_id)
);
CREATE INDEX notification_queue_pending ON notification_queue(notification_id, state, next_attempt_at);
-- Legacy jobs may have already reached recipients without a receipt. Do not replay them.
UPDATE notifications SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP);
