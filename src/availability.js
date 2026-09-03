import { createNotification } from "./broadcast.js";
import { changeNotification, displayName, normalizeStatus } from "./ui.js";

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

function toSqlUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function parseExpectedTime(input, now = new Date()) {
  const match = /^(?:(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+)?(\d{1,2})[:.](\d{2})$/.exec(
    String(input ?? "").trim(),
  );
  if (!match) return null;

  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;

  const moscowNow = new Date(now.getTime() + MOSCOW_OFFSET_MS);
  let year = moscowNow.getUTCFullYear();
  let month = moscowNow.getUTCMonth() + 1;
  let day = moscowNow.getUTCDate();
  const hasDate = Boolean(match[1]);

  if (hasDate) {
    day = Number(match[1]);
    month = Number(match[2]);
    if (match[3]) {
      year = Number(match[3]);
      if (year < 100) year += 2000;
    }
  }

  let target = new Date(Date.UTC(year, month - 1, day, hour - 3, minute, 0));
  const targetMoscow = new Date(target.getTime() + MOSCOW_OFFSET_MS);
  if (
    targetMoscow.getUTCFullYear() !== year ||
    targetMoscow.getUTCMonth() + 1 !== month ||
    targetMoscow.getUTCDate() !== day ||
    targetMoscow.getUTCHours() !== hour ||
    targetMoscow.getUTCMinutes() !== minute
  ) {
    return null;
  }

  if (!hasDate && target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  if (hasDate && target.getTime() <= now.getTime()) return null;
  return toSqlUtc(target);
}

async function dishById(env, dishId) {
  return env.DB.prepare(`
    SELECT d.id, d.name, d.category_id, d.is_stopped, d.availability_status,
           d.limited_quantity, d.expected_at,
           c.name AS category_name, c.menu_type
    FROM dishes d
    JOIN categories c ON c.id = d.category_id
    WHERE d.id = ? AND d.active = 1
    LIMIT 1
  `).bind(dishId).first();
}

export async function changeDishAvailability(env, actor, chatId, dishId, desiredStatus, details = {}) {
  const status = normalizeStatus(desiredStatus);
  const quantity = status === "limited" ? Number(details.quantity) : null;
  const expectedAt = status === "expected" ? details.expectedAt : null;
  if (status === "limited" && (!Number.isInteger(quantity) || quantity < 1 || quantity > 999)) {
    throw new Error("invalid_limited_quantity");
  }
  if (status === "expected" && !expectedAt) throw new Error("invalid_expected_time");

  const update = await env.DB.prepare(`
    UPDATE dishes
    SET availability_status = ?, limited_quantity = ?, expected_at = ?,
        is_stopped = ?, updated_at = CURRENT_TIMESTAMP, updated_by_chat_id = ?
    WHERE id = ? AND active = 1 AND (
      availability_status <> ? OR
      COALESCE(limited_quantity, -1) <> COALESCE(?, -1) OR
      COALESCE(expected_at, '') <> COALESCE(?, '')
    )
  `).bind(
    status,
    quantity,
    expectedAt,
    status === "stopped" ? 1 : 0,
    chatId,
    dishId,
    status,
    quantity,
    expectedAt,
  ).run();

  const dish = await dishById(env, dishId);
  if (!dish) return { changed: false, dish: null, notificationId: null };
  if ((update.meta?.changes ?? 0) === 0) return { changed: false, dish, notificationId: null };

  const statusDetails = status === "limited" ? String(quantity) : status === "expected" ? expectedAt : null;
  const actorName = typeof actor === "string" ? actor : displayName(actor);
  await env.DB.prepare(`
    INSERT INTO audit_log (
      dish_id, new_status, actor_chat_id, actor_name, changed_at,
      new_availability_status, status_details
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
  `).bind(
    dishId,
    status === "stopped" ? 1 : 0,
    chatId,
    actorName,
    status,
    statusDetails,
  ).run();

  const notificationText = changeNotification(dish, status, actor, { quantity, expectedAt });
  const notificationId = await createNotification(env, notificationText, {
    kind: "status",
    createdByUserId: typeof actor === "object" ? actor?.id : null,
  });
  return { changed: true, dish, notificationId };
}

export async function processExpectedStatuses(env, origin) {
  const result = await env.DB.prepare(`
    SELECT id, expected_at
    FROM dishes
    WHERE active = 1
      AND availability_status = 'expected'
      AND expected_at IS NOT NULL
      AND expected_at <= CURRENT_TIMESTAMP
    ORDER BY expected_at, id
    LIMIT 20
  `).all();

  for (const due of result.results ?? []) {
    const update = await env.DB.prepare(`
      UPDATE dishes
      SET availability_status = 'available', limited_quantity = NULL, expected_at = NULL,
          is_stopped = 0, updated_at = CURRENT_TIMESTAMP, updated_by_chat_id = 0
      WHERE id = ? AND active = 1 AND availability_status = 'expected'
        AND expected_at = ? AND expected_at <= CURRENT_TIMESTAMP
    `).bind(due.id, due.expected_at).run();
    if ((update.meta?.changes ?? 0) === 0) continue;

    const dish = await dishById(env, due.id);
    if (!dish) continue;
    await env.DB.prepare(`
      INSERT INTO audit_log (
        dish_id, new_status, actor_chat_id, actor_name, changed_at,
        new_availability_status, status_details
      ) VALUES (?, 0, 0, 'Автоматически', CURRENT_TIMESTAMP, 'available', NULL)
    `).bind(due.id).run();

    const notificationId = await createNotification(
      env,
      changeNotification(dish, "available", "Автоматически по заданному времени"),
      { kind: "status" },
    );
    const broadcastUrl = new URL(`/internal/broadcast/${notificationId}`, origin);
    const response = await fetch(broadcastUrl, {
      headers: { "x-internal-secret": env.INTERNAL_SECRET },
    });
    if (!response.ok) throw new Error(`automatic_broadcast_failed_${response.status}`);
  }
}
