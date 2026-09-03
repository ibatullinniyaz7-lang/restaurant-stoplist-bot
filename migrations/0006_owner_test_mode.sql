CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL CHECK (setting_value IN ('0', '1')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by_user_id INTEGER
);

INSERT OR IGNORE INTO app_settings (setting_key, setting_value)
VALUES ('staff_bot_enabled', '1');
