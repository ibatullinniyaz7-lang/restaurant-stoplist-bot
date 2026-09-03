ALTER TABLE dishes ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'available';
ALTER TABLE dishes ADD COLUMN limited_quantity INTEGER;
ALTER TABLE dishes ADD COLUMN expected_at TEXT;

UPDATE dishes
SET availability_status = CASE WHEN is_stopped = 1 THEN 'stopped' ELSE 'available' END;

CREATE INDEX IF NOT EXISTS idx_dishes_availability
ON dishes(availability_status, expected_at, active);

ALTER TABLE audit_log ADD COLUMN new_availability_status TEXT;
ALTER TABLE audit_log ADD COLUMN status_details TEXT;

UPDATE audit_log
SET new_availability_status = CASE WHEN new_status = 1 THEN 'stopped' ELSE 'available' END
WHERE new_availability_status IS NULL;

CREATE TABLE IF NOT EXISTS interaction_state (
  user_id INTEGER PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'status';
ALTER TABLE notifications ADD COLUMN created_by_user_id INTEGER;
ALTER TABLE notifications ADD COLUMN deleted_at TEXT;

CREATE TABLE IF NOT EXISTS notification_deliveries (
  notification_id INTEGER NOT NULL REFERENCES notifications(id),
  chat_id INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT,
  PRIMARY KEY (notification_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_delete
ON notification_deliveries(notification_id, deleted_at, chat_id);

INSERT OR IGNORE INTO categories (id, name, sort_order, menu_type) VALUES
  (7, 'Выпечка', 70, 'kitchen'),
  (122, 'Кофе', 220, 'bar'),
  (123, 'Татарские напитки', 230, 'bar'),
  (124, 'Прохладительные напитки', 240, 'bar'),
  (125, 'Минеральная вода', 250, 'bar'),
  (126, 'Напитки Rich', 260, 'bar'),
  (127, 'Чайные напитки с травами', 270, 'bar'),
  (128, 'Чайные композиции', 280, 'bar'),
  (129, 'Зелёный чай', 290, 'bar'),
  (130, 'Чёрный чай', 300, 'bar');

INSERT OR IGNORE INTO dishes (id, category_id, name, price, sort_order) VALUES
  (45, 7, 'Очпочмак с говядиной (2 шт.)', 320, 10),
  (46, 7, 'Очпочмак с гусем', 240, 20),
  (47, 7, 'Очпочмак с уткой', 240, 30),
  (48, 7, 'Элеш с курицей', 200, 40),
  (49, 7, 'Перемяч с говядиной', 240, 50),
  (50, 7, 'Лепёшка', 160, 60),
  (51, 7, 'Кыстыбый', 240, 70),

  (1220, 122, 'Кофе «Крымских татар»', 300, 10),
  (1221, 122, 'Эспрессо', 300, 20),
  (1222, 122, 'Эспрессо допио', 350, 30),
  (1223, 122, 'Американо', 300, 40),
  (1224, 122, 'Капучино', 350, 50),
  (1225, 122, 'Латте', 350, 60),

  (1230, 123, 'Катык', 100, 10),
  (1231, 123, 'Айран с зеленью', 100, 20),

  (1240, 124, 'Морс смородиновый', 150, 10),
  (1241, 124, 'Морс клюквенный', 150, 20),

  (1250, 125, 'Волжанка с газом', 230, 10),
  (1251, 125, 'Волжанка без газа', 230, 20),

  (1260, 126, 'Rich Кола', 230, 10),
  (1261, 126, 'Rich Кола без сахара', 230, 20),
  (1262, 126, 'Rich Индиан Тоник', 230, 30),
  (1263, 126, 'Rich Биттер Лемон', 230, 40),
  (1264, 126, 'Сок Rich', 250, 50),

  (1270, 127, 'Туган Авылым', 490, 10),
  (1271, 127, 'Татарский чай', 490, 20),
  (1272, 127, 'Байлар', 490, 30),
  (1273, 127, 'Вкусная Казань', 490, 40),
  (1274, 127, 'Мэхэббэт чэчэклэре', 490, 50),
  (1275, 127, 'Рухи чай', 490, 60),

  (1280, 128, 'Цитрусовый чай', 750, 10),
  (1281, 128, 'Облепиховый со специями', 750, 20),
  (1282, 128, 'Малиново-смородиновый', 750, 30),

  (1290, 129, 'Зелёная сенча', 700, 10),
  (1291, 129, 'Молочный улонг', 700, 20),
  (1292, 129, 'Зелёный чай с жасмином', 700, 30),

  (1300, 130, 'Ассам', 490, 10),
  (1301, 130, 'Эрл грей', 490, 20);
