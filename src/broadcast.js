import { deleteMessage, sendMessage, TelegramError } from "./telegram.js";
import { isStaffBotEnabled, ownerOnlyRecipients } from "./settings.js";

const BROADCAST_BATCH_SIZE = 35;
const DELETE_BATCH_SIZE = 35;

export async function createNotification(env, text, options = {}) {
  const result = await env.DB.prepare(`
    INSERT INTO notifications (message_text, created_at, kind, created_by_user_id)
    VALUES (?, CURRENT_TIMESTAMP, ?, ?)
  `).bind(
    text,
    options.kind ?? "status",
    options.createdByUserId ?? null,
  ).run();
  return Number(result.meta?.last_row_id);
}

function internalUrl(origin, path, afterChatId = 0) {
  const url = new URL(path, origin);
  url.searchParams.set("after", String(afterChatId));
  return url.toString();
}

export async function deliverNotificationBatch(env, origin, notificationId, afterChatId = 0) {
  const notification = await env.DB.prepare(`
    SELECT id, message_text, kind, deleted_at
    FROM notifications
    WHERE id = ? LIMIT 1
  `).bind(notificationId).first();
  if (!notification || notification.deleted_at) return;

  const staffBotEnabled = await isStaffBotEnabled(env);
  let recipients;
  if (staffBotEnabled) {
    const participants = await env.DB.prepare(`
      SELECT chat_id
      FROM participants
      WHERE active = 1 AND blocked = 0 AND chat_id > ?
      ORDER BY chat_id
      LIMIT ?
    `).bind(afterChatId, BROADCAST_BATCH_SIZE).all();
    recipients = participants.results ?? [];
  } else {
    recipients = ownerOnlyRecipients(env, afterChatId);
  }

  const results = await Promise.allSettled(
    recipients.map((participant) => sendMessage(env, participant.chat_id, notification.message_text)),
  );

  const statements = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const chatId = recipients[index].chat_id;
    if (result.status === "fulfilled" && notification.kind === "announcement") {
      statements.push(env.DB.prepare(`
        INSERT OR REPLACE INTO notification_deliveries
          (notification_id, chat_id, telegram_message_id, sent_at, deleted_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, NULL)
      `).bind(notificationId, chatId, result.value.message_id));
    }
    if (
      result.status === "rejected" &&
      result.reason instanceof TelegramError &&
      (result.reason.status === 403 ||
        (result.reason.status === 400 && result.reason.description.includes("chat not found")))
    ) {
      statements.push(
        env.DB.prepare("UPDATE participants SET active = 0 WHERE chat_id = ?").bind(chatId),
      );
    }
  }
  if (statements.length) await env.DB.batch(statements);

  if (recipients.length === BROADCAST_BATCH_SIZE) {
    const lastChatId = recipients[recipients.length - 1].chat_id;
    await fetch(internalUrl(origin, `/internal/broadcast/${notificationId}`, lastChatId), {
      headers: { "x-internal-secret": env.INTERNAL_SECRET },
    });
  } else {
    await env.DB.prepare(
      "UPDATE notifications SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(notificationId).run();
  }
}

export async function notificationRecipientCount(env) {
  if (!(await isStaffBotEnabled(env))) return ownerOnlyRecipients(env).length;
  const recipients = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM participants WHERE active = 1 AND blocked = 0",
  ).first();
  return Number(recipients?.count ?? 0);
}

export async function deleteAnnouncementBatch(env, origin, notificationId, afterChatId = 0) {
  const notification = await env.DB.prepare(`
    SELECT id, kind
    FROM notifications
    WHERE id = ? LIMIT 1
  `).bind(notificationId).first();
  if (!notification || notification.kind !== "announcement") {
    return { deleted: 0, failed: 0 };
  }

  await env.DB.prepare(`
    UPDATE notifications
    SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)
    WHERE id = ?
  `).bind(notificationId).run();

  const deliveries = await env.DB.prepare(`
    SELECT chat_id, telegram_message_id
    FROM notification_deliveries
    WHERE notification_id = ? AND deleted_at IS NULL AND chat_id > ?
    ORDER BY chat_id
    LIMIT ?
  `).bind(notificationId, afterChatId, DELETE_BATCH_SIZE).all();
  const rows = deliveries.results ?? [];
  const results = await Promise.allSettled(
    rows.map((row) => deleteMessage(env, row.chat_id, row.telegram_message_id)),
  );

  const updates = [];
  let deleted = 0;
  let failed = 0;
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].status === "fulfilled") {
      deleted += 1;
      updates.push(env.DB.prepare(`
        UPDATE notification_deliveries
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE notification_id = ? AND chat_id = ?
      `).bind(notificationId, rows[index].chat_id));
    } else {
      failed += 1;
    }
  }
  if (updates.length) await env.DB.batch(updates);

  if (rows.length === DELETE_BATCH_SIZE) {
    const lastChatId = rows[rows.length - 1].chat_id;
    await fetch(internalUrl(origin, `/internal/delete-announcement/${notificationId}`, lastChatId), {
      headers: { "x-internal-secret": env.INTERNAL_SECRET },
    });
  }
  return { deleted, failed };
}
