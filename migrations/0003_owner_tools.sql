ALTER TABLE participants
ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0
CHECK (blocked IN (0, 1));

CREATE TABLE IF NOT EXISTS owner_state (
  user_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_participants_access
ON participants(active, blocked, joined_at);

