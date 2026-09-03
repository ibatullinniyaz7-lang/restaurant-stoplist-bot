import {
  createNotification,
  deleteAnnouncementBatch,
  deliverNotificationBatch,
  notificationRecipientCount,
} from "./broadcast.js";
import { answerCallback, editMessage, sendMessage } from "./telegram.js";
import {
  commandName,
  escapeHtml,
  moscowTime,
  paginate,
  telegramUserLink,
} from "./ui.js";
import { showScheduleManager } from "./schedule.js";
import { isStaffBotEnabled, toggleStaffBotEnabled } from "./settings.js";

const STAFF_PAGE_SIZE = 8;
const HISTORY_PAGE_SIZE = 8;
const ANNOUNCEMENT_MAX_LENGTH = 3000;

export function isOwner(env, userId) {
  return Boolean(env.OWNER_USER_ID) && String(userId) === String(env.OWNER_USER_ID);
}

function ownerUser(row) {
  return { id: row.user_id, username: row.username };
}

function sqlTime(value) {
  if (!value) return "—";
  return moscowTime(new Date(`${String(value).replace(" ", "T")}Z`));
}

function dayLabel(value) {
  const [year, month, day] = String(value).split("-");
  return year && month && day ? `${day}.${month}.${year}` : String(value);
}

function accessLabel(participant) {
  if (participant.blocked) return "🛑 заблокирован";
  if (participant.active) return "✅ доступ активен";
  return "⛔ доступ удалён";
}

