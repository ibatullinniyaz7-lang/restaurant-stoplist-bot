PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS participants (
  chat_id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  username TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dishes (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  price INTEGER,
  sort_order INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  is_stopped INTEGER NOT NULL DEFAULT 0 CHECK (is_stopped IN (0, 1)),
  updated_at TEXT,
  updated_by_chat_id INTEGER,
  UNIQUE (category_id, name)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_id INTEGER NOT NULL REFERENCES dishes(id),
  new_status INTEGER NOT NULL CHECK (new_status IN (0, 1)),
  actor_chat_id INTEGER NOT NULL,
  actor_name TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_dishes_category ON dishes(category_id, active, sort_order);
CREATE INDEX IF NOT EXISTS idx_dishes_stopped ON dishes(is_stopped, active);
CREATE INDEX IF NOT EXISTS idx_audit_changed_at ON audit_log(changed_at);

INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES
  (1, 'Закуски', 10),
  (2, 'Горячие закуски', 20),
  (3, 'Салаты', 30),
  (4, 'Блюда из мяса', 40),
  (5, 'Рыбные блюда', 50),
  (6, 'Блюда на углях', 60);

INSERT OR IGNORE INTO dishes (id, category_id, name, price, sort_order) VALUES
  (1, 1, 'Казылык', 850, 10),
  (2, 1, 'Ханское пиршество', 5000, 20),
  (3, 1, 'Бастурма', 750, 30),
  (4, 1, 'Каклаган каз', 1100, 40),
  (5, 1, 'Айгыз', 830, 50),
  (6, 1, 'Брускетта с запеченной уткой', 480, 60),
  (7, 1, 'Брускетты с конским загривком (6 шт.)', 620, 70),
  (8, 1, 'Каклаган урдэк', 1100, 80),
  (9, 1, 'Тэмле сырлар', 1600, 90),
  (10, 1, 'Бэрэнге белэн селедка', 520, 100),
  (11, 1, 'Яшелчэ', 990, 110),
  (12, 1, 'Урман булэге', 380, 120),
  (13, 1, 'Тозланма', 620, 130),
  (14, 2, 'Карта из конины', 720, 10),
  (15, 2, 'Тутырма «Туган Авылым»', 720, 20),
  (16, 2, 'Татарча урдэк', 880, 30),
  (17, 3, 'Туган Авылым', 750, 10),
  (18, 3, 'Итле', 790, 20),
  (19, 3, 'Тэмле Урдэк', 640, 30),
  (20, 3, 'Урдэк Оливьесы', 560, 40),
  (21, 3, 'Язлы', 730, 50),
  (22, 3, 'Биляр', 540, 60),
  (23, 3, 'Кызыл', 560, 70),
  (24, 4, 'Хан ризыгы', 720, 10),
  (25, 4, 'Батыр ризыгы', 1190, 20),
  (26, 4, 'Татарча Азу', 790, 30),
  (27, 4, 'Милли ашы', 830, 40),
  (28, 4, 'Сююмбике', 850, 50),
  (29, 4, 'Курбан байрам', 1580, 60),
  (30, 4, 'Кыздырма', 1350, 70),
  (31, 4, 'Акбаш', 1350, 80),
  (32, 4, 'Татлы ризык', 860, 90),
  (33, 4, 'Камыр Батыр', 790, 100),
  (34, 4, 'Казанское ханство', NULL, 110),
  (35, 5, 'Тэмле балык', 910, 10),
  (36, 5, 'Алтын балык', 810, 20),
  (37, 5, 'Тэмле борыч', 1800, 30),
  (38, 6, 'Люля-кебаб из курицы', 740, 10),
  (39, 6, 'Люля-кебаб из баранины', 1200, 20),
  (40, 6, 'Шашлык из баранины', 1250, 30),
  (41, 6, 'Шашлык из конины', 2150, 40),
  (42, 6, 'Шашлык из курицы', 740, 50),
  (43, 6, 'Кунак сые', 3700, 60),
  (44, 6, 'Шашлык из осетрины', 1950, 70);

