import {
  createNotification,
  deliverNotificationBatch,
  notificationRecipientCount,
} from "./broadcast.js";
import { answerCallback, editMessage, sendMessage } from "./telegram.js";
import { commandName, escapeHtml, telegramUserLink } from "./ui.js";
import { isStaffBotEnabled } from "./settings.js";

const MAX_LENGTH = 1200;

async function setState(env, userId, action, payload = null) {
  await env.DB.prepare(`
    INSERT INTO interaction_state (user_id, action, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      action = excluded.action, payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
  `).bind(userId, action, payload).run();
}

async function clearState(env, userId) {
  await env.DB.prepare("DELETE FROM interaction_state WHERE user_id = ?").bind(userId).run();
}

async function getState(env, userId) {
  return env.DB.prepare("SELECT action, payload FROM interaction_state WHERE user_id = ? LIMIT 1").bind(userId).first();
}

export async function beginPublicAnnouncement(env, chatId, userId, messageId = null) {
  await setState(env, userId, "public_announcement_compose");
  const staffBotEnabled = await isStaffBotEnabled(env);
  const text = [
    "📣 <b>Объявление для команды</b>",
    "",
    "Отправьте следующим сообщением текст объявления.",
    staffBotEnabled
      ? "Его получат все сотрудники с активным доступом."
      : "Сейчас включён режим проверки: объявление получите только вы.",
    "",
    "Для отмены отправьте /cancel.",
  ].join("\n");
  const keyboard = { inline_keyboard: [[{ text: "Отмена", callback_data: "announce:cancel" }]] };
  if (messageId) return editMessage(env, chatId, messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}

export async function handlePublicAnnouncementMessage(message, env) {
  const userId = message.from?.id;
  if (!userId) return false;
  const state = await getState(env, userId);
  if (!state || !["public_announcement_compose", "public_announcement_preview"].includes(state.action)) return false;
  const text = message.text?.trim() ?? "";
  if (commandName(text) === "/cancel") {
    await clearState(env, userId);
    await sendMessage(env, message.chat.id, "Объявление отменено.");
    return true;
  }
  if (state.action !== "public_announcement_compose") return false;
  if (text.startsWith("/")) {
    await clearState(env, userId);
    return false;
  }
  if (!text) return false;
  if (text.length > MAX_LENGTH) {
    await sendMessage(env, message.chat.id, `Объявление слишком длинное. Максимум ${MAX_LENGTH} символов.`);
    return true;
  }
  await setState(env, userId, "public_announcement_preview", text);
  const staffBotEnabled = await isStaffBotEnabled(env);
  await sendMessage(env, message.chat.id, [
    "📣 <b>Предпросмотр объявления</b>",
    "",
    escapeHtml(text),
    "",
    `Отправитель: ${telegramUserLink(message.from)}`,
    "",
    staffBotEnabled ? "Отправить всем сотрудникам?" : "Отправить только владельцу?",
  ].join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{
          text: staffBotEnabled ? "📣 Отправить всем" : "🧪 Отправить только себе",
          callback_data: "announce:send",
        }],
        [{ text: "Отмена", callback_data: "announce:cancel" }],
      ],
    },
  });
  return true;
}

export async function handlePublicAnnouncementCallback(callback, env, origin) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  if (callback.data === "announce:start") {
    await answerCallback(env, callback.id);
    return beginPublicAnnouncement(env, chatId, callback.from.id, messageId);
  }
  if (callback.data === "announce:cancel") {
    await clearState(env, callback.from.id);
    await answerCallback(env, callback.id, "Отменено");
    return editMessage(env, chatId, messageId, "Объявление отменено.", { inline_keyboard: [] });
  }
  if (callback.data !== "announce:send") return null;
  const state = await getState(env, callback.from.id);
  if (state?.action !== "public_announcement_preview" || !state.payload) {
    return answerCallback(env, callback.id, "Черновик не найден", true);
  }
  await clearState(env, callback.from.id);
  const messageText = [
    "📣 <b>ОБЪЯВЛЕНИЕ</b>",
    "",
    escapeHtml(state.payload),
    "",
    `Отправил(а): ${telegramUserLink(callback.from)}`,
  ].join("\n");
  const notificationId = await createNotification(env, messageText, {
    kind: "announcement",
    createdByUserId: callback.from.id,
  });
  const recipientCount = await notificationRecipientCount(env);
  await answerCallback(env, callback.id, "Объявление отправляется");
  await deliverNotificationBatch(env, origin, notificationId);
  return editMessage(env, chatId, messageId, [
    "✅ <b>Объявление отправлено</b>",
    "",
    `Получателей: ${recipientCount}`,
  ].join("\n"), { inline_keyboard: [[{ text: "◀️ Главное меню", callback_data: "home" }]] });
}