function shortName(value, max = 32) {
  const text = String(value ?? "Сотрудник");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function ownerHomeKeyboard(staffBotEnabled = true) {
  return {
    inline_keyboard: [
      [{
        text: staffBotEnabled ? "⏸ Отключить для сотрудников" : "▶️ Включить для всех",
        callback_data: "owner:toggle_staff_bot",
      }],
      [{ text: "👥 Сотрудники", callback_data: "owner:staff:0" }],
      [{ text: "📜 История действий", callback_data: "owner:history:0" }],
      [{ text: "📊 Статистика стопов", callback_data: "owner:stats" }],
      [{ text: "📢 Важное объявление", callback_data: "owner:announce" }],
      [{ text: "📣 Мои объявления", callback_data: "owner:announcements" }],
      [{ text: "📅 Управление сменами", callback_data: "owner:schedule" }],
      [{ text: "◀️ Главное меню", callback_data: "home" }],
    ],
  };
}

export async function showOwnerHome(env, chatId, edit = null) {
  const [counts, staffBotEnabled] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN active = 1 AND blocked = 0 THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked
      FROM participants
    `).first(),
    isStaffBotEnabled(env),
  ]);
  const text = [
    "👑 <b>Кабинет владельца</b>",
    "",
    staffBotEnabled
      ? "Статус бота: 🟢 <b>работает для всех</b>"
      : "Статус бота: 🧪 <b>режим проверки</b>",
    staffBotEnabled
      ? "Все сотрудники могут пользоваться ботом и получают уведомления."
      : "Для остальных бот временно отключён. Все уведомления получает только владелец.",
    ...(staffBotEnabled ? [] : [
      "",
      "Перед включением для всех закройте тестовые периоды смен, если они не нужны сотрудникам.",
    ]),
    "",
    `Всего зарегистрировано: <b>${Number(counts?.total ?? 0)}</b>`,
    `С активным доступом: <b>${Number(counts?.active ?? 0)}</b>`,
    `Заблокировано: <b>${Number(counts?.blocked ?? 0)}</b>`,
    "",
    "Этот раздел доступен только владельцу.",
  ].join("\n");
  const keyboard = ownerHomeKeyboard(staffBotEnabled);
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}

async function showStaff(env, chatId, messageId, page = 0) {
  const result = await env.DB.prepare(`
    SELECT chat_id, user_id, display_name, username, active, blocked
    FROM participants
    ORDER BY blocked, active DESC, joined_at, chat_id
  `).all();
  const pageData = paginate(result.results ?? [], page, STAFF_PAGE_SIZE);
  const rows = pageData.items.map((person) => [{
    text: `${person.blocked ? "🛑" : person.active ? "✅" : "⛔"} ${shortName(person.display_name)}`,
    callback_data: `owner:person:${person.chat_id}`,
  }]);

  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) {
      navigation.push({ text: "⬅️", callback_data: `owner:staff:${pageData.page - 1}` });
    }
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) {
      navigation.push({ text: "➡️", callback_data: `owner:staff:${pageData.page + 1}` });
    }
    rows.push(navigation);
  }
  rows.push([{ text: "◀️ Кабинет владельца", callback_data: "owner:home" }]);

  return editMessage(
    env,
    chatId,
    messageId,
    `👥 <b>Сотрудники</b>\n\nВсего аккаунтов: ${result.results?.length ?? 0}`,
    { inline_keyboard: rows },
  );
}

async function participantDetails(env, chatId) {
  return env.DB.prepare(`
    SELECT p.chat_id, p.user_id, p.display_name, p.username, p.active, p.blocked,
           p.joined_at, p.last_seen_at, COUNT(a.id) AS changes_count
    FROM participants p
    LEFT JOIN audit_log a ON a.actor_chat_id = p.chat_id
    WHERE p.chat_id = ?
    GROUP BY p.chat_id, p.user_id, p.display_name, p.username, p.active, p.blocked,
             p.joined_at, p.last_seen_at
    LIMIT 1
  `).bind(chatId).first();
}

async function showPerson(env, ownerChatId, messageId, personChatId) {
  const person = await participantDetails(env, personChatId);
  if (!person) {
    return editMessage(env, ownerChatId, messageId, "Сотрудник не найден.", ownerHomeKeyboard());
  }

  const text = [
    "👤 <b>Карточка сотрудника</b>",
    "",
    `Имя: ${telegramUserLink(ownerUser(person), person.display_name)}`,
    `Username: ${person.username ? `@${escapeHtml(person.username)}` : "не указан"}`,
    `Статус: ${accessLabel(person)}`,
    `Зарегистрирован: ${sqlTime(person.joined_at)} (МСК)`,
    `Последняя активность: ${sqlTime(person.last_seen_at)} (МСК)`,
    `Изменений стоп-листа: <b>${Number(person.changes_count ?? 0)}</b>`,
  ].join("\n");

  const rows = [[{
    text: "📜 История сотрудника",
    callback_data: `owner:personhistory:${person.chat_id}:0`,
  }]];
  if (!isOwner(env, person.user_id)) {
    if (person.blocked) {
      rows.push([{ text: "✅ Разблокировать", callback_data: `owner:restore:${person.chat_id}` }]);
    } else if (person.active) {
      rows.push([{ text: "🛑 Заблокировать", callback_data: `owner:confirm_block:${person.chat_id}` }]);
      rows.push([{ text: "⛔ Удалить доступ", callback_data: `owner:confirm_remove:${person.chat_id}` }]);
    } else {
      rows.push([{ text: "✅ Вернуть доступ", callback_data: `owner:restore:${person.chat_id}` }]);
      rows.push([{ text: "🛑 Заблокировать", callback_data: `owner:confirm_block:${person.chat_id}` }]);
    }
  }
  rows.push([{ text: "◀️ Список сотрудников", callback_data: "owner:staff:0" }]);
  return editMessage(env, ownerChatId, messageId, text, { inline_keyboard: rows });
}

async function showAccessConfirmation(env, ownerChatId, messageId, personChatId, action) {
  const person = await participantDetails(env, personChatId);
  if (!person || isOwner(env, person.user_id)) {
    return showOwnerHome(env, ownerChatId, { messageId });
  }
  const isBlock = action === "block";
  const text = [
    `${isBlock ? "🛑" : "⛔"} <b>${isBlock ? "Заблокировать сотрудника?" : "Удалить доступ сотрудника?"}</b>`,
    "",
    telegramUserLink(ownerUser(person), person.display_name),
    "",
    isBlock
      ? "Сотрудник не сможет войти даже по рабочей ссылке, пока вы его не разблокируете."
      : "Сотрудник перестанет получать уведомления. Позже он сможет снова войти по рабочей ссылке.",
  ].join("\n");
  return editMessage(env, ownerChatId, messageId, text, {
    inline_keyboard: [
      [{
        text: isBlock ? "Да, заблокировать" : "Да, удалить доступ",
        callback_data: `owner:${isBlock ? "block" : "remove"}:${person.chat_id}`,
      }],
      [{ text: "Отмена", callback_data: `owner:person:${person.chat_id}` }],
    ],
  });
}

async function changeAccess(env, ownerChatId, messageId, personChatId, action) {
  const person = await participantDetails(env, personChatId);
  if (!person || isOwner(env, person.user_id)) {
    return showOwnerHome(env, ownerChatId, { messageId });
  }
  if (action === "block") {
    await env.DB.prepare(
      "UPDATE participants SET active = 0, blocked = 1 WHERE chat_id = ?",
    ).bind(personChatId).run();
  } else if (action === "remove") {
    await env.DB.prepare(
      "UPDATE participants SET active = 0, blocked = 0 WHERE chat_id = ?",
    ).bind(personChatId).run();
  } else {
    await env.DB.prepare(
      "UPDATE participants SET active = 1, blocked = 0 WHERE chat_id = ?",
    ).bind(personChatId).run();
  }
  return showPerson(env, ownerChatId, messageId, personChatId);
}

function historyLine(row, includeActor) {
  const status = row.new_availability_status ?? (row.new_status ? "stopped" : "available");
  const action = {
    available: "✅ в продажу",
    limited: `⚠️ ограничение${row.status_details ? `: ${escapeHtml(row.status_details)} шт.` : ""}`,
    expected: `🕒 ожидается${row.status_details ? ` к ${sqlTime(row.status_details)} (МСК)` : ""}`,
    stopped: "🛑 на стоп",
  }[status] ?? "изменён";
  const lines = [
    `<b>${sqlTime(row.changed_at)}</b> — ${action}`,
    `${escapeHtml(row.dish_name)} · ${escapeHtml(row.category_name)}`,
  ];
  if (includeActor) {
    lines.push(`Сотрудник: ${telegramUserLink(ownerUser(row), row.actor_name)}`);
  }
  return lines.join("\n");
}

async function showHistory(env, chatId, messageId, page = 0, personChatId = null) {
  const offset = Math.max(Number(page) || 0, 0) * HISTORY_PAGE_SIZE;
  const where = personChatId == null ? "" : "WHERE a.actor_chat_id = ?";
  const statement = env.DB.prepare(`
    SELECT a.id, a.new_status, a.new_availability_status, a.status_details,
           a.actor_chat_id, a.actor_name, a.changed_at,
           d.name AS dish_name, c.name AS category_name,
           p.user_id, p.username
    FROM audit_log a
    JOIN dishes d ON d.id = a.dish_id
    JOIN categories c ON c.id = d.category_id
    LEFT JOIN participants p ON p.chat_id = a.actor_chat_id
    ${where}
    ORDER BY a.changed_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `);
  const result = personChatId == null
    ? await statement.bind(HISTORY_PAGE_SIZE + 1, offset).all()
    : await statement.bind(personChatId, HISTORY_PAGE_SIZE + 1, offset).all();
  const allRows = result.results ?? [];
  const hasNext = allRows.length > HISTORY_PAGE_SIZE;
  const rows = allRows.slice(0, HISTORY_PAGE_SIZE);

  let title = "📜 <b>История действий</b>";
  let backCallback = "owner:home";
  if (personChatId != null) {
    const person = await participantDetails(env, personChatId);
    title = `📜 <b>История: ${escapeHtml(person?.display_name ?? "Сотрудник")}</b>`;
    backCallback = `owner:person:${personChatId}`;
  }
  const text = rows.length
    ? [title, "", ...rows.flatMap((row) => [historyLine(row, personChatId == null), ""])].join("\n")
    : `${title}\n\nДействий пока нет.`;

  const nav = [];
  const prefix = personChatId == null ? "owner:history" : `owner:personhistory:${personChatId}`;
  if (page > 0) nav.push({ text: "⬅️", callback_data: `${prefix}:${page - 1}` });
  nav.push({ text: `Страница ${Number(page) + 1}`, callback_data: "noop" });
  if (hasNext) nav.push({ text: "➡️", callback_data: `${prefix}:${Number(page) + 1}` });
  return editMessage(env, chatId, messageId, text, {
    inline_keyboard: [nav, [{ text: "◀️ Назад", callback_data: backCallback }]],
  });
}

async function showStats(env, chatId, messageId) {
  const result = await env.DB.prepare(`
    SELECT date(changed_at, '+3 hours') AS day,
           SUM(CASE WHEN COALESCE(new_availability_status, CASE WHEN new_status = 1 THEN 'stopped' ELSE 'available' END) = 'stopped' THEN 1 ELSE 0 END) AS stopped,
           SUM(CASE WHEN COALESCE(new_availability_status, CASE WHEN new_status = 1 THEN 'stopped' ELSE 'available' END) = 'available' THEN 1 ELSE 0 END) AS returned,
           SUM(CASE WHEN new_availability_status = 'limited' THEN 1 ELSE 0 END) AS limited,
           SUM(CASE WHEN new_availability_status = 'expected' THEN 1 ELSE 0 END) AS expected,
           COUNT(DISTINCT actor_chat_id) AS employees
    FROM audit_log
    GROUP BY date(changed_at, '+3 hours')
    ORDER BY day DESC
    LIMIT 14
  `).all();
  const rows = result.results ?? [];
  const lines = ["📊 <b>Статистика стопов по дням</b>", ""];
  if (!rows.length) {
    lines.push("Изменений пока нет.");
  } else {
    for (const row of rows) {
      lines.push(
        `<b>${dayLabel(row.day)}</b>: 🛑 ${Number(row.stopped)} · ⚠️ ${Number(row.limited)} · 🕒 ${Number(row.expected)} · ✅ ${Number(row.returned)} · 👤 ${Number(row.employees)}`,
      );
    }
    lines.push("", "🛑 стоп · ⚠️ ограничение · 🕒 ожидание · ✅ продажа · 👤 сотрудников");
  }
  return editMessage(env, chatId, messageId, lines.join("\n"), {
    inline_keyboard: [[{ text: "◀️ Кабинет владельца", callback_data: "owner:home" }]],
  });
}

async function setOwnerState(env, userId, action, payload = null) {
  await env.DB.prepare(`
    INSERT INTO owner_state (user_id, action, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      action = excluded.action,
      payload = excluded.payload,
      updated_at = CURRENT_TIMESTAMP
  `).bind(userId, action, payload).run();
}

export async function clearOwnerState(env, userId) {
  await env.DB.prepare("DELETE FROM owner_state WHERE user_id = ?").bind(userId).run();
}

async function ownerState(env, userId) {
  return env.DB.prepare(
    "SELECT action, payload FROM owner_state WHERE user_id = ? LIMIT 1",
  ).bind(userId).first();
}

async function beginAnnouncement(env, chatId, messageId, userId) {
  await setOwnerState(env, userId, "announcement_compose");
  const staffBotEnabled = await isStaffBotEnabled(env);
  return editMessage(env, chatId, messageId, [
    "📢 <b>Важное объявление</b>",
    "",
    "Отправьте следующим сообщением текст объявления.",
    staffBotEnabled
      ? "Его получат все сотрудники с активным доступом."
      : "Сейчас включён режим проверки: объявление получите только вы.",
    "",
    "Для выхода отправьте /cancel.",
  ].join("\n"), {
    inline_keyboard: [[{ text: "Отмена", callback_data: "owner:announce_cancel" }]],
  });
}

export async function handleOwnerMessage(message, env) {
  if (!isOwner(env, message.from?.id)) return false;
  const state = await ownerState(env, message.from.id);
  if (state?.action !== "announcement_compose") return false;

  const text = message.text?.trim() ?? "";
  if (!text || text.startsWith("/")) return false;
  if (text.length > ANNOUNCEMENT_MAX_LENGTH) {
    await sendMessage(
      env,
      message.chat.id,
      `Объявление слишком длинное. Максимум ${ANNOUNCEMENT_MAX_LENGTH} символов.`,
    );
    return true;
  }

  await setOwnerState(env, message.from.id, "announcement_preview", text);
  const staffBotEnabled = await isStaffBotEnabled(env);
  await sendMessage(env, message.chat.id, [
    "📢 <b>Предпросмотр объявления</b>",
    "",
    escapeHtml(text),
    "",
    staffBotEnabled ? "Отправить всем сотрудникам?" : "Отправить только себе?",
  ].join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{
          text: staffBotEnabled ? "📢 Отправить всем" : "🧪 Отправить только себе",
          callback_data: "owner:announce_send",
        }],
        [{ text: "Отмена", callback_data: "owner:announce_cancel" }],
      ],
    },
  });
  return true;
}

function announcementSnippet(value, max = 34) {
  const text = String(value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/^📢\s*ВАЖНОЕ ОБЪЯВЛЕНИЕ\s*/i, "")
    .trim();
  return shortName(text || "Объявление", max);
}

async function showAnnouncements(env, chatId, messageId) {
  const result = await env.DB.prepare(`
    SELECT id, message_text, created_at, delivered_at, deleted_at
    FROM notifications
    WHERE kind = 'announcement'
    ORDER BY created_at DESC, id DESC
    LIMIT 12
  `).all();
  const announcements = result.results ?? [];
  const rows = announcements.map((announcement) => [{
    text: `${announcement.deleted_at ? "🗑" : "📢"} ${announcementSnippet(announcement.message_text)}`,
    callback_data: `owner:announcement:${announcement.id}`,
  }]);
  rows.push([{ text: "◀️ Кабинет владельца", callback_data: "owner:home" }]);
  return editMessage(
    env,
    chatId,
    messageId,
    announcements.length
      ? "📣 <b>Мои объявления</b>\n\nОткройте объявление, чтобы посмотреть или удалить его."
      : "📣 <b>Мои объявления</b>\n\nВы ещё не отправляли объявлений.",
    { inline_keyboard: rows },
  );
}

async function announcementDetails(env, notificationId) {
  return env.DB.prepare(`
    SELECT n.id, n.message_text, n.created_at, n.delivered_at, n.deleted_at,
           CASE WHEN n.created_at > datetime('now', '-48 hours') THEN 1 ELSE 0 END AS deletable,
           COUNT(d.chat_id) AS delivered_count,
           SUM(CASE WHEN d.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted_count
    FROM notifications n
    LEFT JOIN notification_deliveries d ON d.notification_id = n.id
    WHERE n.id = ? AND n.kind = 'announcement'
    GROUP BY n.id, n.message_text, n.created_at, n.delivered_at, n.deleted_at
    LIMIT 1
  `).bind(notificationId).first();
}

async function showAnnouncement(env, chatId, messageId, notificationId) {
  const announcement = await announcementDetails(env, notificationId);
  if (!announcement) return showAnnouncements(env, chatId, messageId);
  const text = [
    "📣 <b>Отправленное объявление</b>",
    `Дата: ${sqlTime(announcement.created_at)} (МСК)`,
    `Доставлено: ${Number(announcement.delivered_count ?? 0)}`,
    announcement.deleted_at
      ? `Удалено из чатов: ${Number(announcement.deleted_count ?? 0)}`
      : "Статус: отправлено",
    "",
    announcement.message_text,
  ].join("\n");
  const rows = [];
  if (!announcement.deleted_at && announcement.deletable) {
    rows.push([{ text: "🗑 Удалить у сотрудников", callback_data: `owner:announce_delete_confirm:${announcement.id}` }]);
  }
  if (!announcement.deleted_at && !announcement.deletable) {
    rows.push([{ text: "Удаление недоступно после 48 часов", callback_data: "noop" }]);
  }
  rows.push([{ text: "◀️ Мои объявления", callback_data: "owner:announcements" }]);
  return editMessage(env, chatId, messageId, text, { inline_keyboard: rows });
}

async function confirmAnnouncementDelete(env, chatId, messageId, notificationId) {
  const announcement = await announcementDetails(env, notificationId);
  if (!announcement || announcement.deleted_at || !announcement.deletable) {
    return showAnnouncement(env, chatId, messageId, notificationId);
  }
  return editMessage(env, chatId, messageId, [
    "🗑 <b>Удалить объявление?</b>",
    "",
    "Бот удалит это сообщение из личных чатов сотрудников.",
    "Telegram разрешает удаление сообщений только в течение 48 часов после отправки.",
  ].join("\n"), {
    inline_keyboard: [
      [{ text: "Да, удалить у всех", callback_data: `owner:announce_delete:${notificationId}` }],
      [{ text: "Отмена", callback_data: `owner:announcement:${notificationId}` }],
    ],
  });
}

async function sendAnnouncement(callback, env, ctx, origin) {
  const state = await ownerState(env, callback.from.id);
  if (state?.action !== "announcement_preview" || !state.payload) {
    return answerCallback(env, callback.id, "Черновик не найден", true);
  }
  await clearOwnerState(env, callback.from.id);
  const messageText = [
    "📢 <b>ВАЖНОЕ ОБЪЯВЛЕНИЕ</b>",
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
  return editMessage(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    `✅ <b>Объявление отправлено</b>\n\nПолучателей: ${recipientCount}`,
    {
      inline_keyboard: [
        [{ text: "🗑 Удалить объявление", callback_data: `owner:announce_delete_confirm:${notificationId}` }],
        [{ text: "📣 Открыть объявление", callback_data: `owner:announcement:${notificationId}` }],
        [{ text: "◀️ Кабинет владельца", callback_data: "owner:home" }],
      ],
    },
  );
}

export async function handleOwnerCallback(callback, env, ctx, origin) {
  const data = callback.data ?? "";
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;

  if (data === "owner:home") {
    await answerCallback(env, callback.id);
    return showOwnerHome(env, chatId, { messageId });
  }
  if (data === "owner:toggle_staff_bot") {
    const enabled = await toggleStaffBotEnabled(env, callback.from.id);
    await answerCallback(
      env,
      callback.id,
      enabled ? "Бот снова работает для всех" : "Режим проверки включён",
    );
    return showOwnerHome(env, chatId, { messageId });
  }
  if (data === "owner:stats") {
    await answerCallback(env, callback.id);
    return showStats(env, chatId, messageId);
  }
  if (data === "owner:schedule") {
    await answerCallback(env, callback.id);
    return showScheduleManager(env, chatId, messageId);
  }
  if (data === "owner:announce") {
    await answerCallback(env, callback.id);
    return beginAnnouncement(env, chatId, messageId, callback.from.id);
  }
  if (data === "owner:announce_cancel") {
    await clearOwnerState(env, callback.from.id);
    await answerCallback(env, callback.id, "Отменено");
    return showOwnerHome(env, chatId, { messageId });
  }
  if (data === "owner:announce_send") {
    return sendAnnouncement(callback, env, ctx, origin);
  }
  if (data === "owner:announcements") {
    await answerCallback(env, callback.id);
    return showAnnouncements(env, chatId, messageId);
  }

  const announcementMatch = /^owner:announcement:(\d+)$/.exec(data);
  if (announcementMatch) {
    await answerCallback(env, callback.id);
    return showAnnouncement(env, chatId, messageId, Number(announcementMatch[1]));
  }
  const confirmAnnouncementDeleteMatch = /^owner:announce_delete_confirm:(\d+)$/.exec(data);
  if (confirmAnnouncementDeleteMatch) {
    await answerCallback(env, callback.id);
    return confirmAnnouncementDelete(env, chatId, messageId, Number(confirmAnnouncementDeleteMatch[1]));
  }
  const announcementDeleteMatch = /^owner:announce_delete:(\d+)$/.exec(data);
  if (announcementDeleteMatch) {
    await answerCallback(env, callback.id, "Удаляю объявление");
    await deleteAnnouncementBatch(env, origin, Number(announcementDeleteMatch[1]));
    return showAnnouncement(env, chatId, messageId, Number(announcementDeleteMatch[1]));
  }

  const staffMatch = /^owner:staff:(\d+)$/.exec(data);
  if (staffMatch) {
    await answerCallback(env, callback.id);
    return showStaff(env, chatId, messageId, Number(staffMatch[1]));
  }
  const personMatch = /^owner:person:(\d+)$/.exec(data);
  if (personMatch) {
    await answerCallback(env, callback.id);
    return showPerson(env, chatId, messageId, Number(personMatch[1]));
  }
  const historyMatch = /^owner:history:(\d+)$/.exec(data);
  if (historyMatch) {
    await answerCallback(env, callback.id);
    return showHistory(env, chatId, messageId, Number(historyMatch[1]));
  }
  const personHistoryMatch = /^owner:personhistory:(\d+):(\d+)$/.exec(data);
  if (personHistoryMatch) {
    await answerCallback(env, callback.id);
    return showHistory(
      env,
      chatId,
      messageId,
      Number(personHistoryMatch[2]),
      Number(personHistoryMatch[1]),
    );
  }
  const confirmationMatch = /^owner:confirm_(block|remove):(\d+)$/.exec(data);
  if (confirmationMatch) {
    await answerCallback(env, callback.id);
    return showAccessConfirmation(
      env,
      chatId,
      messageId,
      Number(confirmationMatch[2]),
      confirmationMatch[1],
    );
  }
  const accessMatch = /^owner:(block|remove|restore):(\d+)$/.exec(data);
  if (accessMatch) {
    await answerCallback(env, callback.id);
    return changeAccess(
      env,
      chatId,
      messageId,
      Number(accessMatch[2]),
      accessMatch[1],
    );
  }
  return answerCallback(env, callback.id, "Кнопка кабинета устарела", true);
}

export async function cancelOwnerAction(message, env) {
  if (!isOwner(env, message.from?.id) || commandName(message.text) !== "/cancel") return false;
  const state = await ownerState(env, message.from.id);
  if (!state) return false;
  await clearOwnerState(env, message.from.id);
  await showOwnerHome(env, message.chat.id);
  return true;
}
