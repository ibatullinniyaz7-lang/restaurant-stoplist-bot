var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/telegram.js
var TelegramError = class extends Error {
  static {
    __name(this, "TelegramError");
  }
  constructor(method, status, description, retryAfter = null) {
    super(`Telegram ${method}: ${status} ${description}`);
    this.name = "TelegramError";
    this.method = method;
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
};
async function telegramCall(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    signal: AbortSignal.timeout(15e3),
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new TelegramError(method, response.status, "\u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442 API");
  }
  if (!response.ok || !data.ok) {
    throw new TelegramError(method, data.error_code ?? response.status, data.description ?? "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430", data.parameters?.retry_after);
  }
  return data.result;
}
__name(telegramCall, "telegramCall");
function sendMessage(env, chatId, text, extra = {}) {
  return telegramCall(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra
  });
}
__name(sendMessage, "sendMessage");
async function answerCallback(env, callbackQueryId, text = "", showAlert = false) {
  try {
    return await telegramCall(env, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
      cache_time: 0
    });
  } catch (error) {
    console.error("Callback acknowledgement failed", { name: error?.name, status: error?.status });
    return null;
  }
}
__name(answerCallback, "answerCallback");
function deleteMessage(env, chatId, messageId) {
  return telegramCall(env, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId
  });
}
__name(deleteMessage, "deleteMessage");
async function editMessage(env, chatId, messageId, text, replyMarkup) {
  try {
    return await telegramCall(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup
    });
  } catch (error) {
    if (error instanceof TelegramError && error.description.includes("message is not modified")) {
      return null;
    }
    throw error;
  }
}
__name(editMessage, "editMessage");

// src/settings.js
var STAFF_BOT_SETTING = "staff_bot_enabled";
async function isStaffBotEnabled(env) {
  const setting = await env.DB.prepare(`
    SELECT setting_value
    FROM app_settings
    WHERE setting_key = ?
    LIMIT 1
  `).bind(STAFF_BOT_SETTING).first();
  return setting?.setting_value !== "0";
}
__name(isStaffBotEnabled, "isStaffBotEnabled");
async function setStaffBotEnabled(env, enabled, userId) {
  await env.DB.prepare(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at, updated_by_user_id)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = CURRENT_TIMESTAMP,
      updated_by_user_id = excluded.updated_by_user_id
  `).bind(STAFF_BOT_SETTING, enabled ? "1" : "0", userId ?? null).run();
}
__name(setStaffBotEnabled, "setStaffBotEnabled");
async function toggleStaffBotEnabled(env, userId) {
  const enabled = !await isStaffBotEnabled(env);
  await setStaffBotEnabled(env, enabled, userId);
  return enabled;
}
__name(toggleStaffBotEnabled, "toggleStaffBotEnabled");
function ownerOnlyRecipients(env, afterChatId = 0) {
  const ownerChatId = Number(env.OWNER_USER_ID);
  if (!Number.isSafeInteger(ownerChatId) || ownerChatId <= Number(afterChatId || 0)) return [];
  return [{ chat_id: ownerChatId }];
}
__name(ownerOnlyRecipients, "ownerOnlyRecipients");

// src/notificationStore.js
async function notificationAudience(env) {
  if (await isStaffBotEnabled(env)) return null;
  const owner = Number(env.OWNER_USER_ID);
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error("invalid_notification_owner");
  return owner;
}
__name(notificationAudience, "notificationAudience");
function notificationInsert(env, text, options = {}, audience = null, conditional = false) {
  return env.DB.prepare(`INSERT INTO notifications
    (message_text, kind, created_by_user_id, recoverable, audience_owner_chat_id, event_key)
    SELECT ?, ?, ?, 1, ?, ? ${conditional ? "WHERE changes() = 1" : ""}`).bind(text, options.kind ?? "status", options.createdByUserId ?? null, audience, options.eventKey ?? null);
}
__name(notificationInsert, "notificationInsert");

// src/broadcast.js
var BROADCAST_BATCH_SIZE = 20;
var DELETE_BATCH_SIZE = 35;
async function createNotification(env, text, options = {}) {
  const audience = await notificationAudience(env);
  const result = await notificationInsert(env, text, options, audience).run();
  return Number(result.meta?.last_row_id);
}
__name(createNotification, "createNotification");
function internalUrl(origin, path, afterChatId = 0) {
  const url = new URL(path, origin);
  url.searchParams.set("after", String(afterChatId));
  return url.toString();
}
__name(internalUrl, "internalUrl");
async function deliverNotificationBatch(env, origin, notificationId, afterChatId = 0) {
  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE notifications SET lease_token = ?, lease_until = unixepoch() + 120
    WHERE id = ? AND delivered_at IS NULL AND deleted_at IS NULL AND failed_at IS NULL
      AND (retry_at IS NULL OR retry_at <= CURRENT_TIMESTAMP)
      AND (lease_until IS NULL OR lease_until <= unixepoch())`).bind(token, notificationId).run();
  if (!claim.meta?.changes) return;
  let more = false;
  try {
    const notification = await env.DB.prepare("SELECT * FROM notifications WHERE id = ?").bind(notificationId).first();
    const enabled = await isStaffBotEnabled(env);
    if (!enabled && notification.audience_owner_chat_id == null) return;
    let recipients;
    if (notification.audience_owner_chat_id != null) {
      const sent = await env.DB.prepare("SELECT 1 FROM notification_deliveries WHERE notification_id = ? AND chat_id = ?").bind(notificationId, notification.audience_owner_chat_id).first();
      recipients = sent ? [] : [{ chat_id: notification.audience_owner_chat_id }];
    } else {
      const result = await env.DB.prepare(`SELECT p.chat_id FROM participants p
        WHERE active = 1 AND blocked = 0 AND chat_id > 0
          AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.notification_id = ? AND d.chat_id = p.chat_id)
        ORDER BY p.chat_id LIMIT ?`).bind(notificationId, BROADCAST_BATCH_SIZE).all();
      recipients = result.results ?? [];
    }
    let retryDelay = 0;
    let permanentFailure = false;
    for (let offset = 0; offset < recipients.length; offset += 5) {
      const current = await env.DB.prepare("SELECT deleted_at FROM notifications WHERE id = ?").bind(notificationId).first();
      if (current?.deleted_at) return;
      const group = recipients.slice(offset, offset + 5);
      const results = await Promise.allSettled(group.map((p) => sendMessage(env, p.chat_id, notification.message_text)));
      const statements = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i], chatId = group[i].chat_id;
        if (result.status === "fulfilled") {
          statements.push(env.DB.prepare(`INSERT OR IGNORE INTO notification_deliveries
            (notification_id, chat_id, telegram_message_id) VALUES (?, ?, ?)`).bind(notificationId, chatId, result.value.message_id));
        } else {
          const error = result.reason;
          if (error instanceof TelegramError && (error.status === 403 || error.status === 400 && error.description.includes("chat not found"))) {
            statements.push(env.DB.prepare("UPDATE participants SET active = 0 WHERE chat_id = ?").bind(chatId));
            if (notification.audience_owner_chat_id != null) permanentFailure = true;
          } else if (error instanceof TelegramError && [400, 401, 404].includes(error.status)) {
            permanentFailure = true;
          } else {
            retryDelay = Math.max(retryDelay, Number(error.retryAfter) || 60);
          }
          console.error("Notification delivery failed", { notificationId, status: error?.status, name: error?.name });
        }
      }
      if (statements.length) await env.DB.batch(statements);
      if (retryDelay || permanentFailure) break;
      if (offset + 5 < recipients.length) await new Promise((resolve) => setTimeout(resolve, 1e3));
    }
    if (permanentFailure) {
      await env.DB.prepare("UPDATE notifications SET failed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(notificationId).run();
    } else if (retryDelay) {
      await env.DB.prepare(`UPDATE notifications SET retry_at = datetime('now', ?) WHERE id = ?`).bind("+" + Math.min(Math.max(retryDelay, 1), 86400) + " seconds", notificationId).run();
    } else if (recipients.length === BROADCAST_BATCH_SIZE) {
      more = true;
    } else {
      await env.DB.prepare("UPDATE notifications SET delivered_at = CURRENT_TIMESTAMP, retry_at = NULL WHERE id = ?").bind(notificationId).run();
    }
  } finally {
    await env.DB.prepare("UPDATE notifications SET lease_token = NULL, lease_until = 0 WHERE id = ? AND lease_token = ?").bind(notificationId, token).run();
  }
  if (more) {
    const response = await fetch(internalUrl(origin, "/internal/broadcast/" + notificationId), {
      headers: { "x-internal-secret": env.INTERNAL_SECRET },
      signal: AbortSignal.timeout(3e4)
    });
    if (!response.ok) throw new Error("broadcast_continuation_failed_" + response.status);
  }
}
__name(deliverNotificationBatch, "deliverNotificationBatch");
async function retryPendingNotifications(env, origin) {
  const pending = await env.DB.prepare(`SELECT id FROM notifications WHERE recoverable = 1
    AND delivered_at IS NULL AND deleted_at IS NULL AND failed_at IS NULL
    AND (retry_at IS NULL OR retry_at <= CURRENT_TIMESTAMP)
    AND (lease_until IS NULL OR lease_until <= unixepoch())
    ORDER BY id LIMIT 5`).all();
  const results = await Promise.allSettled((pending.results ?? []).map((n) => deliverNotificationBatch(env, origin, n.id)));
  for (const result of results) if (result.status === "rejected") console.error("Notification retry failed", { name: result.reason?.name });
}
__name(retryPendingNotifications, "retryPendingNotifications");
async function notificationRecipientCount(env) {
  if (!await isStaffBotEnabled(env)) return ownerOnlyRecipients(env).length;
  const recipients = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM participants WHERE active = 1 AND blocked = 0"
  ).first();
  return Number(recipients?.count ?? 0);
}
__name(notificationRecipientCount, "notificationRecipientCount");
async function deleteAnnouncementBatch(env, origin, notificationId, afterChatId = 0) {
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
    rows.map((row) => deleteMessage(env, row.chat_id, row.telegram_message_id))
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
    const response = await fetch(internalUrl(origin, `/internal/delete-announcement/${notificationId}`, lastChatId), {
      headers: { "x-internal-secret": env.INTERNAL_SECRET },
      signal: AbortSignal.timeout(3e4)
    });
    if (!response.ok) throw new Error(`delete_continuation_failed_${response.status}`);
  }
  return { deleted, failed };
}
__name(deleteAnnouncementBatch, "deleteAnnouncementBatch");

// src/ui.js
var PAGE_SIZE = 8;
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
__name(escapeHtml, "escapeHtml");
function displayName(user = {}) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return "\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A";
}
__name(displayName, "displayName");
function telegramUserLink(user = {}, label = null) {
  const visibleName = escapeHtml(label ?? displayName(user));
  const username = String(user.username ?? "").replace(/^@/, "");
  if (/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    return `<a href="https://t.me/${username}">${visibleName}</a>`;
  }
  const userId = Number(user.id ?? user.user_id);
  if (Number.isSafeInteger(userId) && userId > 0) {
    return `<a href="tg://user?id=${userId}">${visibleName}</a>`;
  }
  return visibleName;
}
__name(telegramUserLink, "telegramUserLink");
function commandName(text = "") {
  const token = text.trim().split(/\s+/, 1)[0].toLowerCase();
  return token.replace(/@[^\s]+$/, "");
}
__name(commandName, "commandName");
function startParameter(text = "") {
  return text.trim().split(/\s+/, 2)[1] ?? "";
}
__name(startParameter, "startParameter");
function moscowTime(date = /* @__PURE__ */ new Date(), includeDate = true) {
  const options = {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit"
  };
  if (includeDate) {
    options.day = "2-digit";
    options.month = "2-digit";
    options.year = "numeric";
  }
  return new Intl.DateTimeFormat("ru-RU", options).format(date);
}
__name(moscowTime, "moscowTime");
function sqlDate(value) {
  if (!value) return null;
  return /* @__PURE__ */ new Date(`${String(value).replace(" ", "T")}Z`);
}
__name(sqlDate, "sqlDate");
function paginate(items, page, pageSize = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  return {
    items: items.slice(safePage * pageSize, (safePage + 1) * pageSize),
    page: safePage,
    pages
  };
}
__name(paginate, "paginate");
function menuTitle(menuType) {
  return menuType === "bar" ? "\u041A\u0430\u0440\u0442\u0430 \u0431\u0430\u0440\u0430" : "\u041A\u0443\u0445\u043D\u044F";
}
__name(menuTitle, "menuTitle");
function menuIcon(menuType) {
  return menuType === "bar" ? "\u{1F379}" : "\u{1F37D}";
}
__name(menuIcon, "menuIcon");
function normalizeStatus(status) {
  if (status === true || status === 1) return "stopped";
  if (status === false || status === 0) return "available";
  return ["available", "limited", "expected", "stopped"].includes(status) ? status : "available";
}
__name(normalizeStatus, "normalizeStatus");
function statusIcon(status) {
  return {
    available: "\u2705",
    limited: "\u26A0\uFE0F",
    expected: "\u{1F552}",
    stopped: "\u{1F6D1}"
  }[normalizeStatus(status)];
}
__name(statusIcon, "statusIcon");
function statusLabel(status) {
  return {
    available: "\u0412 \u043F\u0440\u043E\u0434\u0430\u0436\u0435",
    limited: "\u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435",
    expected: "\u041E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F",
    stopped: "\u041D\u0430 \u0441\u0442\u043E\u043F\u0435"
  }[normalizeStatus(status)];
}
__name(statusLabel, "statusLabel");
function dishStatusSuffix(dish, fullDate = false) {
  const status = normalizeStatus(dish.availability_status ?? (dish.is_stopped ? "stopped" : "available"));
  if (status === "limited" && Number(dish.limited_quantity) > 0) {
    return ` \xB7 \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C ${Number(dish.limited_quantity)}`;
  }
  if (status === "expected" && dish.expected_at) {
    return ` \xB7 \u043A ${moscowTime(sqlDate(dish.expected_at), fullDate)}`;
  }
  return "";
}
__name(dishStatusSuffix, "dishStatusSuffix");
function dishButtonText(dish) {
  const status = normalizeStatus(dish.availability_status ?? (dish.is_stopped ? "stopped" : "available"));
  return `${statusIcon(status)} ${dish.name}${dishStatusSuffix(dish)}`;
}
__name(dishButtonText, "dishButtonText");
function mainMenuKeyboard(counts = {}, isOwner2 = false, scheduleCount = 0, canManageSchedule = false) {
  const kitchenCount = Number(counts.kitchen ?? 0);
  const barCount = Number(counts.bar ?? 0);
  const suffix = /* @__PURE__ */ __name((count) => count ? ` \xB7 \u{1F4CB} ${count}` : "", "suffix");
  const rows = [
    [
      { text: `\u{1F37D} \u041A\u0443\u0445\u043D\u044F${suffix(kitchenCount)}`, callback_data: "catalog:kitchen:0" },
      { text: `\u{1F379} \u0411\u0430\u0440${suffix(barCount)}`, callback_data: "catalog:bar:0" }
    ],
    [
      { text: "\u{1F4CB} \u0421\u0442\u0430\u0442\u0443\u0441\u044B", callback_data: "stops" },
      {
        text: Number(scheduleCount) > 0 ? "\u{1F4C5} \u0421\u043C\u0435\u043D\u044B \xB7 \u043E\u0442\u043A\u0440\u044B\u0442\u0430" : "\u{1F4C5} \u0421\u043C\u0435\u043D\u044B",
        callback_data: "sched:hub"
      }
    ],
    [{ text: "\u{1F4E3} \u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435", callback_data: "announce:start" }]
  ];
  const management = [];
  if (isOwner2) management.push({ text: "\u{1F451} \u0412\u043B\u0430\u0434\u0435\u043B\u0435\u0446", callback_data: "owner:home" });
  if (canManageSchedule) management.push({ text: "\u{1F5D3} \u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435", callback_data: "sched:manager_home" });
  if (management.length) rows.push(management);
  rows.push([{ text: "\u{1F504} \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C", callback_data: "home" }]);
  return { inline_keyboard: rows };
}
__name(mainMenuKeyboard, "mainMenuKeyboard");
function categoryStatusSuffix(category) {
  const parts = [];
  if (Number(category.limited_count)) parts.push(`\u26A0\uFE0F ${Number(category.limited_count)}`);
  if (Number(category.expected_count)) parts.push(`\u{1F552} ${Number(category.expected_count)}`);
  if (Number(category.stopped_count)) parts.push(`\u{1F6D1} ${Number(category.stopped_count)}`);
  return parts.length ? ` \xB7 ${parts.join(" \xB7 ")}` : "";
}
__name(categoryStatusSuffix, "categoryStatusSuffix");
function catalogKeyboard(categories2, menuType, page = 0) {
  const pageData = paginate(categories2, page);
  const rows = pageData.items.map((category) => [{
    text: `${category.name}${categoryStatusSuffix(category)}`,
    callback_data: `cat:${category.id}:0`
  }]);
  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) navigation.push({ text: "\u2B05\uFE0F", callback_data: `catalog:${menuType}:${pageData.page - 1}` });
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) navigation.push({ text: "\u27A1\uFE0F", callback_data: `catalog:${menuType}:${pageData.page + 1}` });
    rows.push(navigation);
  }
  rows.push([{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]);
  return { inline_keyboard: rows };
}
__name(catalogKeyboard, "catalogKeyboard");
function categoryKeyboard(categoryId, dishes, page = 0, menuType = "kitchen") {
  const pageData = paginate(dishes, page);
  const rows = pageData.items.map((dish) => [{
    text: dishButtonText(dish),
    callback_data: `dish:${dish.id}:${categoryId}:${pageData.page}`
  }]);
  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) navigation.push({ text: "\u2B05\uFE0F", callback_data: `cat:${categoryId}:${pageData.page - 1}` });
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) navigation.push({ text: "\u27A1\uFE0F", callback_data: `cat:${categoryId}:${pageData.page + 1}` });
    rows.push(navigation);
  }
  rows.push([{ text: `\u25C0\uFE0F ${menuTitle(menuType)}`, callback_data: `catalog:${menuType}:0` }]);
  return { inline_keyboard: rows };
}
__name(categoryKeyboard, "categoryKeyboard");
function dishStatusKeyboard(dishId, categoryId, page = 0) {
  return {
    inline_keyboard: [
      [
        { text: "\u2705 \u0412 \u043F\u0440\u043E\u0434\u0430\u0436\u0435", callback_data: `setstatus:${dishId}:available:${categoryId}:${page}` },
        { text: "\u{1F6D1} \u0421\u0442\u043E\u043F", callback_data: `setstatus:${dishId}:stopped:${categoryId}:${page}` }
      ],
      [
        { text: "\u26A0\uFE0F \u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435", callback_data: `limitmenu:${dishId}:${categoryId}:${page}` },
        { text: "\u{1F552} \u041E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F", callback_data: `expectedprompt:${dishId}:${categoryId}:${page}` }
      ],
      [{ text: "\u25C0\uFE0F \u041A \u0441\u043F\u0438\u0441\u043A\u0443", callback_data: `cat:${categoryId}:${page}` }]
    ]
  };
}
__name(dishStatusKeyboard, "dishStatusKeyboard");
function limitedQuantityKeyboard(dishId, categoryId, page = 0) {
  const button = /* @__PURE__ */ __name((quantity) => ({
    text: String(quantity),
    callback_data: `limitset:${dishId}:${quantity}:${categoryId}:${page}`
  }), "button");
  return {
    inline_keyboard: [
      [button(1), button(2), button(3)],
      [button(4), button(5)],
      [{ text: "\u270D\uFE0F \u0414\u0440\u0443\u0433\u043E\u0435 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E", callback_data: `limitcustom:${dishId}:${categoryId}:${page}` }],
      [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: `dish:${dishId}:${categoryId}:${page}` }]
    ]
  };
}
__name(limitedQuantityKeyboard, "limitedQuantityKeyboard");
function statusDescription(dish) {
  const status = normalizeStatus(dish.availability_status ?? (dish.is_stopped ? "stopped" : "available"));
  const lines = [`${statusIcon(status)} <b>${statusLabel(status)}</b>`];
  if (status === "limited" && dish.limited_quantity) lines.push(`\u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C: <b>${Number(dish.limited_quantity)} \u0448\u0442.</b>`);
  if (status === "expected" && dish.expected_at) lines.push(`\u041E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F \u043A: <b>${moscowTime(sqlDate(dish.expected_at))} (\u041C\u0421\u041A)</b>`);
  return lines.join("\n");
}
__name(statusDescription, "statusDescription");
function stopListText(rows) {
  if (!rows.length) {
    return "\u2705 <b>\u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0439 \u043D\u0435\u0442</b>\n\n\u0412\u0441\u0435 \u043F\u043E\u0437\u0438\u0446\u0438\u0438 \u043A\u0443\u0445\u043D\u0438 \u0438 \u0431\u0430\u0440\u0430 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0434\u043B\u044F \u043F\u0440\u043E\u0434\u0430\u0436\u0438.";
  }
  const grouped = /* @__PURE__ */ new Map([["kitchen", /* @__PURE__ */ new Map()], ["bar", /* @__PURE__ */ new Map()]]);
  for (const row of rows) {
    const menuType = row.menu_type === "bar" ? "bar" : "kitchen";
    const categories2 = grouped.get(menuType);
    if (!categories2.has(row.category_name)) categories2.set(row.category_name, []);
    categories2.get(row.category_name).push(row);
  }
  const lines = ["\u{1F4CB} <b>\u0422\u0435\u043A\u0443\u0449\u0438\u0435 \u0441\u0442\u0430\u0442\u0443\u0441\u044B</b>", ""];
  for (const [menuType, categories2] of grouped) {
    if (!categories2.size) continue;
    lines.push(`${menuIcon(menuType)} <b>${menuTitle(menuType)}</b>`, "");
    for (const [category, dishes] of categories2) {
      lines.push(`<b>${escapeHtml(category)}</b>`);
      for (const dish of dishes) {
        const status = normalizeStatus(dish.availability_status);
        lines.push(`\u2022 ${statusIcon(status)} ${escapeHtml(dish.name)}${escapeHtml(dishStatusSuffix(dish, true))}`);
      }
      lines.push("");
    }
  }
  lines.push("\u26A0\uFE0F \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 \xB7 \u{1F552} \u043E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F \xB7 \u{1F6D1} \u0441\u0442\u043E\u043F");
  return lines.join("\n");
}
__name(stopListText, "stopListText");
function changeNotification(dish, desiredStatus, actor, details = {}, changedAt = /* @__PURE__ */ new Date()) {
  if (details instanceof Date) {
    changedAt = details;
    details = {};
  }
  const status = normalizeStatus(desiredStatus);
  const heading = {
    available: "\u2705 <b>\u041F\u041E\u0417\u0418\u0426\u0418\u042F \u0412\u0415\u0420\u041D\u0423\u041B\u0410\u0421\u042C \u0412 \u041F\u0420\u041E\u0414\u0410\u0416\u0423</b>",
    limited: "\u26A0\uFE0F <b>\u041F\u041E\u0417\u0418\u0426\u0418\u042F \u0412 \u041E\u0413\u0420\u0410\u041D\u0418\u0427\u0415\u041D\u0418\u0418</b>",
    expected: "\u{1F552} <b>\u041F\u041E\u0417\u0418\u0426\u0418\u042F \u041E\u0416\u0418\u0414\u0410\u0415\u0422\u0421\u042F</b>",
    stopped: "\u{1F6D1} <b>\u041F\u041E\u0417\u0418\u0426\u0418\u042F \u041F\u041E\u0421\u0422\u0410\u0412\u041B\u0415\u041D\u0410 \u041D\u0410 \u0421\u0422\u041E\u041F</b>"
  }[status];
  const section = `${menuTitle(dish.menu_type)} \u2192 ${dish.category_name}`;
  const lines = [heading, "", `<b>${escapeHtml(dish.name)}</b>`];
  if (status === "limited") lines.push(`\u041E\u0441\u0442\u0430\u043B\u043E\u0441\u044C: <b>${Number(details.quantity ?? dish.limited_quantity)} \u0448\u0442.</b>`);
  if (status === "expected") {
    const value = details.expectedAt ?? dish.expected_at;
    lines.push(`\u0411\u0443\u0434\u0435\u0442 \u0433\u043E\u0442\u043E\u0432\u043E: <b>${moscowTime(sqlDate(value))} (\u041C\u0421\u041A)</b>`);
  }
  lines.push(
    `\u0420\u0430\u0437\u0434\u0435\u043B: ${escapeHtml(section)}`,
    `\u0418\u0437\u043C\u0435\u043D\u0438\u043B(\u0430): ${typeof actor === "string" ? escapeHtml(actor) : telegramUserLink(actor)}`,
    `\u0412\u0440\u0435\u043C\u044F: ${moscowTime(changedAt)} (\u041C\u0421\u041A)`
  );
  return lines.join("\n");
}
__name(changeNotification, "changeNotification");

// src/availability.js
var MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1e3;
function toSqlUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
__name(toSqlUtc, "toSqlUtc");
function parseExpectedTime(input, now = /* @__PURE__ */ new Date()) {
  const match = /^(?:(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s+)?(\d{1,2})[:.](\d{2})$/.exec(
    String(input ?? "").trim()
  );
  if (!match) return null;
  const hour2 = Number(match[4]);
  const minute = Number(match[5]);
  if (hour2 > 23 || minute > 59) return null;
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
      if (year < 100) year += 2e3;
    }
  }
  let target = new Date(Date.UTC(year, month - 1, day, hour2 - 3, minute, 0));
  const targetMoscow = new Date(target.getTime() + MOSCOW_OFFSET_MS);
  if (targetMoscow.getUTCFullYear() !== year || targetMoscow.getUTCMonth() + 1 !== month || targetMoscow.getUTCDate() !== day || targetMoscow.getUTCHours() !== hour2 || targetMoscow.getUTCMinutes() !== minute) {
    return null;
  }
  if (!hasDate && target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1e3);
  }
  if (hasDate && target.getTime() <= now.getTime()) return null;
  return toSqlUtc(target);
}
__name(parseExpectedTime, "parseExpectedTime");
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
__name(dishById, "dishById");
async function changeDishAvailability(env, actor, chatId, dishId, desiredStatus, details = {}) {
  if (!["available", "limited", "expected", "stopped"].includes(desiredStatus)) throw new Error("invalid_status");
  const status = normalizeStatus(desiredStatus);
  const quantity = status === "limited" ? Number(details.quantity) : null;
  const expectedAt = status === "expected" ? details.expectedAt : null;
  if (status === "limited" && (!Number.isInteger(quantity) || quantity < 1 || quantity > 999)) throw new Error("invalid_limited_quantity");
  if (status === "expected" && (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(expectedAt ?? "") || !Number.isFinite(Date.parse(expectedAt.replace(" ", "T") + "Z")))) throw new Error("invalid_expected_time");
  const dish = await dishById(env, dishId);
  if (!dish) return { changed: false, dish: null, notificationId: null };
  const actorName = typeof actor === "string" ? actor : displayName(actor);
  const audience = await notificationAudience(env);
  const statusDetails = status === "limited" ? String(quantity) : expectedAt;
  const eventKey = Number.isSafeInteger(env.UPDATE_ID) ? `update:${env.UPDATE_ID}:dish:${dishId}` : null;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE dishes SET availability_status = ?, limited_quantity = ?, expected_at = ?,
      is_stopped = ?, updated_at = CURRENT_TIMESTAMP, updated_by_chat_id = ?
      WHERE id = ? AND active = 1 AND (availability_status <> ?
        OR COALESCE(limited_quantity, -1) <> COALESCE(?, -1)
        OR COALESCE(expected_at, '') <> COALESCE(?, ''))
      AND (? IS NULL OR (availability_status = 'expected' AND expected_at = ? AND expected_at <= CURRENT_TIMESTAMP))
      AND NOT EXISTS (SELECT 1 FROM notifications WHERE event_key = ?)`).bind(
      status,
      quantity,
      expectedAt,
      status === "stopped" ? 1 : 0,
      chatId,
      dishId,
      status,
      quantity,
      expectedAt,
      details.dueAt ?? null,
      details.dueAt ?? null,
      eventKey
    ),
    env.DB.prepare(`INSERT INTO audit_log (dish_id, new_status, actor_chat_id, actor_name,
      new_availability_status, status_details) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`).bind(dishId, status === "stopped" ? 1 : 0, chatId, actorName, status, statusDetails),
    notificationInsert(
      env,
      changeNotification(dish, status, actor, { quantity, expectedAt }),
      { kind: "status", createdByUserId: typeof actor === "object" ? actor?.id : null, eventKey },
      audience,
      true
    )
  ]);
  const changed = results[0].meta?.changes === 1;
  return {
    changed,
    dish: changed ? { ...dish, availability_status: status, limited_quantity: quantity, expected_at: expectedAt } : dish,
    notificationId: changed ? Number(results[2].meta.last_row_id) : null
  };
}
__name(changeDishAvailability, "changeDishAvailability");
async function processExpectedStatuses(env, origin) {
  const result = await env.DB.prepare(`SELECT id, expected_at FROM dishes WHERE active = 1
    AND availability_status = 'expected' AND expected_at <= CURRENT_TIMESTAMP
    ORDER BY expected_at, id LIMIT 20`).all();
  for (const due of result.results ?? []) {
    const changed = await changeDishAvailability(
      env,
      "\u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043F\u043E \u0437\u0430\u0434\u0430\u043D\u043D\u043E\u043C\u0443 \u0432\u0440\u0435\u043C\u0435\u043D\u0438",
      0,
      due.id,
      "available",
      { dueAt: due.expected_at }
    );
    if (changed.notificationId) await deliverNotificationBatch(env, origin, changed.notificationId);
  }
}
__name(processExpectedStatuses, "processExpectedStatuses");

// src/scheduleActions.js
var hour = /* @__PURE__ */ __name((value) => `${String(value).padStart(2, "0")}:00`, "hour");
var endHour = /* @__PURE__ */ __name((value) => value === "00:00" ? 24 : Number(value?.slice(0, 2)), "endHour");
var back = { text: "\u25C0\uFE0F \u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0441\u043C\u0435\u043D\u0430\u043C\u0438", callback_data: "sched:manager_home" };
function splitShift(entry, breakStart, breakEnd) {
  if (!entry || entry.is_day_off || entry.break_start || !/^\d{2}:00$/.test(entry.start_time ?? "") || !/^\d{2}:00$/.test(entry.end_time ?? "")) return null;
  const start = Number(entry.start_time.slice(0, 2));
  const end = endHour(entry.end_time);
  if (![start, end, breakStart, breakEnd].every(Number.isInteger) || start < 10 || end > 24 || !(start < breakStart && breakStart < breakEnd && breakEnd < end)) return null;
  return { ...entry, break_start: hour(breakStart), break_end: hour(breakEnd) };
}
__name(splitShift, "splitShift");
async function actionToken(env, callback, kind, payload) {
  const token = crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare(`INSERT INTO schedule_actions (token, actor_id, chat_id, message_id, kind, payload)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(
    token,
    callback.from.id,
    callback.message.chat.id,
    callback.message.message_id,
    kind,
    JSON.stringify(payload)
  ).run();
  return token;
}
__name(actionToken, "actionToken");
async function history(env, callback, beforeId = 0) {
  const result = await env.DB.prepare(`SELECT id, start_date, end_date FROM schedule_periods
    WHERE end_date < ? AND (? = 0 OR id < ?) ORDER BY id DESC LIMIT 9`).bind(sqlDateToday(), beforeId, beforeId).all();
  const periods = result.results ?? [];
  const rows = periods.slice(0, 8).map((p) => [{
    text: `${formatScheduleDate(p.start_date, true)} \u2014 ${formatScheduleDate(p.end_date, true)}`,
    callback_data: `sched:deleteask:${p.id}`
  }]);
  if (periods.length > 8) rows.push([{ text: "\u0414\u0430\u043B\u0435\u0435 \u2192", callback_data: `sched:history:${periods[7].id}` }]);
  if (beforeId) rows.push([{ text: "\u041A \u043D\u0430\u0447\u0430\u043B\u0443 \u0438\u0441\u0442\u043E\u0440\u0438\u0438", callback_data: "sched:history:0" }]);
  rows.push([back]);
  return editMessage(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    "\u{1F5D1} <b>\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u044B\u0445 \u043D\u0435\u0434\u0435\u043B\u044C</b>\n\n" + (periods.length ? "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0435\u0434\u0435\u043B\u044E \u0434\u043B\u044F \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u044F. \u0422\u0435\u043A\u0443\u0449\u0430\u044F \u0438 \u0431\u0443\u0434\u0443\u0449\u0438\u0435 \u043D\u0435\u0434\u0435\u043B\u0438 \u0437\u0430\u0449\u0438\u0449\u0435\u043D\u044B." : "\u0417\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u044B\u0445 \u043D\u0435\u0434\u0435\u043B\u044C \u043D\u0435\u0442."),
    { inline_keyboard: rows }
  );
}
__name(history, "history");
async function splitContext(env, entryId) {
  const entry = await env.DB.prepare("SELECT * FROM schedule_entries WHERE id = ?").bind(entryId).first();
  if (!entry) return null;
  const [period, target] = await Promise.all([
    env.DB.prepare("SELECT * FROM schedule_periods WHERE id = ?").bind(entry.period_id).first(),
    env.DB.prepare("SELECT * FROM participants WHERE chat_id = ? AND active = 1 AND blocked = 0").bind(entry.chat_id).first()
  ]);
  if (!canManagerEditPeriod(period) || !target || entry.shift_date < period.start_date || entry.shift_date > period.end_date) return null;
  return { entry, period, target };
}
__name(splitContext, "splitContext");
async function handleScheduleAction(callback, env) {
  if (!isScheduleManager(env, callback.from) || callback.message?.chat?.type !== "private" || String(callback.message.chat.id) !== String(callback.from.id)) {
    return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443 \u0438 \u0433\u043B\u0430\u0432\u043D\u043E\u043C\u0443 \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443 \u0432 \u043B\u0438\u0447\u043D\u043E\u043C \u0447\u0430\u0442\u0435", true);
  }
  const data = callback.data ?? "";
  const render = /* @__PURE__ */ __name((text, rows) => editMessage(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    text,
    { inline_keyboard: rows }
  ), "render");
  const stale = /* @__PURE__ */ __name(() => answerCallback(env, callback.id, "\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u043E. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0437\u0430\u043D\u043E\u0432\u043E.", true), "stale");
  let match = /^sched:history:(\d+)$/.exec(data);
  if (match) {
    await answerCallback(env, callback.id);
    return history(env, callback, Number(match[1]));
  }
  match = /^sched:deleteask:(\d+)$/.exec(data);
  if (match) {
    const period2 = await env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM schedule_entries e
      WHERE e.period_id = p.id) AS entry_count FROM schedule_periods p WHERE id = ? AND end_date < ?`).bind(Number(match[1]), sqlDateToday()).first();
    if (!period2) return stale();
    const token2 = await actionToken(env, callback, "delete", { periodId: period2.id });
    await answerCallback(env, callback.id);
    return render(`\u{1F5D1} <b>\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0438\u0441\u0442\u043E\u0440\u0438\u044E \u043D\u0435\u0434\u0435\u043B\u0438?</b>

${formatScheduleDate(period2.start_date, true)} \u2014 ${formatScheduleDate(period2.end_date, true)}
\u0417\u0430\u043F\u0438\u0441\u0435\u0439 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u043E\u0432: ${period2.entry_count}.

\u041D\u0435\u0434\u0435\u043B\u044F \u0438 \u0432\u0441\u0435 \u0435\u0451 \u0437\u0430\u043F\u0438\u0441\u0438 \u0431\u0443\u0434\u0443\u0442 \u0443\u0434\u0430\u043B\u0435\u043D\u044B \u0431\u0435\u0437 \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E\u0441\u0442\u0438 \u043E\u0442\u043C\u0435\u043D\u044B. \u0421\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F \u0432 Telegram \u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F.`, [
      [{ text: "\u{1F5D1} \u0414\u0430, \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u043D\u0435\u0434\u0435\u043B\u044E", callback_data: `sched:action:${token2}:delete` }],
      [{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `sched:action:${token2}:cancel` }]
    ]);
  }
  match = /^sched:split:(\d+)$/.exec(data);
  if (match) {
    const context2 = await splitContext(env, Number(match[1]));
    if (!context2) return stale();
    const { entry: entry2, target: target2 } = context2;
    const start = Number(entry2.start_time?.slice(0, 2));
    const end = endHour(entry2.end_time);
    if (!splitShift(entry2, start + 1, start + 2)) {
      return answerCallback(env, callback.id, "\u041D\u0443\u0436\u043D\u0430 \u043E\u0431\u044B\u0447\u043D\u0430\u044F \u0441\u043C\u0435\u043D\u0430 \u0434\u043B\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u0441\u0442\u044C\u044E \u043D\u0435 \u043C\u0435\u043D\u0435\u0435 3 \u0447\u0430\u0441\u043E\u0432", true);
    }
    const token2 = await actionToken(env, callback, "split", { entry: entry2 });
    const buttons = [];
    for (let h = start + 1; h <= end - 2; h++) buttons.push({ text: hour(h), callback_data: `sched:action:${token2}:start:${h}` });
    const rows = [];
    for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
    rows.push([{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `sched:action:${token2}:cancel` }]);
    await answerCallback(env, callback.id);
    return render(`\u2702\uFE0F <b>\u0420\u0430\u0437\u0434\u0435\u043B\u0438\u0442\u044C \u0441\u043C\u0435\u043D\u0443</b>
${telegramUserLink(target2, target2.display_name)}
${formatScheduleDate(entry2.shift_date, true)} \xB7 ${entry2.start_time}\u2013${entry2.end_time}

\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0430\u0447\u0430\u043B\u043E \u043F\u0435\u0440\u0435\u0440\u044B\u0432\u0430. \u0412\u043D\u0435\u0448\u043D\u0438\u0435 \u0433\u0440\u0430\u043D\u0438\u0446\u044B \u0441\u043C\u0435\u043D\u044B \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u0442\u0441\u044F.`, rows);
  }
  match = /^sched:action:([a-f0-9]{32}):(cancel|delete|start|end|save)(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(data);
  if (!match) return stale();
  const [, token, step, a, b] = match;
  const action = await env.DB.prepare(`SELECT * FROM schedule_actions
    WHERE token = ? AND actor_id = ? AND chat_id = ? AND message_id = ? AND expires_at > CURRENT_TIMESTAMP`).bind(token, callback.from.id, callback.message.chat.id, callback.message.message_id).first();
  if (!action) return stale();
  const payload = JSON.parse(action.payload);
  if (step === "cancel") {
    await env.DB.prepare("DELETE FROM schedule_actions WHERE token = ?").bind(token).run();
    await answerCallback(env, callback.id, "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E");
    return render("\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u044B.", [[back]]);
  }
  if (step === "delete" && action.kind === "delete") {
    const results2 = await env.DB.batch([
      env.DB.prepare(`DELETE FROM schedule_periods WHERE id = ? AND end_date < ?
        AND EXISTS (SELECT 1 FROM schedule_actions WHERE token = ? AND expires_at > CURRENT_TIMESTAMP)`).bind(payload.periodId, sqlDateToday(), token),
      env.DB.prepare("DELETE FROM schedule_actions WHERE token = ?").bind(token)
    ]);
    await answerCallback(env, callback.id, results2[0].meta.changes ? "\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u043D\u0435\u0434\u0435\u043B\u0438 \u0443\u0434\u0430\u043B\u0435\u043D\u0430" : "\u041D\u0435\u0434\u0435\u043B\u044F \u0443\u0436\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u0430 \u0438\u043B\u0438 \u0437\u0430\u0449\u0438\u0449\u0435\u043D\u0430");
    return history(env, callback);
  }
  if (action.kind !== "split") return stale();
  const context = await splitContext(env, payload.entry.id);
  if (!context || context.entry.revision !== payload.entry.revision) return stale();
  const { entry, period, target } = context;
  const breakStart = Number(a);
  const breakEnd = Number(b);
  const cancel = [{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `sched:action:${token}:cancel` }];
  if (step === "start") {
    const rows = [];
    for (let h = breakStart + 1; h < endHour(entry.end_time); h++) {
      if (splitShift(entry, breakStart, h)) rows.push([{ text: hour(h), callback_data: `sched:action:${token}:end:${breakStart}:${h}` }]);
    }
    if (!rows.length) return stale();
    await answerCallback(env, callback.id);
    return render(`\u041D\u0430\u0447\u0430\u043B\u043E \u043F\u0435\u0440\u0435\u0440\u044B\u0432\u0430: <b>${hour(breakStart)}</b>
\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u0435 \u043F\u0435\u0440\u0435\u0440\u044B\u0432\u0430:`, [...rows, cancel]);
  }
  const after = splitShift(entry, breakStart, breakEnd);
  if (!after) return stale();
  if (step === "end") {
    await env.DB.prepare("UPDATE schedule_actions SET payload = ? WHERE token = ?").bind(JSON.stringify({ ...payload, breakStart, breakEnd }), token).run();
    await answerCallback(env, callback.id);
    return render(`\u2702\uFE0F <b>\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0440\u0430\u0437\u0434\u0435\u043B\u0451\u043D\u043D\u0443\u044E \u0441\u043C\u0435\u043D\u0443?</b>
${telegramUserLink(target, target.display_name)}
${formatScheduleDate(entry.shift_date, true)}

${after.start_time}\u2013${after.break_start} / ${after.break_end}\u2013${after.end_time}
\u041F\u0435\u0440\u0435\u0440\u044B\u0432: ${hour(breakStart)}\u2013${hour(breakEnd)}`, [
      [{ text: "\u2705 \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C", callback_data: `sched:action:${token}:save:${breakStart}:${breakEnd}` }],
      cancel
    ]);
  }
  if (step !== "save" || payload.breakStart !== breakStart || payload.breakEnd !== breakEnd) return stale();
  const now = /* @__PURE__ */ new Date();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE schedule_entries SET break_start = ?, break_end = ?,
      revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ? AND is_day_off = 0 AND break_start IS NULL
      AND EXISTS (SELECT 1 FROM schedule_actions WHERE token = ? AND payload = ? AND expires_at > CURRENT_TIMESTAMP)
      AND EXISTS (SELECT 1 FROM participants WHERE chat_id = schedule_entries.chat_id AND active = 1 AND blocked = 0)
      AND EXISTS (SELECT 1 FROM schedule_periods WHERE id = schedule_entries.period_id AND status = 'open'
        AND end_date >= ? AND (start_date <= ? OR (? = 1 AND start_date = ?)))`).bind(
      after.break_start,
      after.break_end,
      entry.id,
      entry.revision,
      token,
      action.payload,
      sqlDateToday(now),
      sqlDateToday(now),
      canOpenNextWeek(now) ? 1 : 0,
      nextMonday(1, now)
    ),
    env.DB.prepare("DELETE FROM schedule_actions WHERE token = ?").bind(token)
  ]);
  if (!results[0].meta.changes) return stale();
  const delivered = await notifyManagedScheduleChange(env, target, callback.from, period, entry.shift_date, entry, after);
  await answerCallback(env, callback.id, delivered ? "\u0421\u043C\u0435\u043D\u0430 \u0440\u0430\u0437\u0434\u0435\u043B\u0435\u043D\u0430, \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0451\u043D" : "\u0421\u043C\u0435\u043D\u0430 \u0440\u0430\u0437\u0434\u0435\u043B\u0435\u043D\u0430, \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043D\u0435 \u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E");
  return showManagedEmployee(env, callback.message.chat.id, callback.message.message_id, entry.period_id, entry.chat_id);
}
__name(handleScheduleAction, "handleScheduleAction");

// src/schedule.js
var MOSCOW_OFFSET_MS2 = 3 * 60 * 60 * 1e3;
var START_HOUR = 10;
var END_HOUR = 24;
var MANAGER_DAYS_PER_PAGE = 1;
var PUBLIC_DAYS_PER_PAGE = 1;
var STAFF_PAGE_SIZE = 8;
function moscowParts(date = /* @__PURE__ */ new Date()) {
  const shifted = new Date(date.getTime() + MOSCOW_OFFSET_MS2);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay()
  };
}
__name(moscowParts, "moscowParts");
function sqlDateToday(date = /* @__PURE__ */ new Date()) {
  const parts = moscowParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
__name(sqlDateToday, "sqlDateToday");
function canOpenNextWeek(date = /* @__PURE__ */ new Date()) {
  const weekday = moscowParts(date).weekday;
  return weekday === 0 || weekday >= 4;
}
__name(canOpenNextWeek, "canOpenNextWeek");
function canUseNextWeekSignup(period, date = /* @__PURE__ */ new Date()) {
  return Boolean(
    period && period.status === "open" && period.end_date >= sqlDateToday(date) && period.start_date === nextMonday(1, date) && canOpenNextWeek(date)
  );
}
__name(canUseNextWeekSignup, "canUseNextWeekSignup");
function canManagerEditPeriod(period, date = /* @__PURE__ */ new Date()) {
  const today = sqlDateToday(date);
  return Boolean(
    period && period.status === "open" && period.end_date >= today && (period.start_date <= today || period.start_date === nextMonday(1, date) && canOpenNextWeek(date))
  );
}
__name(canManagerEditPeriod, "canManagerEditPeriod");
function nextScheduleOpeningDate(date = /* @__PURE__ */ new Date()) {
  const today = sqlDateToday(date);
  const weekday = moscowParts(date).weekday;
  const daysUntilThursday = (4 - weekday + 7) % 7;
  return addDays(today, daysUntilThursday);
}
__name(nextScheduleOpeningDate, "nextScheduleOpeningDate");
function addDays(value, amount) {
  const date = /* @__PURE__ */ new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
__name(addDays, "addDays");
function nextMonday(weeksAhead = 1, now = /* @__PURE__ */ new Date()) {
  const today = sqlDateToday(now);
  const weekday = moscowParts(now).weekday;
  const daysUntilNextMonday = weekday === 0 ? 1 : 8 - weekday;
  return addDays(today, daysUntilNextMonday + (Math.max(1, Number(weeksAhead) || 1) - 1) * 7);
}
__name(nextMonday, "nextMonday");
function formatScheduleDate(value, withYear = false) {
  const [year, month, day] = String(value).split("-");
  if (!year || !month || !day) return String(value);
  const date = /* @__PURE__ */ new Date(`${value}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" }).format(date).replace(".", "");
  return `${weekday}, ${day}.${month}${withYear ? `.${year}` : ""}`;
}
__name(formatScheduleDate, "formatScheduleDate");
function idOf(user) {
  return typeof user === "object" ? user?.id : user;
}
__name(idOf, "idOf");
function isScheduleManager(env, user) {
  const userId = idOf(user);
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) return false;
  if (env.OWNER_USER_ID && String(userId) === String(env.OWNER_USER_ID)) return true;
  return Boolean(env.MANAGER_USER_ID) && String(userId) === String(env.MANAGER_USER_ID);
}
__name(isScheduleManager, "isScheduleManager");
function managerKeyboard(periods = [], openingAllowed = canOpenNextWeek(), nextWeekStart = nextMonday(), today = sqlDateToday()) {
  const rows = periods.map((period) => {
    const waitingForThursday = period.status === "open" && period.start_date > today && !openingAllowed;
    const icon = period.status === "closed" ? "\u26AA" : waitingForThursday ? "\u23F3" : "\u{1F7E2}";
    return [{
      text: `${icon} ${formatScheduleDate(period.start_date)} \u2014 ${formatScheduleDate(period.end_date)}`,
      callback_data: `sched:manager:${period.id}`
    }];
  });
  const nextWeekExists = periods.some((period) => period.start_date === nextWeekStart);
  if (!nextWeekExists) {
    rows.push([openingAllowed ? { text: "\u{1F6E0} \u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0432\u0440\u0443\u0447\u043D\u0443\u044E", callback_data: "sched:open:1" } : { text: "\u23F3 \u0410\u0432\u0442\u043E\u043E\u0442\u043A\u0440\u044B\u0442\u0438\u0435 \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433", callback_data: "sched:open_locked" }]);
  }
  rows.push([{ text: "\u{1F5D1} \u0418\u0441\u0442\u043E\u0440\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D\u043D\u044B\u0445 \u043D\u0435\u0434\u0435\u043B\u044C", callback_data: "sched:history:0" }]);
  rows.push([{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]);
  return { inline_keyboard: rows };
}
__name(managerKeyboard, "managerKeyboard");
function schedulePeriodAction(period, today = sqlDateToday(), openingAllowed = canOpenNextWeek(), nextWeekStart = nextMonday()) {
  if (period?.status === "open" && period.end_date >= today && (period.start_date <= today || period.start_date === nextWeekStart && openingAllowed)) {
    return { text: "\u2705 \u0417\u0430\u043A\u0440\u044B\u0442\u044C \u0438 \u0443\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C", callback_data: `sched:confirm_close:${period.id}` };
  }
  if (period?.status === "closed" && period.end_date >= today && (period.start_date <= today || period.start_date === nextWeekStart && openingAllowed)) {
    return { text: "\u{1F513} \u0421\u043D\u043E\u0432\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C", callback_data: `sched:reopen:${period.id}` };
  }
  return null;
}
__name(schedulePeriodAction, "schedulePeriodAction");
async function showScheduleManager(env, chatId, messageId = null) {
  const result = await env.DB.prepare(`
    SELECT id, start_date, end_date, status
    FROM schedule_periods
    ORDER BY start_date DESC, id DESC
    LIMIT 12
  `).all();
  const periods = result.results ?? [];
  const today = sqlDateToday();
  const openingAllowed = canOpenNextWeek();
  const nextWeekStart = nextMonday();
  const nextWeekExists = periods.some((period) => period.start_date === nextWeekStart);
  const text = [
    "\u{1F4C5} <b>\u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0441\u043C\u0435\u043D\u0430\u043C\u0438</b>",
    "",
    nextWeekExists && !openingAllowed ? `\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u0430. \u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433, <b>${formatScheduleDate(nextScheduleOpeningDate(), true)}</b>.` : nextWeekExists ? "\u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0443\u044E \u043D\u0435\u0434\u0435\u043B\u044E \u043E\u0442\u043A\u0440\u044B\u0442\u0430." : openingAllowed ? "\u0410\u0432\u0442\u043E\u043E\u0442\u043A\u0440\u044B\u0442\u0438\u0435 \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u043B\u043E \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0443\u044E \u043D\u0435\u0434\u0435\u043B\u044E. \u041F\u0440\u0438 \u043D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u043E\u0441\u0442\u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0440\u0443\u0447\u043D\u043E\u0435 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u0435." : `\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433, <b>${formatScheduleDate(nextScheduleOpeningDate(), true)}</b>.`,
    periods.length ? "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043F\u0435\u0440\u0438\u043E\u0434, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u0437\u0430\u044F\u0432\u043A\u0438:" : "\u041F\u0435\u0440\u0438\u043E\u0434\u043E\u0432 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442."
  ].join("\n");
  const keyboard = managerKeyboard(periods, openingAllowed, nextWeekStart, today);
  if (messageId) return editMessage(env, chatId, messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}
__name(showScheduleManager, "showScheduleManager");
async function periodById(env, periodId) {
  return env.DB.prepare(
    "SELECT id, start_date, end_date, status FROM schedule_periods WHERE id = ? LIMIT 1"
  ).bind(periodId).first();
}
__name(periodById, "periodById");
async function openPeriod(env, startDate, actor) {
  const endDate = addDays(startDate, 6);
  const insert = await env.DB.prepare(`
    INSERT OR IGNORE INTO schedule_periods
      (start_date, end_date, status, created_by_user_id, created_by_chat_id)
    VALUES (?, ?, 'open', ?, ?)
  `).bind(startDate, endDate, idOf(actor), idOf(actor)).run();
  const period = await periodById(env, (await env.DB.prepare(
    "SELECT id FROM schedule_periods WHERE start_date = ? AND end_date = ? LIMIT 1"
  ).bind(startDate, endDate).first())?.id);
  return period ? { period, created: (insert.meta?.changes ?? 0) === 1 } : null;
}
__name(openPeriod, "openPeriod");
function scheduleOpeningMarkerKey(startDate, testMode = false) {
  return `schedule_open_${testMode ? "test_" : ""}notified_${startDate}`;
}
__name(scheduleOpeningMarkerKey, "scheduleOpeningMarkerKey");
async function claimScheduleOpeningNotice(env, period, actor, testMode) {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO app_settings
      (setting_key, setting_value, updated_at, updated_by_user_id)
    VALUES (?, '1', CURRENT_TIMESTAMP, ?)
  `).bind(scheduleOpeningMarkerKey(period.start_date, testMode), idOf(actor) ?? null).run();
  return (result.meta?.changes ?? 0) === 1;
}
__name(claimScheduleOpeningNotice, "claimScheduleOpeningNotice");
async function openSchedulePeriods(env, actor, origin, now = /* @__PURE__ */ new Date()) {
  if (!canOpenNextWeek(now)) {
    return { periods: [], createdCount: 0, notAllowed: true };
  }
  const opened = await openPeriod(env, nextMonday(1, now), actor);
  const periods = opened?.period ? [opened] : [];
  let notifiedCount = 0;
  const testMode = !await isStaffBotEnabled(env);
  for (const opened2 of periods.filter((item) => item.period.status === "open")) {
    const period = opened2.period;
    if (!await claimScheduleOpeningNotice(env, period, actor, testMode)) continue;
    const notificationId = await createNotification(env, [
      "\u{1F4C5} <b>\u041E\u0422\u041A\u0420\u042B\u0422\u0410 \u0417\u0410\u041F\u0418\u0421\u042C \u041D\u0410 \u0421\u041C\u0415\u041D\u042B</b>",
      "",
      `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
      "",
      "\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 /schedule \u2192 \xAB\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F\xBB, \u0447\u0442\u043E\u0431\u044B \u0443\u043A\u0430\u0437\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u044F \u0440\u0430\u0431\u043E\u0442\u044B \u0438\u043B\u0438 \u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439."
    ].join("\n"), { kind: "schedule", createdByUserId: idOf(actor) });
    await deliverNotificationBatch(env, origin, notificationId);
    notifiedCount += 1;
  }
  return {
    periods: periods.map((item) => item.period),
    createdCount: periods.filter((item) => item.created).length,
    notifiedCount
  };
}
__name(openSchedulePeriods, "openSchedulePeriods");
async function processScheduleAutomation(env, origin, now = /* @__PURE__ */ new Date()) {
  if (now.getUTCMinutes() !== 0) {
    return { periods: [], createdCount: 0, betweenHourlyChecks: true };
  }
  if (!canOpenNextWeek(now)) {
    return { periods: [], createdCount: 0, outsideOpeningWindow: true };
  }
  const actor = { id: Number(env.OWNER_USER_ID) || 0 };
  return openSchedulePeriods(env, actor, origin, now);
}
__name(processScheduleAutomation, "processScheduleAutomation");
async function showPeriod(env, chatId, messageId, periodId, forManager = false, page = 0) {
  const period = await periodById(env, periodId);
  if (!period) return editMessage(env, chatId, messageId, "\u041F\u0435\u0440\u0438\u043E\u0434 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.", { inline_keyboard: [] });
  const managerCanEdit = canManagerEditPeriod(period);
  const result = await env.DB.prepare(`
    SELECT se.shift_date, se.user_id, se.display_name, se.start_time, se.end_time,
           se.is_day_off, se.break_start, se.break_end, p.username
    FROM schedule_entries se
    LEFT JOIN participants p ON p.chat_id = se.chat_id
    WHERE se.period_id = ?
    ORDER BY se.shift_date, CASE WHEN se.is_day_off = 1 THEN 1 ELSE 0 END,
             se.start_time, se.display_name
  `).bind(periodId).all();
  const entries = result.results ?? [];
  const grouped = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.shift_date)) grouped.set(entry.shift_date, []);
    grouped.get(entry.shift_date).push(entry);
  }
  const lines = [
    "\u{1F4C5} <b>\u0413\u0440\u0430\u0444\u0438\u043A \u0441\u043C\u0435\u043D</b>",
    `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
    `\u0421\u0442\u0430\u0442\u0443\u0441: ${period.status === "closed" ? "\u2705 \u0433\u0440\u0430\u0444\u0438\u043A \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D" : managerCanEdit ? "\u{1F7E2} \u0437\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u0430" : "\u23F3 \u0437\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433"}`,
    ""
  ];
  const safePage = Math.max(0, Math.min(Number(page) || 0, Math.ceil(7 / MANAGER_DAYS_PER_PAGE) - 1));
  const firstDay = forManager ? safePage * MANAGER_DAYS_PER_PAGE : 0;
  const lastDay = forManager ? Math.min(7, firstDay + MANAGER_DAYS_PER_PAGE) : 7;
  for (let offset = firstDay; offset < lastDay; offset += 1) {
    const date = addDays(period.start_date, offset);
    const dayEntries = grouped.get(date) ?? [];
    lines.push(`<b>${formatScheduleDate(date)}</b>`);
    if (!dayEntries.length) {
      lines.push("\u2014 \u0437\u0430\u044F\u0432\u043E\u043A \u043F\u043E\u043A\u0430 \u043D\u0435\u0442");
    } else {
      for (const entry of dayEntries) lines.push(scheduleEntryLine(entry));
    }
    lines.push("");
  }
  const rows = [];
  if (forManager && managerCanEdit) {
    rows.push([{
      text: "\u270F\uFE0F \u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C / \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0441\u043C\u0435\u043D\u0443",
      callback_data: `sched:edit:${period.id}:0`
    }]);
  }
  const periodAction = forManager ? schedulePeriodAction(period) : null;
  if (periodAction) rows.push([periodAction]);
  if (forManager) {
    const navigation = [];
    if (safePage > 0) navigation.push({ text: "\u2B05\uFE0F", callback_data: `sched:manager:${period.id}:${safePage - 1}` });
    navigation.push({ text: `${safePage + 1}/${Math.ceil(7 / MANAGER_DAYS_PER_PAGE)}`, callback_data: "noop" });
    if (safePage + 1 < Math.ceil(7 / MANAGER_DAYS_PER_PAGE)) {
      navigation.push({ text: "\u27A1\uFE0F", callback_data: `sched:manager:${period.id}:${safePage + 1}` });
    }
    rows.push(navigation);
  }
  rows.push([{ text: "\u25C0\uFE0F \u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0441\u043C\u0435\u043D\u0430\u043C\u0438", callback_data: "sched:manager_home" }]);
  return editMessage(env, chatId, messageId, lines.join("\n"), { inline_keyboard: rows });
}
__name(showPeriod, "showPeriod");
async function publishedPeriods(env, today = sqlDateToday()) {
  const result = await env.DB.prepare(`
    SELECT id, start_date, end_date, status
    FROM schedule_periods
    WHERE status = 'closed' AND end_date >= ?
    ORDER BY CASE WHEN start_date <= ? AND end_date >= ? THEN 0 ELSE 1 END,
             start_date, id
    LIMIT 4
  `).bind(today, today, today).all();
  return result.results ?? [];
}
__name(publishedPeriods, "publishedPeriods");
async function showPublishedPeriod(env, chatId, messageId, periodId, page = 0) {
  const period = await periodById(env, periodId);
  if (!period || period.status !== "closed" || period.end_date < sqlDateToday()) {
    return editMessage(env, chatId, messageId, [
      "\u{1F4C5} <b>\u0423\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D\u043D\u043E\u0435 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435</b>",
      "",
      "\u042D\u0442\u043E\u0442 \u0433\u0440\u0430\u0444\u0438\u043A \u0441\u043D\u043E\u0432\u0430 \u0440\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u0443\u0435\u0442\u0441\u044F \u0438\u043B\u0438 \u0443\u0436\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D."
    ].join("\n"), {
      inline_keyboard: [[{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]]
    });
  }
  const result = await env.DB.prepare(`
    SELECT se.shift_date, se.user_id, se.display_name, se.start_time, se.end_time,
           se.is_day_off, se.break_start, se.break_end, p.username
    FROM schedule_entries se
    LEFT JOIN participants p ON p.chat_id = se.chat_id
    WHERE se.period_id = ? AND se.is_day_off = 0
    ORDER BY se.shift_date, se.start_time, se.display_name
  `).bind(periodId).all();
  const grouped = /* @__PURE__ */ new Map();
  for (const entry of result.results ?? []) {
    if (!grouped.has(entry.shift_date)) grouped.set(entry.shift_date, []);
    grouped.get(entry.shift_date).push(entry);
  }
  const pages = Math.ceil(7 / PUBLIC_DAYS_PER_PAGE);
  const safePage = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const firstDay = safePage * PUBLIC_DAYS_PER_PAGE;
  const lastDay = Math.min(7, firstDay + PUBLIC_DAYS_PER_PAGE);
  const lines = [
    "\u{1F4C5} <b>\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043D\u0430 \u043D\u0435\u0434\u0435\u043B\u044E</b>",
    `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
    "\u0421\u0442\u0430\u0442\u0443\u0441: \u2705 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u043E\u043C",
    ""
  ];
  for (let offset = firstDay; offset < lastDay; offset += 1) {
    const date = addDays(period.start_date, offset);
    const entries = grouped.get(date) ?? [];
    lines.push(`<b>${formatScheduleDate(date)}</b>`);
    if (!entries.length) lines.push("\u2014 \u0441\u043C\u0435\u043D \u043D\u0435\u0442");
    else for (const entry of entries) lines.push(scheduleEntryLine(entry));
    lines.push("");
  }
  const navigation = [];
  if (safePage > 0) navigation.push({ text: "\u2B05\uFE0F", callback_data: `sched:pub:${period.id}:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: "noop" });
  if (safePage + 1 < pages) navigation.push({ text: "\u27A1\uFE0F", callback_data: `sched:pub:${period.id}:${safePage + 1}` });
  const allPeriods = await publishedPeriods(env);
  const back2 = allPeriods.length > 1 ? { text: "\u25C0\uFE0F \u0423\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D\u043D\u044B\u0435 \u043D\u0435\u0434\u0435\u043B\u0438", callback_data: "sched:published" } : { text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" };
  return editMessage(env, chatId, messageId, lines.join("\n"), {
    inline_keyboard: [navigation, [back2]]
  });
}
__name(showPublishedPeriod, "showPublishedPeriod");
async function showPublishedSchedules(env, chatId, messageId) {
  const periods = await publishedPeriods(env);
  if (!periods.length) {
    return editMessage(env, chatId, messageId, [
      "\u{1F4C5} <b>\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043D\u0430 \u043D\u0435\u0434\u0435\u043B\u044E</b>",
      "",
      "\u0423\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D\u043D\u043E\u0433\u043E \u0433\u0440\u0430\u0444\u0438\u043A\u0430 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442."
    ].join("\n"), {
      inline_keyboard: [[{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]]
    });
  }
  if (periods.length === 1) {
    return showPublishedPeriod(env, chatId, messageId, periods[0].id, 0);
  }
  const rows = periods.map((period) => [{
    text: `${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}`,
    callback_data: `sched:pub:${period.id}:0`
  }]);
  rows.push([{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]);
  return editMessage(env, chatId, messageId, [
    "\u{1F4C5} <b>\u0423\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D\u043D\u044B\u0435 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u044F</b>",
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0435\u0434\u0435\u043B\u044E:"
  ].join("\n"), { inline_keyboard: rows });
}
__name(showPublishedSchedules, "showPublishedSchedules");
async function periodContainingDate(env, date) {
  return env.DB.prepare(`
    SELECT id, start_date, end_date, status
    FROM schedule_periods
    WHERE start_date <= ? AND end_date >= ?
    ORDER BY start_date DESC, id DESC
    LIMIT 1
  `).bind(date, date).first();
}
__name(periodContainingDate, "periodContainingDate");
async function nextWeekPeriod(env, now = /* @__PURE__ */ new Date()) {
  return env.DB.prepare(`
    SELECT id, start_date, end_date, status
    FROM schedule_periods
    WHERE start_date = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(nextMonday(1, now)).first();
}
__name(nextWeekPeriod, "nextWeekPeriod");
function dayOffset(startDate, date) {
  const start = /* @__PURE__ */ new Date(`${startDate}T12:00:00Z`);
  const value = /* @__PURE__ */ new Date(`${date}T12:00:00Z`);
  return Math.max(0, Math.min(6, Math.round((value.getTime() - start.getTime()) / 864e5)));
}
__name(dayOffset, "dayOffset");
function scheduleHubKeyboard(current, next, openingAllowed = canOpenNextWeek()) {
  const currentLabel = current ? `\u{1F5D3} \u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F \xB7 ${current.status === "closed" ? "\u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430" : "\u043E\u0431\u043D\u043E\u0432\u043B\u044F\u0435\u0442\u0441\u044F"}` : "\u{1F5D3} \u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F \xB7 \u0433\u0440\u0430\u0444\u0438\u043A\u0430 \u043D\u0435\u0442";
  const nextLabel = !next || next.status === "open" && !openingAllowed ? "\u23F3 \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F \xB7 \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433" : next.status === "open" ? "\u270D\uFE0F \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F \xB7 \u0437\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u0430" : "\u2705 \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F \xB7 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430";
  return {
    inline_keyboard: [
      [{ text: currentLabel, callback_data: "sched:current" }],
      [{ text: nextLabel, callback_data: "sched:next" }],
      [{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]
    ]
  };
}
__name(scheduleHubKeyboard, "scheduleHubKeyboard");
async function showScheduleHub(env, chatId, messageId = null, now = /* @__PURE__ */ new Date()) {
  const today = sqlDateToday(now);
  const [current, next] = await Promise.all([
    periodContainingDate(env, today),
    nextWeekPeriod(env, now)
  ]);
  const currentText = current ? `${formatScheduleDate(current.start_date, true)} \u2014 ${formatScheduleDate(current.end_date, true)}` : "\u0433\u0440\u0430\u0444\u0438\u043A \u043F\u043E\u043A\u0430 \u043D\u0435 \u0441\u043E\u0437\u0434\u0430\u043D";
  const nextText = next ? `${formatScheduleDate(next.start_date, true)} \u2014 ${formatScheduleDate(next.end_date, true)}` : `\u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 ${formatScheduleDate(nextScheduleOpeningDate(now), true)}`;
  const text = [
    "\u{1F4C5} <b>\u0421\u043C\u0435\u043D\u044B</b>",
    "",
    `\u{1F5D3} \u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F: <b>${currentText}</b>`,
    `\u23ED \u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F: <b>${nextText}</b>`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0443\u0436\u043D\u0443\u044E \u0432\u043A\u043B\u0430\u0434\u043A\u0443."
  ].join("\n");
  const keyboard = scheduleHubKeyboard(current, next, canOpenNextWeek(now));
  if (messageId) return editMessage(env, chatId, messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}
__name(showScheduleHub, "showScheduleHub");
async function showTeamSchedulePeriod(env, chatId, messageId, period, page, scope) {
  const result = await env.DB.prepare(`
    SELECT se.shift_date, se.user_id, se.display_name, se.start_time, se.end_time,
           se.is_day_off, se.break_start, se.break_end, p.username
    FROM schedule_entries se
    LEFT JOIN participants p ON p.chat_id = se.chat_id
    WHERE se.period_id = ? AND se.is_day_off = 0
    ORDER BY se.shift_date, se.start_time, se.display_name
  `).bind(period.id).all();
  const grouped = /* @__PURE__ */ new Map();
  for (const entry of result.results ?? []) {
    if (!grouped.has(entry.shift_date)) grouped.set(entry.shift_date, []);
    grouped.get(entry.shift_date).push(entry);
  }
  const pages = 7;
  const safePage = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const date = addDays(period.start_date, safePage);
  const entries = grouped.get(date) ?? [];
  const title = scope === "current" ? "\u0422\u0435\u043A\u0443\u0449\u0438\u0435 \u0441\u043C\u0435\u043D\u044B" : "\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0435\u0439 \u043D\u0435\u0434\u0435\u043B\u0438";
  const lines = [
    `\u{1F4C5} <b>${title}</b>`,
    `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
    `\u0421\u0442\u0430\u0442\u0443\u0441: ${period.status === "closed" ? "\u2705 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u043E" : "\u{1F7E2} \u0440\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u0443\u0435\u0442\u0441\u044F"}`,
    "",
    `<b>${formatScheduleDate(date)}</b>`
  ];
  if (!entries.length) lines.push("\u2014 \u0441\u043C\u0435\u043D \u043D\u0435\u0442");
  else for (const entry of entries) lines.push(scheduleEntryLine(entry));
  const callbackPrefix = scope === "current" ? "sched:cur" : "sched:nxt";
  const navigation = [];
  if (safePage > 0) navigation.push({ text: "\u2B05\uFE0F", callback_data: `${callbackPrefix}:${period.id}:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: "noop" });
  if (safePage + 1 < pages) navigation.push({ text: "\u27A1\uFE0F", callback_data: `${callbackPrefix}:${period.id}:${safePage + 1}` });
  return editMessage(env, chatId, messageId, lines.join("\n"), {
    inline_keyboard: [navigation, [{ text: "\u25C0\uFE0F \u0421\u043C\u0435\u043D\u044B", callback_data: "sched:hub" }]]
  });
}
__name(showTeamSchedulePeriod, "showTeamSchedulePeriod");
async function showCurrentSchedule(env, chatId, messageId, page = null, expectedPeriodId = null, now = /* @__PURE__ */ new Date()) {
  const today = sqlDateToday(now);
  const period = await periodContainingDate(env, today);
  if (!period || expectedPeriodId && Number(period.id) !== Number(expectedPeriodId)) {
    return editMessage(env, chatId, messageId, [
      "\u{1F5D3} <b>\u0422\u0435\u043A\u0443\u0449\u0438\u0435 \u0441\u043C\u0435\u043D\u044B</b>",
      "",
      "\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043D\u0430 \u0442\u0435\u043A\u0443\u0449\u0443\u044E \u043D\u0435\u0434\u0435\u043B\u044E \u043F\u043E\u043A\u0430 \u043D\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u043E."
    ].join("\n"), {
      inline_keyboard: [[{ text: "\u25C0\uFE0F \u0421\u043C\u0435\u043D\u044B", callback_data: "sched:hub" }]]
    });
  }
  const targetPage = page == null ? dayOffset(period.start_date, today) : page;
  return showTeamSchedulePeriod(env, chatId, messageId, period, targetPage, "current");
}
__name(showCurrentSchedule, "showCurrentSchedule");
async function showNextSchedule(env, chatId, messageId, page = 0, expectedPeriodId = null, now = /* @__PURE__ */ new Date()) {
  const period = await nextWeekPeriod(env, now);
  if (!period || expectedPeriodId && Number(period.id) !== Number(expectedPeriodId)) {
    return editMessage(env, chatId, messageId, [
      "\u23ED <b>\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F</b>",
      "",
      `\u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433, <b>${formatScheduleDate(nextScheduleOpeningDate(now), true)}</b>.`
    ].join("\n"), {
      inline_keyboard: [[{ text: "\u25C0\uFE0F \u0421\u043C\u0435\u043D\u044B", callback_data: "sched:hub" }]]
    });
  }
  if (period.status === "open") {
    if (!canUseNextWeekSignup(period, now)) {
      return editMessage(env, chatId, messageId, [
        "\u23ED <b>\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F</b>",
        "",
        `\u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433, <b>${formatScheduleDate(nextScheduleOpeningDate(now), true)}</b>.`,
        "\u0412\u043D\u0435\u0441\u0451\u043D\u043D\u044B\u0435 \u0440\u0430\u043D\u0435\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u044B, \u043D\u043E \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0438\u0445 \u0434\u043E \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F \u043D\u0435\u043B\u044C\u0437\u044F."
      ].join("\n"), {
        inline_keyboard: [[{ text: "\u25C0\uFE0F \u0421\u043C\u0435\u043D\u044B", callback_data: "sched:hub" }]]
      });
    }
    return showEmployeePeriod(env, chatId, messageId, period.id);
  }
  return showTeamSchedulePeriod(env, chatId, messageId, period, page, "next");
}
__name(showNextSchedule, "showNextSchedule");
async function showScheduleHome(env, chatId, messageId = null) {
  return showScheduleHub(env, chatId, messageId);
}
__name(showScheduleHome, "showScheduleHome");
async function employeeEntry(env, periodId, chatId, date) {
  return env.DB.prepare(`
    SELECT id, revision, start_time, end_time, is_day_off, break_start, break_end
    FROM schedule_entries
    WHERE period_id = ? AND chat_id = ? AND shift_date = ?
    LIMIT 1
  `).bind(periodId, chatId, date).first();
}
__name(employeeEntry, "employeeEntry");
async function showEmployeePeriod(env, chatId, messageId, periodId) {
  const period = await periodById(env, periodId);
  if (!canUseNextWeekSignup(period)) {
    return showScheduleHome(env, chatId, messageId);
  }
  const rows = [];
  const entries = await managedEmployeeEntries(env, periodId, chatId);
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(period.start_date, offset);
    const entry = entries.get(date);
    const status = entry?.is_day_off ? "\u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439" : entry?.start_time ? scheduleTimeRange(entry) : "\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u043E";
    rows.push([{ text: `${formatScheduleDate(date)} \xB7 ${status}`, callback_data: `sched:day:${periodId}:${date}` }]);
  }
  rows.push([{ text: "\u25C0\uFE0F \u041D\u0435\u0434\u0435\u043B\u0438", callback_data: "sched:home" }]);
  return editMessage(env, chatId, messageId, [
    "\u{1F4C5} <b>\u0412\u0430\u0448\u0430 \u0437\u0430\u043F\u0438\u0441\u044C</b>",
    `\u041F\u0435\u0440\u0438\u043E\u0434: ${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0435\u043D\u044C \u0438 \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u0447\u0430\u0441\u044B \u0440\u0430\u0431\u043E\u0442\u044B \u0438\u043B\u0438 \u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439."
  ].join("\n"), { inline_keyboard: rows });
}
__name(showEmployeePeriod, "showEmployeePeriod");
function hourLabel(hour2) {
  return `${String(hour2).padStart(2, "0")}:00`;
}
__name(hourLabel, "hourLabel");
function validScheduleTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ""));
}
__name(validScheduleTime, "validScheduleTime");
function scheduleTimeRange(entry) {
  if (!validScheduleTime(entry?.start_time) || !validScheduleTime(entry?.end_time)) {
    return "\u26A0\uFE0F \u0432\u0440\u0435\u043C\u044F \u043D\u0443\u0436\u043D\u043E \u0443\u043A\u0430\u0437\u0430\u0442\u044C \u0437\u0430\u043D\u043E\u0432\u043E";
  }
  return entry.break_start && entry.break_end ? `${entry.start_time}\u2013${entry.break_start} / ${entry.break_end}\u2013${entry.end_time}` : `${entry.start_time}\u2013${entry.end_time}`;
}
__name(scheduleTimeRange, "scheduleTimeRange");
function scheduleEntryLine(entry) {
  const employee = telegramUserLink(
    { id: entry?.user_id, username: entry?.username },
    entry?.display_name
  );
  return entry?.is_day_off ? `\u2022 ${employee} \u2014 \u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439` : `\u2022 ${employee} \u2014 ${scheduleTimeRange(entry)}`;
}
__name(scheduleEntryLine, "scheduleEntryLine");
function parseScheduleEndCallback(data) {
  const match = /^sched:end:(\d+):(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(data ?? "");
  if (!match) return null;
  const startHour = Number(match[3]);
  const endHour2 = Number(match[4]);
  if (startHour < START_HOUR || startHour >= END_HOUR || endHour2 <= startHour || endHour2 > END_HOUR) return null;
  return {
    periodId: Number(match[1]),
    date: match[2],
    startHour,
    endHour: endHour2
  };
}
__name(parseScheduleEndCallback, "parseScheduleEndCallback");
async function showDay(env, chatId, messageId, periodId, date) {
  const period = await periodById(env, periodId);
  if (!canUseNextWeekSignup(period) || !dateBelongsToPeriod(period, date)) return showScheduleHome(env, chatId, messageId);
  const entry = await employeeEntry(env, periodId, chatId, date);
  const rows = [];
  for (let hour2 = START_HOUR; hour2 < END_HOUR; hour2 += 1) {
    rows.push({ text: hourLabel(hour2), callback_data: `sched:start:${periodId}:${date}:${hour2}` });
  }
  const keyboard = [];
  for (let index = 0; index < rows.length; index += 3) keyboard.push(rows.slice(index, index + 3));
  keyboard.push([{ text: "\u{1F334} \u0412\u044B\u0445\u043E\u0434\u043D\u043E\u0439", callback_data: `sched:off:${periodId}:${date}` }]);
  keyboard.push([{ text: "\u25C0\uFE0F \u0414\u043D\u0438 \u043D\u0435\u0434\u0435\u043B\u0438", callback_data: `sched:period:${periodId}` }]);
  const current = entry?.is_day_off ? "\u{1F334} \u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439" : entry?.start_time ? `\u23F0 ${scheduleTimeRange(entry)}` : "\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u043E";
  return editMessage(env, chatId, messageId, [
    `\u{1F4C5} <b>${formatScheduleDate(date, true)}</b>`,
    `\u0421\u0435\u0439\u0447\u0430\u0441: ${current}`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0430\u0447\u0430\u043B\u043E \u0441\u043C\u0435\u043D\u044B. \u0417\u0430\u0442\u0435\u043C \u0431\u043E\u0442 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u0442 \u0432\u0440\u0435\u043C\u044F \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u044F."
  ].join("\n"), { inline_keyboard: keyboard });
}
__name(showDay, "showDay");
async function showEndPicker(env, chatId, messageId, periodId, date, startHour) {
  const rows = [];
  for (let hour2 = startHour + 1; hour2 <= END_HOUR; hour2 += 1) {
    const endLabel = hour2 === END_HOUR ? "00:00" : hourLabel(hour2);
    rows.push({ text: endLabel, callback_data: `sched:end:${periodId}:${date}:${startHour}:${hour2}` });
  }
  const keyboard = [];
  for (let index = 0; index < rows.length; index += 3) keyboard.push(rows.slice(index, index + 3));
  keyboard.push([{ text: "\u25C0\uFE0F \u041A \u043D\u0430\u0447\u0430\u043B\u0443 \u0441\u043C\u0435\u043D\u044B", callback_data: `sched:day:${periodId}:${date}` }]);
  return editMessage(env, chatId, messageId, [
    `\u23F0 <b>\u041D\u0430\u0447\u0430\u043B\u043E: ${hourLabel(startHour)}</b>`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u0435 \u0441\u043C\u0435\u043D\u044B:"
  ].join("\n"), { inline_keyboard: keyboard });
}
__name(showEndPicker, "showEndPicker");
async function saveEntry(env, periodId, user, date, startTime, endTime, isDayOff = 0, mode = "employee", now = /* @__PURE__ */ new Date()) {
  const today = sqlDateToday(now);
  const allowCurrent = mode === "manager" ? 1 : 0;
  const allowNext = canOpenNextWeek(now) ? 1 : 0;
  const result = await env.DB.prepare(`
    INSERT INTO schedule_entries
      (period_id, user_id, chat_id, display_name, shift_date, start_time, end_time, is_day_off, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1
      FROM schedule_periods
      WHERE id = ? AND status = 'open' AND end_date >= ?
        AND ? BETWEEN start_date AND end_date
        AND (
          (? = 1 AND start_date <= ?)
          OR (? = 1 AND start_date = ?)
        )
    )
    ON CONFLICT(period_id, chat_id, shift_date) DO UPDATE SET
      user_id = excluded.user_id,
      display_name = excluded.display_name,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      break_start = NULL, break_end = NULL,
      revision = schedule_entries.revision + 1,
      is_day_off = excluded.is_day_off,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    periodId,
    user.user_id ?? user.id,
    user.chat_id ?? user.id,
    user.display_name ?? displayName(user),
    date,
    startTime,
    endTime,
    isDayOff,
    periodId,
    today,
    date,
    allowCurrent,
    today,
    allowNext,
    nextMonday(1, now)
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}
__name(saveEntry, "saveEntry");
async function activeParticipant(env, chatId) {
  return env.DB.prepare(`
    SELECT chat_id, user_id, display_name, username
    FROM participants
    WHERE chat_id = ? AND active = 1 AND blocked = 0
    LIMIT 1
  `).bind(chatId).first();
}
__name(activeParticipant, "activeParticipant");
function entryDescription(entry, emptyLabel = "\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D\u043E") {
  if (!entry) return emptyLabel;
  if (entry.is_day_off) return "\u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439";
  return scheduleTimeRange(entry);
}
__name(entryDescription, "entryDescription");
function dateBelongsToPeriod(period, date) {
  return Boolean(period && date >= period.start_date && date <= period.end_date);
}
__name(dateBelongsToPeriod, "dateBelongsToPeriod");
async function editableManagerPeriod(env, periodId) {
  const period = await periodById(env, periodId);
  if (!canManagerEditPeriod(period)) return null;
  return period;
}
__name(editableManagerPeriod, "editableManagerPeriod");
async function showManagerStaff(env, chatId, messageId, periodId, page = 0) {
  const period = await editableManagerPeriod(env, periodId);
  if (!period) {
    return editMessage(env, chatId, messageId, [
      "\u270F\uFE0F <b>\u0420\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0441\u043C\u0435\u043D</b>",
      "",
      "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0441\u043D\u043E\u0432\u0430 \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0437\u0430\u043F\u0438\u0441\u044C \u043D\u0430 \u044D\u0442\u0443 \u043D\u0435\u0434\u0435\u043B\u044E."
    ].join("\n"), {
      inline_keyboard: [[{ text: "\u25C0\uFE0F \u041A \u0433\u0440\u0430\u0444\u0438\u043A\u0443", callback_data: `sched:manager:${periodId}` }]]
    });
  }
  const result = await env.DB.prepare(`
    SELECT chat_id, user_id, display_name, username
    FROM participants
    WHERE active = 1 AND blocked = 0
    ORDER BY display_name COLLATE NOCASE, chat_id
  `).all();
  const pageData = paginate(result.results ?? [], page, STAFF_PAGE_SIZE);
  const rows = pageData.items.map((person) => [{
    text: person.display_name,
    callback_data: `sched:epick:${period.id}:${person.chat_id}:${pageData.page}`
  }]);
  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) navigation.push({ text: "\u2B05\uFE0F", callback_data: `sched:edit:${period.id}:${pageData.page - 1}` });
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) navigation.push({ text: "\u27A1\uFE0F", callback_data: `sched:edit:${period.id}:${pageData.page + 1}` });
    rows.push(navigation);
  }
  rows.push([{ text: "\u25C0\uFE0F \u041A \u0433\u0440\u0430\u0444\u0438\u043A\u0443", callback_data: `sched:manager:${period.id}` }]);
  return editMessage(env, chatId, messageId, [
    "\u270F\uFE0F <b>\u0414\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0438\u043B\u0438 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0441\u043C\u0435\u043D\u0443</b>",
    `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430:"
  ].join("\n"), { inline_keyboard: rows });
}
__name(showManagerStaff, "showManagerStaff");
async function managedEmployeeEntries(env, periodId, targetChatId) {
  const result = await env.DB.prepare(`
    SELECT shift_date, start_time, end_time, is_day_off, break_start, break_end
    FROM schedule_entries
    WHERE period_id = ? AND chat_id = ?
    ORDER BY shift_date
  `).bind(periodId, targetChatId).all();
  return new Map((result.results ?? []).map((entry) => [entry.shift_date, entry]));
}
__name(managedEmployeeEntries, "managedEmployeeEntries");
async function showManagedEmployee(env, chatId, messageId, periodId, targetChatId, staffPage = 0) {
  const [period, target] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId)
  ]);
  if (!period || !target) return showManagerStaff(env, chatId, messageId, periodId, staffPage);
  const entries = await managedEmployeeEntries(env, periodId, targetChatId);
  const rows = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(period.start_date, offset);
    rows.push([{
      text: `${formatScheduleDate(date)} \xB7 ${entryDescription(entries.get(date))}`,
      callback_data: `sched:eday:${period.id}:${target.chat_id}:${staffPage}:${date}`
    }]);
  }
  rows.push([{ text: "\u25C0\uFE0F \u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438", callback_data: `sched:edit:${period.id}:${staffPage}` }]);
  return editMessage(env, chatId, messageId, [
    "\u{1F464} <b>\u0420\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0433\u0440\u0430\u0444\u0438\u043A\u0430</b>",
    `\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A: ${telegramUserLink(target, target.display_name)}`,
    `\u041F\u0435\u0440\u0438\u043E\u0434: ${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0435\u043D\u044C:"
  ].join("\n"), { inline_keyboard: rows });
}
__name(showManagedEmployee, "showManagedEmployee");
async function showManagedDay(env, chatId, messageId, periodId, targetChatId, staffPage, date) {
  const [period, target, entry] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date)
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    return showManagerStaff(env, chatId, messageId, periodId, staffPage);
  }
  const startButtons = [];
  for (let hour2 = START_HOUR; hour2 < END_HOUR; hour2 += 1) {
    startButtons.push({
      text: hourLabel(hour2),
      callback_data: `sched:estart:${period.id}:${target.chat_id}:${staffPage}:${date}:${hour2}`
    });
  }
  const rows = [];
  for (let index = 0; index < startButtons.length; index += 3) {
    rows.push(startButtons.slice(index, index + 3));
  }
  rows.push([{
    text: "\u{1F334} \u041F\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439",
    callback_data: `sched:eoff:${period.id}:${target.chat_id}:${staffPage}:${date}`
  }]);
  if (entry && !entry.is_day_off && !entry.break_start) {
    rows.push([{ text: "\u2702\uFE0F \u0420\u0430\u0437\u0434\u0435\u043B\u0438\u0442\u044C \u0441\u043C\u0435\u043D\u0443 (\u043F\u0435\u0440\u0435\u0440\u044B\u0432)", callback_data: `sched:split:${entry.id}` }]);
  }
  if (entry) {
    rows.push([{
      text: "\u{1F5D1} \u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C \u0437\u0430 \u0434\u0435\u043D\u044C",
      callback_data: `sched:eclearask:${period.id}:${target.chat_id}:${staffPage}:${date}`
    }]);
  }
  rows.push([{
    text: "\u25C0\uFE0F \u0414\u043D\u0438 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430",
    callback_data: `sched:epick:${period.id}:${target.chat_id}:${staffPage}`
  }]);
  return editMessage(env, chatId, messageId, [
    "\u270F\uFE0F <b>\u0420\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0441\u043C\u0435\u043D\u044B</b>",
    `\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A: ${telegramUserLink(target, target.display_name)}`,
    `\u0414\u0430\u0442\u0430: <b>${formatScheduleDate(date, true)}</b>`,
    `\u0421\u0435\u0439\u0447\u0430\u0441: <b>${entryDescription(entry)}</b>`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0440\u0435\u043C\u044F \u043D\u0430\u0447\u0430\u043B\u0430. \u041E\u0431\u044B\u0447\u043D\u0430\u044F \u0441\u043C\u0435\u043D\u0430 \u0438\u043B\u0438 \u0432\u044B\u0445\u043E\u0434\u043D\u043E\u0439 \u0437\u0430\u043C\u0435\u043D\u0438\u0442 \u043E\u0431\u0430 \u0438\u043D\u0442\u0435\u0440\u0432\u0430\u043B\u0430 \u0440\u0430\u0437\u0434\u0435\u043B\u0451\u043D\u043D\u043E\u0439 \u0441\u043C\u0435\u043D\u044B."
  ].join("\n"), { inline_keyboard: rows });
}
__name(showManagedDay, "showManagedDay");
async function showManagedEndPicker(env, chatId, messageId, periodId, targetChatId, staffPage, date, startHour) {
  const [period, target] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId)
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    return showManagerStaff(env, chatId, messageId, periodId, staffPage);
  }
  const endButtons = [];
  for (let hour2 = startHour + 1; hour2 <= END_HOUR; hour2 += 1) {
    endButtons.push({
      text: hour2 === END_HOUR ? "00:00" : hourLabel(hour2),
      callback_data: `sched:eend:${period.id}:${target.chat_id}:${staffPage}:${date}:${startHour}:${hour2}`
    });
  }
  const rows = [];
  for (let index = 0; index < endButtons.length; index += 3) {
    rows.push(endButtons.slice(index, index + 3));
  }
  rows.push([{
    text: "\u25C0\uFE0F \u041A \u043D\u0430\u0447\u0430\u043B\u0443 \u0441\u043C\u0435\u043D\u044B",
    callback_data: `sched:eday:${period.id}:${target.chat_id}:${staffPage}:${date}`
  }]);
  return editMessage(env, chatId, messageId, [
    "\u270F\uFE0F <b>\u0420\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u0435 \u0441\u043C\u0435\u043D\u044B</b>",
    `\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A: ${telegramUserLink(target, target.display_name)}`,
    `\u0414\u0430\u0442\u0430: <b>${formatScheduleDate(date, true)}</b>`,
    `\u041D\u0430\u0447\u0430\u043B\u043E: <b>${hourLabel(startHour)}</b>`,
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0440\u0435\u043C\u044F \u043E\u043A\u043E\u043D\u0447\u0430\u043D\u0438\u044F:"
  ].join("\n"), { inline_keyboard: rows });
}
__name(showManagedEndPicker, "showManagedEndPicker");
function scheduleChangeNotificationText(target, actor, period, date, before, after, testMode = false) {
  const testPrefix = testMode ? [
    "\u{1F9EA} <b>\u0422\u0415\u0421\u0422\u041E\u0412\u041E\u0415 \u0423\u0412\u0415\u0414\u041E\u041C\u041B\u0415\u041D\u0418\u0415</b>",
    `\u041F\u043E\u0441\u043B\u0435 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u0431\u043E\u0442\u0430 \u0435\u0433\u043E \u043F\u043E\u043B\u0443\u0447\u0438\u043B \u0431\u044B: ${telegramUserLink(target, target.display_name)}`,
    ""
  ] : [];
  const text = [
    ...testPrefix,
    "\u270F\uFE0F <b>\u0418\u0417\u041C\u0415\u041D\u0415\u041D\u0418\u0415 \u0412 \u0413\u0420\u0410\u0424\u0418\u041A\u0415</b>",
    "",
    `\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A: ${telegramUserLink(target, target.display_name)}`,
    `\u041D\u0435\u0434\u0435\u043B\u044F: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
    `\u0414\u0430\u0442\u0430: <b>${formatScheduleDate(date, true)}</b>`,
    `\u0411\u044B\u043B\u043E: <b>${entryDescription(before, "\u0437\u0430\u043F\u0438\u0441\u0438 \u043D\u0435 \u0431\u044B\u043B\u043E")}</b>`,
    `\u0421\u0442\u0430\u043B\u043E: <b>${entryDescription(after, "\u0437\u0430\u043F\u0438\u0441\u044C \u0443\u0434\u0430\u043B\u0435\u043D\u0430")}</b>`,
    "",
    `\u0418\u0437\u043C\u0435\u043D\u0438\u043B(\u0430): ${telegramUserLink(actor)}`
  ].join("\n");
  return text;
}
__name(scheduleChangeNotificationText, "scheduleChangeNotificationText");
async function notifyManagedScheduleChange(env, target, actor, period, date, before, after) {
  const staffBotEnabled = await isStaffBotEnabled(env);
  const ownerChatId = Number(env.OWNER_USER_ID);
  const targetIsOwner = String(target.user_id) === String(env.OWNER_USER_ID);
  const text = scheduleChangeNotificationText(
    target,
    actor,
    period,
    date,
    before,
    after,
    !staffBotEnabled && !targetIsOwner
  );
  const recipientChatId = staffBotEnabled ? target.chat_id : ownerChatId;
  if (!Number.isSafeInteger(Number(recipientChatId))) return false;
  try {
    await sendMessage(env, Number(recipientChatId), text);
    return true;
  } catch (error) {
    console.error("Schedule edit notification failed", {
      targetChatId: target.chat_id,
      recipientChatId,
      message: error?.message
    });
    return false;
  }
}
__name(notifyManagedScheduleChange, "notifyManagedScheduleChange");
async function saveManagedEntry(callback, env, periodId, targetChatId, staffPage, date, startTime, endTime, isDayOff) {
  const [period, target, before] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date)
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    await answerCallback(env, callback.id, "\u041F\u0435\u0440\u0438\u043E\u0434 \u0438\u043B\u0438 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D", true);
    return showManagerStaff(env, callback.message.chat.id, callback.message.message_id, periodId, staffPage);
  }
  const after = { start_time: startTime, end_time: endTime, is_day_off: isDayOff };
  if (entryDescription(before) === entryDescription(after)) {
    await answerCallback(env, callback.id, "\u0422\u0430\u043A\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C \u0443\u0436\u0435 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430");
    return showManagedEmployee(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      targetChatId,
      staffPage
    );
  }
  const saved = await saveEntry(
    env,
    periodId,
    target,
    date,
    startTime,
    endTime,
    isDayOff,
    "manager"
  );
  if (!saved) {
    await answerCallback(env, callback.id, "\u0413\u0440\u0430\u0444\u0438\u043A \u0443\u0436\u0435 \u0437\u0430\u043A\u0440\u044B\u0442. \u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0435 \u043D\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E.", true);
    return showPeriod(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      true
    );
  }
  const delivered = await notifyManagedScheduleChange(
    env,
    target,
    callback.from,
    period,
    date,
    before,
    after
  );
  await answerCallback(
    env,
    callback.id,
    delivered ? "\u0421\u043C\u0435\u043D\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0430, \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E" : "\u0421\u043C\u0435\u043D\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0430, \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043D\u0435 \u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E"
  );
  return showManagedEmployee(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    periodId,
    targetChatId,
    staffPage
  );
}
__name(saveManagedEntry, "saveManagedEntry");
async function showManagedClearConfirmation(env, chatId, messageId, periodId, targetChatId, staffPage, date) {
  const [period, target, entry] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date)
  ]);
  if (!period || !target || !entry || !dateBelongsToPeriod(period, date)) {
    return showManagedDay(env, chatId, messageId, periodId, targetChatId, staffPage, date);
  }
  return editMessage(env, chatId, messageId, [
    "\u{1F5D1} <b>\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C \u0437\u0430 \u0434\u0435\u043D\u044C?</b>",
    "",
    `\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A: ${telegramUserLink(target, target.display_name)}`,
    `\u0414\u0430\u0442\u0430: <b>${formatScheduleDate(date, true)}</b>`,
    `\u0421\u0435\u0439\u0447\u0430\u0441: <b>${entryDescription(entry)}</b>`
  ].join("\n"), {
    inline_keyboard: [
      [{
        text: "\u{1F5D1} \u0414\u0430, \u0443\u0434\u0430\u043B\u0438\u0442\u044C",
        callback_data: `sched:eclear:${period.id}:${target.chat_id}:${staffPage}:${date}`
      }],
      [{
        text: "\u041E\u0442\u043C\u0435\u043D\u0430",
        callback_data: `sched:eday:${period.id}:${target.chat_id}:${staffPage}:${date}`
      }]
    ]
  });
}
__name(showManagedClearConfirmation, "showManagedClearConfirmation");
async function clearManagedEntry(callback, env, periodId, targetChatId, staffPage, date) {
  const [period, target, before] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date)
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    await answerCallback(env, callback.id, "\u041F\u0435\u0440\u0438\u043E\u0434 \u0438\u043B\u0438 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D", true);
    return showManagerStaff(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      staffPage
    );
  }
  if (!before) {
    await answerCallback(env, callback.id, "\u0417\u0430\u043F\u0438\u0441\u044C \u0443\u0436\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u0430");
    return showManagedEmployee(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      targetChatId,
      staffPage
    );
  }
  const now = /* @__PURE__ */ new Date();
  const today = sqlDateToday(now);
  const deleted = await env.DB.prepare(`
    DELETE FROM schedule_entries
    WHERE period_id = ? AND chat_id = ? AND shift_date = ?
      AND EXISTS (
        SELECT 1
        FROM schedule_periods
        WHERE id = ? AND status = 'open' AND end_date >= ?
          AND ? BETWEEN start_date AND end_date
          AND (
            start_date <= ?
            OR (? = 1 AND start_date = ?)
          )
      )
  `).bind(
    periodId,
    targetChatId,
    date,
    periodId,
    today,
    date,
    today,
    canOpenNextWeek(now) ? 1 : 0,
    nextMonday(1, now)
  ).run();
  if ((deleted.meta?.changes ?? 0) !== 1) {
    await answerCallback(env, callback.id, "\u0413\u0440\u0430\u0444\u0438\u043A \u0443\u0436\u0435 \u0437\u0430\u043A\u0440\u044B\u0442. \u0417\u0430\u043F\u0438\u0441\u044C \u043D\u0435 \u0443\u0434\u0430\u043B\u0435\u043D\u0430.", true);
    return showPeriod(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      true
    );
  }
  const delivered = await notifyManagedScheduleChange(
    env,
    target,
    callback.from,
    period,
    date,
    before,
    null
  );
  await answerCallback(
    env,
    callback.id,
    delivered ? "\u0417\u0430\u043F\u0438\u0441\u044C \u0443\u0434\u0430\u043B\u0435\u043D\u0430, \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E" : "\u0417\u0430\u043F\u0438\u0441\u044C \u0443\u0434\u0430\u043B\u0435\u043D\u0430, \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043D\u0435 \u0434\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E"
  );
  return showManagedEmployee(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    periodId,
    targetChatId,
    staffPage
  );
}
__name(clearManagedEntry, "clearManagedEntry");
async function showCloseConfirmation(env, chatId, messageId, periodId) {
  const period = await periodById(env, periodId);
  if (!canManagerEditPeriod(period)) {
    return showPeriod(env, chatId, messageId, periodId, true);
  }
  return editMessage(env, chatId, messageId, [
    "\u2705 <b>\u0423\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u0433\u0440\u0430\u0444\u0438\u043A?</b>",
    "",
    `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
    "",
    "\u0417\u0430\u043F\u0438\u0441\u044C \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u043E\u0432 \u0437\u0430\u043A\u0440\u043E\u0435\u0442\u0441\u044F, \u0430 \u043E\u0431\u0449\u0438\u0439 \u0433\u0440\u0430\u0444\u0438\u043A \u043F\u043E\u044F\u0432\u0438\u0442\u0441\u044F \u0443 \u0432\u0441\u0435\u0439 \u043A\u043E\u043C\u0430\u043D\u0434\u044B."
  ].join("\n"), {
    inline_keyboard: [
      [{ text: "\u2705 \u0414\u0430, \u0437\u0430\u043A\u0440\u044B\u0442\u044C \u0438 \u0443\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C", callback_data: `sched:close:${period.id}` }],
      [{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `sched:manager:${period.id}` }]
    ]
  });
}
__name(showCloseConfirmation, "showCloseConfirmation");
async function handleScheduleCallback(callback, env, ctx, origin) {
  if (/^sched:(history|deleteask|split|action):/.test(callback.data ?? "")) {
    return handleScheduleAction(callback, env);
  }
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  const data = callback.data ?? "";
  if (data === "sched:hub" || data === "sched:home") {
    await answerCallback(env, callback.id);
    return showScheduleHub(env, chatId, messageId);
  }
  if (data === "sched:current") {
    await answerCallback(env, callback.id);
    return showCurrentSchedule(env, chatId, messageId);
  }
  if (data === "sched:next") {
    await answerCallback(env, callback.id);
    return showNextSchedule(env, chatId, messageId);
  }
  const currentPageMatch = /^sched:cur:(\d+):(\d+)$/.exec(data);
  if (currentPageMatch) {
    await answerCallback(env, callback.id);
    return showCurrentSchedule(
      env,
      chatId,
      messageId,
      Number(currentPageMatch[2]),
      Number(currentPageMatch[1])
    );
  }
  const nextPageMatch = /^sched:nxt:(\d+):(\d+)$/.exec(data);
  if (nextPageMatch) {
    await answerCallback(env, callback.id);
    return showNextSchedule(
      env,
      chatId,
      messageId,
      Number(nextPageMatch[2]),
      Number(nextPageMatch[1])
    );
  }
  if (data === "sched:published") {
    await answerCallback(env, callback.id);
    return showPublishedSchedules(env, chatId, messageId);
  }
  const publicPeriodMatch = /^sched:pub:(\d+):(\d+)$/.exec(data);
  if (publicPeriodMatch) {
    await answerCallback(env, callback.id);
    return showPublishedPeriod(
      env,
      chatId,
      messageId,
      Number(publicPeriodMatch[1]),
      Number(publicPeriodMatch[2])
    );
  }
  if (data === "sched:manager_home") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showScheduleManager(env, chatId, messageId);
  }
  if (data === "sched:open_locked") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    return answerCallback(env, callback.id, "\u041E\u0442\u043A\u0440\u044B\u0442\u0438\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0441 \u0447\u0435\u0442\u0432\u0435\u0440\u0433\u0430 \u043F\u043E \u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u0435 (\u041C\u0421\u041A)", true);
  }
  if (data === "sched:open:2") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    return answerCallback(env, callback.id, "\u041E\u0442\u043A\u0440\u044B\u0442\u0438\u0435 \u0441\u0440\u0430\u0437\u0443 \u0434\u0432\u0443\u0445 \u043D\u0435\u0434\u0435\u043B\u044C \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u043E. \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u0435 \u043C\u0435\u043D\u044E.", true);
  }
  if (data === "sched:open:1") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    const opened = await openSchedulePeriods(env, callback.from, origin);
    if (opened.notAllowed) {
      return answerCallback(env, callback.id, "\u041E\u0442\u043A\u0440\u044B\u0442\u0438\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0441 \u0447\u0435\u0442\u0432\u0435\u0440\u0433\u0430 \u043F\u043E \u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u0435 (\u041C\u0421\u041A)", true);
    }
    await answerCallback(
      env,
      callback.id,
      opened.createdCount ? "\u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u0430, \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E" : opened.notifiedCount ? "\u041D\u0435\u0434\u0435\u043B\u044F \u0443\u0436\u0435 \u0431\u044B\u043B\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u0430, \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E" : "\u042D\u0442\u0430 \u043D\u0435\u0434\u0435\u043B\u044F \u0443\u0436\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u0430"
    );
    return showScheduleManager(env, chatId, messageId);
  }
  const managerMatch = /^sched:manager:(\d+)(?::(\d+))?$/.exec(data);
  if (managerMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showPeriod(env, chatId, messageId, Number(managerMatch[1]), true, Number(managerMatch[2] ?? 0));
  }
  const editStaffMatch = /^sched:edit:(\d+):(\d+)$/.exec(data);
  if (editStaffMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showManagerStaff(
      env,
      chatId,
      messageId,
      Number(editStaffMatch[1]),
      Number(editStaffMatch[2])
    );
  }
  const editPersonMatch = /^sched:epick:(\d+):(\d+):(\d+)$/.exec(data);
  if (editPersonMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showManagedEmployee(
      env,
      chatId,
      messageId,
      Number(editPersonMatch[1]),
      Number(editPersonMatch[2]),
      Number(editPersonMatch[3])
    );
  }
  const editDayMatch = /^sched:eday:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editDayMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showManagedDay(
      env,
      chatId,
      messageId,
      Number(editDayMatch[1]),
      Number(editDayMatch[2]),
      Number(editDayMatch[3]),
      editDayMatch[4]
    );
  }
  const editStartMatch = /^sched:estart:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2}):(\d{2})$/.exec(data);
  if (editStartMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    const startHour = Number(editStartMatch[5]);
    if (startHour < START_HOUR || startHour >= END_HOUR) {
      return answerCallback(env, callback.id, "\u0412\u0440\u0435\u043C\u044F \u0443\u043A\u0430\u0437\u0430\u043D\u043E \u043D\u0435\u0432\u0435\u0440\u043D\u043E", true);
    }
    await answerCallback(env, callback.id);
    return showManagedEndPicker(
      env,
      chatId,
      messageId,
      Number(editStartMatch[1]),
      Number(editStartMatch[2]),
      Number(editStartMatch[3]),
      editStartMatch[4],
      startHour
    );
  }
  const editEndMatch = /^sched:eend:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(data);
  if (editEndMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    const startHour = Number(editEndMatch[5]);
    const endHour2 = Number(editEndMatch[6]);
    if (startHour < START_HOUR || startHour >= END_HOUR || endHour2 <= startHour || endHour2 > END_HOUR) return answerCallback(env, callback.id, "\u0412\u0440\u0435\u043C\u044F \u0443\u043A\u0430\u0437\u0430\u043D\u043E \u043D\u0435\u0432\u0435\u0440\u043D\u043E", true);
    return saveManagedEntry(
      callback,
      env,
      Number(editEndMatch[1]),
      Number(editEndMatch[2]),
      Number(editEndMatch[3]),
      editEndMatch[4],
      hourLabel(startHour),
      endHour2 === END_HOUR ? "00:00" : hourLabel(endHour2),
      0
    );
  }
  const editOffMatch = /^sched:eoff:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editOffMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    return saveManagedEntry(
      callback,
      env,
      Number(editOffMatch[1]),
      Number(editOffMatch[2]),
      Number(editOffMatch[3]),
      editOffMatch[4],
      null,
      null,
      1
    );
  }
  const editClearAskMatch = /^sched:eclearask:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editClearAskMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showManagedClearConfirmation(
      env,
      chatId,
      messageId,
      Number(editClearAskMatch[1]),
      Number(editClearAskMatch[2]),
      Number(editClearAskMatch[3]),
      editClearAskMatch[4]
    );
  }
  const editClearMatch = /^sched:eclear:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editClearMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    return clearManagedEntry(
      callback,
      env,
      Number(editClearMatch[1]),
      Number(editClearMatch[2]),
      Number(editClearMatch[3]),
      editClearMatch[4]
    );
  }
  const closeConfirmationMatch = /^sched:confirm_close:(\d+)$/.exec(data);
  if (closeConfirmationMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showCloseConfirmation(env, chatId, messageId, Number(closeConfirmationMatch[1]));
  }
  const closeMatch = /^sched:close:(\d+)$/.exec(data);
  if (closeMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    const period = await periodById(env, Number(closeMatch[1]));
    if (!period || period.end_date < sqlDateToday()) {
      return answerCallback(env, callback.id, "\u042D\u0442\u0430 \u043D\u0435\u0434\u0435\u043B\u044F \u0443\u0436\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430", true);
    }
    if (period.start_date > sqlDateToday() && (period.start_date !== nextMonday() || !canOpenNextWeek())) {
      return answerCallback(
        env,
        callback.id,
        "\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0443\u044E \u043D\u0435\u0434\u0435\u043B\u044E \u043C\u043E\u0436\u043D\u043E \u0443\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u0441 \u0447\u0435\u0442\u0432\u0435\u0440\u0433\u0430 \u043F\u043E \u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u0435 (\u041C\u0421\u041A)",
        true
      );
    }
    const update = await env.DB.prepare(`
      UPDATE schedule_periods
      SET status = 'closed', closed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'open' AND end_date >= ?
    `).bind(Number(closeMatch[1]), sqlDateToday()).run();
    if ((update.meta?.changes ?? 0) === 1 && period) {
      const currentWeek = period.start_date <= sqlDateToday() && period.end_date >= sqlDateToday();
      const notificationId = await createNotification(env, [
        currentWeek ? "\u2705 <b>\u0413\u0420\u0410\u0424\u0418\u041A \u0422\u0415\u041A\u0423\u0429\u0415\u0419 \u041D\u0415\u0414\u0415\u041B\u0418 \u041E\u0411\u041D\u041E\u0412\u041B\u0401\u041D</b>" : "\u2705 <b>\u0413\u0420\u0410\u0424\u0418\u041A \u041D\u0410 \u0421\u041B\u0415\u0414\u0423\u042E\u0429\u0423\u042E \u041D\u0415\u0414\u0415\u041B\u042E \u0423\u0422\u0412\u0415\u0420\u0416\u0414\u0401\u041D</b>",
        "",
        `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
        "",
        currentWeek ? "\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 /schedule \u2192 \xAB\u0422\u0435\u043A\u0443\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F\xBB, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u043E\u0431\u043D\u043E\u0432\u043B\u0451\u043D\u043D\u044B\u0439 \u043E\u0431\u0449\u0438\u0439 \u0433\u0440\u0430\u0444\u0438\u043A." : "\u0412\u0430\u0448\u0435 \u043D\u043E\u0432\u043E\u0435 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0433\u043E\u0442\u043E\u0432\u043E. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 /schedule \u2192 \xAB\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0430\u044F \u043D\u0435\u0434\u0435\u043B\u044F\xBB, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u043E\u0431\u0449\u0438\u0439 \u0433\u0440\u0430\u0444\u0438\u043A."
      ].join("\n"), { kind: "schedule", createdByUserId: idOf(callback.from) });
      await deliverNotificationBatch(env, origin, notificationId);
    }
    await answerCallback(
      env,
      callback.id,
      (update.meta?.changes ?? 0) === 1 ? "\u0413\u0440\u0430\u0444\u0438\u043A \u0437\u0430\u043A\u0440\u044B\u0442 \u0438 \u0443\u0442\u0432\u0435\u0440\u0436\u0434\u0451\u043D" : "\u0413\u0440\u0430\u0444\u0438\u043A \u0443\u0436\u0435 \u0431\u044B\u043B \u0437\u0430\u043A\u0440\u044B\u0442"
    );
    return showPeriod(env, chatId, messageId, Number(closeMatch[1]), true);
  }
  const reopenMatch = /^sched:reopen:(\d+)$/.exec(data);
  if (reopenMatch) {
    if (!isScheduleManager(env, callback.from)) {
      return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    }
    const periodId = Number(reopenMatch[1]);
    const period = await periodById(env, periodId);
    if (!period || period.end_date < sqlDateToday()) {
      return answerCallback(env, callback.id, "\u042D\u0442\u043E\u0442 \u043F\u0435\u0440\u0438\u043E\u0434 \u0443\u0436\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D", true);
    }
    if (period.start_date > sqlDateToday() && (period.start_date !== nextMonday() || !canOpenNextWeek())) {
      return answerCallback(
        env,
        callback.id,
        "\u0411\u0443\u0434\u0443\u0449\u0443\u044E \u043D\u0435\u0434\u0435\u043B\u044E \u043C\u043E\u0436\u043D\u043E \u0441\u043D\u043E\u0432\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0441 \u0447\u0435\u0442\u0432\u0435\u0440\u0433\u0430 \u043F\u043E \u0432\u043E\u0441\u043A\u0440\u0435\u0441\u0435\u043D\u044C\u0435 (\u041C\u0421\u041A)",
        true
      );
    }
    const update = await env.DB.prepare(`
      UPDATE schedule_periods
      SET status = 'open', closed_at = NULL
      WHERE id = ? AND status = 'closed' AND end_date >= ?
    `).bind(periodId, sqlDateToday()).run();
    if ((update.meta?.changes ?? 0) === 1) {
      if (period.start_date > sqlDateToday()) {
        const notificationId = await createNotification(env, [
          "\u{1F513} <b>\u0417\u0410\u041F\u0418\u0421\u042C \u041D\u0410 \u0421\u041B\u0415\u0414\u0423\u042E\u0429\u0423\u042E \u041D\u0415\u0414\u0415\u041B\u042E \u0421\u041D\u041E\u0412\u0410 \u041E\u0422\u041A\u0420\u042B\u0422\u0410</b>",
          "",
          `\u041F\u0435\u0440\u0438\u043E\u0434: <b>${formatScheduleDate(period.start_date, true)} \u2014 ${formatScheduleDate(period.end_date, true)}</b>`,
          "",
          "\u041C\u043E\u0436\u043D\u043E \u0441\u043D\u043E\u0432\u0430 \u0443\u043A\u0430\u0437\u0430\u0442\u044C \u0438\u043B\u0438 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0432\u0440\u0435\u043C\u044F \u0440\u0430\u0431\u043E\u0442\u044B \u0438 \u0432\u044B\u0445\u043E\u0434\u043D\u044B\u0435."
        ].join("\n"), { kind: "schedule", createdByUserId: idOf(callback.from) });
        await deliverNotificationBatch(env, origin, notificationId);
        await answerCallback(env, callback.id, "\u0417\u0430\u043F\u0438\u0441\u044C \u0441\u043D\u043E\u0432\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u0430, \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0430");
      } else {
        await answerCallback(env, callback.id, "\u0413\u0440\u0430\u0444\u0438\u043A \u043E\u0442\u043A\u0440\u044B\u0442 \u0434\u043B\u044F \u0440\u0435\u0434\u0430\u043A\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u044F");
      }
    } else {
      await answerCallback(env, callback.id, "\u0417\u0430\u043F\u0438\u0441\u044C \u0443\u0436\u0435 \u043E\u0442\u043A\u0440\u044B\u0442\u0430");
    }
    return showPeriod(env, chatId, messageId, periodId, true);
  }
  if (data === "sched:home_manager") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043C\u0435\u043D\u0435\u0434\u0436\u0435\u0440\u0443", true);
    await answerCallback(env, callback.id);
    return showScheduleManager(env, chatId, messageId);
  }
  const periodMatch = /^sched:period:(\d+)$/.exec(data);
  if (periodMatch) {
    await answerCallback(env, callback.id);
    return showEmployeePeriod(env, chatId, messageId, Number(periodMatch[1]));
  }
  const dayMatch = /^sched:day:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (dayMatch) {
    await answerCallback(env, callback.id);
    return showDay(env, chatId, messageId, Number(dayMatch[1]), dayMatch[2]);
  }
  const startMatch = /^sched:start:(\d+):(\d{4}-\d{2}-\d{2}):(\d{2})$/.exec(data);
  if (startMatch) {
    const period = await periodById(env, Number(startMatch[1]));
    if (Number(startMatch[3]) < START_HOUR || Number(startMatch[3]) >= END_HOUR || !canUseNextWeekSignup(period) || !dateBelongsToPeriod(period, startMatch[2])) return answerCallback(env, callback.id, "\u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433 \u0438\u043B\u0438 \u043F\u0435\u0440\u0438\u043E\u0434 \u0443\u0436\u0435 \u0437\u0430\u043A\u0440\u044B\u0442", true);
    await answerCallback(env, callback.id);
    return showEndPicker(env, chatId, messageId, Number(startMatch[1]), startMatch[2], Number(startMatch[3]));
  }
  const offMatch = /^sched:off:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (offMatch) {
    const period = await periodById(env, Number(offMatch[1]));
    if (!canUseNextWeekSignup(period) || !dateBelongsToPeriod(period, offMatch[2])) return answerCallback(env, callback.id, "\u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433 \u0438\u043B\u0438 \u043F\u0435\u0440\u0438\u043E\u0434 \u0443\u0436\u0435 \u0437\u0430\u043A\u0440\u044B\u0442", true);
    const saved = await saveEntry(
      env,
      Number(offMatch[1]),
      { ...callback.from, chat_id: chatId },
      offMatch[2],
      null,
      null,
      1
    );
    if (!saved) return answerCallback(env, callback.id, "\u0417\u0430\u043F\u0438\u0441\u044C \u0443\u0436\u0435 \u0437\u0430\u043A\u0440\u044B\u0442\u0430", true);
    await answerCallback(env, callback.id, "\u0412\u044B\u0445\u043E\u0434\u043D\u043E\u0439 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D");
    return showEmployeePeriod(env, chatId, messageId, Number(offMatch[1]));
  }
  if (data.startsWith("sched:end:")) {
    const selection = parseScheduleEndCallback(data);
    if (!selection) return answerCallback(env, callback.id, "\u0412\u0440\u0435\u043C\u044F \u0443\u043A\u0430\u0437\u0430\u043D\u043E \u043D\u0435\u0432\u0435\u0440\u043D\u043E", true);
    const period = await periodById(env, selection.periodId);
    if (!canUseNextWeekSignup(period) || !dateBelongsToPeriod(period, selection.date)) {
      return answerCallback(env, callback.id, "\u0417\u0430\u043F\u0438\u0441\u044C \u043E\u0442\u043A\u0440\u043E\u0435\u0442\u0441\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u0447\u0435\u0442\u0432\u0435\u0440\u0433 \u0438\u043B\u0438 \u043F\u0435\u0440\u0438\u043E\u0434 \u0443\u0436\u0435 \u0437\u0430\u043A\u0440\u044B\u0442", true);
    }
    const saved = await saveEntry(
      env,
      selection.periodId,
      { ...callback.from, chat_id: chatId },
      selection.date,
      hourLabel(selection.startHour),
      selection.endHour === END_HOUR ? "00:00" : hourLabel(selection.endHour),
      0
    );
    if (!saved) return answerCallback(env, callback.id, "\u041F\u0435\u0440\u0438\u043E\u0434 \u0443\u0436\u0435 \u0437\u0430\u043A\u0440\u044B\u0442", true);
    await answerCallback(env, callback.id, "\u0421\u043C\u0435\u043D\u0430 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0430");
    return showEmployeePeriod(env, chatId, messageId, selection.periodId);
  }
  return answerCallback(env, callback.id, "\u041A\u043D\u043E\u043F\u043A\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430", true);
}
__name(handleScheduleCallback, "handleScheduleCallback");
async function openPeriodCount(env) {
  if (!canOpenNextWeek()) return 0;
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM schedule_periods WHERE status = 'open' AND start_date = ?"
  ).bind(nextMonday()).first();
  return Number(result?.count ?? 0);
}
__name(openPeriodCount, "openPeriodCount");

// src/owner.js
var STAFF_PAGE_SIZE2 = 8;
var HISTORY_PAGE_SIZE = 8;
var ANNOUNCEMENT_MAX_LENGTH = 3e3;
function isOwner(env, userId) {
  return Boolean(env.OWNER_USER_ID) && String(userId) === String(env.OWNER_USER_ID);
}
__name(isOwner, "isOwner");
function ownerUser(row) {
  return { id: row.user_id, username: row.username };
}
__name(ownerUser, "ownerUser");
function sqlTime(value) {
  if (!value) return "\u2014";
  return moscowTime(/* @__PURE__ */ new Date(`${String(value).replace(" ", "T")}Z`));
}
__name(sqlTime, "sqlTime");
function dayLabel(value) {
  const [year, month, day] = String(value).split("-");
  return year && month && day ? `${day}.${month}.${year}` : String(value);
}
__name(dayLabel, "dayLabel");
function accessLabel(participant) {
  if (participant.blocked) return "\u{1F6D1} \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D";
  if (participant.active) return "\u2705 \u0434\u043E\u0441\u0442\u0443\u043F \u0430\u043A\u0442\u0438\u0432\u0435\u043D";
  return "\u26D4 \u0434\u043E\u0441\u0442\u0443\u043F \u0443\u0434\u0430\u043B\u0451\u043D";
}
__name(accessLabel, "accessLabel");
function shortName(value, max = 32) {
  const text = String(value ?? "\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A");
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}
__name(shortName, "shortName");
function ownerHomeKeyboard(staffBotEnabled = true) {
  return {
    inline_keyboard: [
      [{
        text: staffBotEnabled ? "\u23F8 \u041E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0434\u043B\u044F \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u043E\u0432" : "\u25B6\uFE0F \u0412\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0434\u043B\u044F \u0432\u0441\u0435\u0445",
        callback_data: "owner:toggle_staff_bot"
      }],
      [{ text: "\u{1F465} \u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438", callback_data: "owner:staff:0" }],
      [{ text: "\u{1F4DC} \u0418\u0441\u0442\u043E\u0440\u0438\u044F \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439", callback_data: "owner:history:0" }],
      [{ text: "\u{1F4CA} \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430 \u0441\u0442\u043E\u043F\u043E\u0432", callback_data: "owner:stats" }],
      [{ text: "\u{1F4E2} \u0412\u0430\u0436\u043D\u043E\u0435 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435", callback_data: "owner:announce" }],
      [{ text: "\u{1F4E3} \u041C\u043E\u0438 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F", callback_data: "owner:announcements" }],
      [{ text: "\u{1F4C5} \u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0441\u043C\u0435\u043D\u0430\u043C\u0438", callback_data: "owner:schedule" }],
      [{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]
    ]
  };
}
__name(ownerHomeKeyboard, "ownerHomeKeyboard");
async function showOwnerHome(env, chatId, edit = null) {
  const [counts, staffBotEnabled] = await Promise.all([
    env.DB.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN active = 1 AND blocked = 0 THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN blocked = 1 THEN 1 ELSE 0 END) AS blocked
      FROM participants
    `).first(),
    isStaffBotEnabled(env)
  ]);
  const text = [
    "\u{1F451} <b>\u041A\u0430\u0431\u0438\u043D\u0435\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430</b>",
    "",
    staffBotEnabled ? "\u0421\u0442\u0430\u0442\u0443\u0441 \u0431\u043E\u0442\u0430: \u{1F7E2} <b>\u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0434\u043B\u044F \u0432\u0441\u0435\u0445</b>" : "\u0421\u0442\u0430\u0442\u0443\u0441 \u0431\u043E\u0442\u0430: \u{1F9EA} <b>\u0440\u0435\u0436\u0438\u043C \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438</b>",
    staffBotEnabled ? "\u0412\u0441\u0435 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438 \u043C\u043E\u0433\u0443\u0442 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C\u0441\u044F \u0431\u043E\u0442\u043E\u043C \u0438 \u043F\u043E\u043B\u0443\u0447\u0430\u044E\u0442 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F." : "\u0414\u043B\u044F \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u0445 \u0431\u043E\u0442 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D. \u0412\u0441\u0435 \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F \u043F\u043E\u043B\u0443\u0447\u0430\u0435\u0442 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u0435\u0446.",
    ...staffBotEnabled ? [] : [
      "",
      "\u041F\u0435\u0440\u0435\u0434 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435\u043C \u0434\u043B\u044F \u0432\u0441\u0435\u0445 \u0437\u0430\u043A\u0440\u043E\u0439\u0442\u0435 \u0442\u0435\u0441\u0442\u043E\u0432\u044B\u0435 \u043F\u0435\u0440\u0438\u043E\u0434\u044B \u0441\u043C\u0435\u043D, \u0435\u0441\u043B\u0438 \u043E\u043D\u0438 \u043D\u0435 \u043D\u0443\u0436\u043D\u044B \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430\u043C."
    ],
    "",
    `\u0412\u0441\u0435\u0433\u043E \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D\u043E: <b>${Number(counts?.total ?? 0)}</b>`,
    `\u0421 \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u043C \u0434\u043E\u0441\u0442\u0443\u043F\u043E\u043C: <b>${Number(counts?.active ?? 0)}</b>`,
    `\u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u043E: <b>${Number(counts?.blocked ?? 0)}</b>`,
    "",
    "\u042D\u0442\u043E\u0442 \u0440\u0430\u0437\u0434\u0435\u043B \u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443."
  ].join("\n");
  const keyboard = ownerHomeKeyboard(staffBotEnabled);
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}
__name(showOwnerHome, "showOwnerHome");
async function showStaff(env, chatId, messageId, page = 0) {
  const result = await env.DB.prepare(`
    SELECT chat_id, user_id, display_name, username, active, blocked
    FROM participants
    ORDER BY blocked, active DESC, joined_at, chat_id
  `).all();
  const pageData = paginate(result.results ?? [], page, STAFF_PAGE_SIZE2);
  const rows = pageData.items.map((person) => [{
    text: `${person.blocked ? "\u{1F6D1}" : person.active ? "\u2705" : "\u26D4"} ${shortName(person.display_name)}`,
    callback_data: `owner:person:${person.chat_id}`
  }]);
  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) {
      navigation.push({ text: "\u2B05\uFE0F", callback_data: `owner:staff:${pageData.page - 1}` });
    }
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) {
      navigation.push({ text: "\u27A1\uFE0F", callback_data: `owner:staff:${pageData.page + 1}` });
    }
    rows.push(navigation);
  }
  rows.push([{ text: "\u25C0\uFE0F \u041A\u0430\u0431\u0438\u043D\u0435\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430", callback_data: "owner:home" }]);
  return editMessage(
    env,
    chatId,
    messageId,
    `\u{1F465} <b>\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438</b>

\u0412\u0441\u0435\u0433\u043E \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u043E\u0432: ${result.results?.length ?? 0}`,
    { inline_keyboard: rows }
  );
}
__name(showStaff, "showStaff");
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
__name(participantDetails, "participantDetails");
async function showPerson(env, ownerChatId, messageId, personChatId) {
  const person = await participantDetails(env, personChatId);
  if (!person) {
    return editMessage(env, ownerChatId, messageId, "\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D.", ownerHomeKeyboard());
  }
  const text = [
    "\u{1F464} <b>\u041A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430</b>",
    "",
    `\u0418\u043C\u044F: ${telegramUserLink(ownerUser(person), person.display_name)}`,
    `Username: ${person.username ? `@${escapeHtml(person.username)}` : "\u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D"}`,
    `\u0421\u0442\u0430\u0442\u0443\u0441: ${accessLabel(person)}`,
    `\u0417\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u043E\u0432\u0430\u043D: ${sqlTime(person.joined_at)} (\u041C\u0421\u041A)`,
    `\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u043E\u0441\u0442\u044C: ${sqlTime(person.last_seen_at)} (\u041C\u0421\u041A)`,
    `\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0439 \u0441\u0442\u043E\u043F-\u043B\u0438\u0441\u0442\u0430: <b>${Number(person.changes_count ?? 0)}</b>`
  ].join("\n");
  const rows = [[{
    text: "\u{1F4DC} \u0418\u0441\u0442\u043E\u0440\u0438\u044F \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430",
    callback_data: `owner:personhistory:${person.chat_id}:0`
  }]];
  if (!isOwner(env, person.user_id)) {
    if (person.blocked) {
      rows.push([{ text: "\u2705 \u0420\u0430\u0437\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: `owner:restore:${person.chat_id}` }]);
    } else if (person.active) {
      rows.push([{ text: "\u{1F6D1} \u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: `owner:confirm_block:${person.chat_id}` }]);
      rows.push([{ text: "\u26D4 \u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F", callback_data: `owner:confirm_remove:${person.chat_id}` }]);
    } else {
      rows.push([{ text: "\u2705 \u0412\u0435\u0440\u043D\u0443\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F", callback_data: `owner:restore:${person.chat_id}` }]);
      rows.push([{ text: "\u{1F6D1} \u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C", callback_data: `owner:confirm_block:${person.chat_id}` }]);
    }
  }
  rows.push([{ text: "\u25C0\uFE0F \u0421\u043F\u0438\u0441\u043E\u043A \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u043E\u0432", callback_data: "owner:staff:0" }]);
  return editMessage(env, ownerChatId, messageId, text, { inline_keyboard: rows });
}
__name(showPerson, "showPerson");
async function showAccessConfirmation(env, ownerChatId, messageId, personChatId, action) {
  const person = await participantDetails(env, personChatId);
  if (!person || isOwner(env, person.user_id)) {
    return showOwnerHome(env, ownerChatId, { messageId });
  }
  const isBlock = action === "block";
  const text = [
    `${isBlock ? "\u{1F6D1}" : "\u26D4"} <b>${isBlock ? "\u0417\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430?" : "\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430?"}</b>`,
    "",
    telegramUserLink(ownerUser(person), person.display_name),
    "",
    isBlock ? "\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A \u043D\u0435 \u0441\u043C\u043E\u0436\u0435\u0442 \u0432\u043E\u0439\u0442\u0438 \u0434\u0430\u0436\u0435 \u043F\u043E \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u0441\u0441\u044B\u043B\u043A\u0435, \u043F\u043E\u043A\u0430 \u0432\u044B \u0435\u0433\u043E \u043D\u0435 \u0440\u0430\u0437\u0431\u043B\u043E\u043A\u0438\u0440\u0443\u0435\u0442\u0435." : "\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A \u043F\u0435\u0440\u0435\u0441\u0442\u0430\u043D\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u044C \u0443\u0432\u0435\u0434\u043E\u043C\u043B\u0435\u043D\u0438\u044F. \u041F\u043E\u0437\u0436\u0435 \u043E\u043D \u0441\u043C\u043E\u0436\u0435\u0442 \u0441\u043D\u043E\u0432\u0430 \u0432\u043E\u0439\u0442\u0438 \u043F\u043E \u0440\u0430\u0431\u043E\u0447\u0435\u0439 \u0441\u0441\u044B\u043B\u043A\u0435."
  ].join("\n");
  return editMessage(env, ownerChatId, messageId, text, {
    inline_keyboard: [
      [{
        text: isBlock ? "\u0414\u0430, \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u0442\u044C" : "\u0414\u0430, \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0443\u043F",
        callback_data: `owner:${isBlock ? "block" : "remove"}:${person.chat_id}`
      }],
      [{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `owner:person:${person.chat_id}` }]
    ]
  });
}
__name(showAccessConfirmation, "showAccessConfirmation");
async function changeAccess(env, ownerChatId, messageId, personChatId, action) {
  const person = await participantDetails(env, personChatId);
  if (!person || isOwner(env, person.user_id)) {
    return showOwnerHome(env, ownerChatId, { messageId });
  }
  if (action === "block") {
    await env.DB.prepare(
      "UPDATE participants SET active = 0, blocked = 1 WHERE chat_id = ?"
    ).bind(personChatId).run();
  } else if (action === "remove") {
    await env.DB.prepare(
      "UPDATE participants SET active = 0, blocked = 0 WHERE chat_id = ?"
    ).bind(personChatId).run();
  } else {
    await env.DB.prepare(
      "UPDATE participants SET active = 1, blocked = 0 WHERE chat_id = ?"
    ).bind(personChatId).run();
  }
  return showPerson(env, ownerChatId, messageId, personChatId);
}
__name(changeAccess, "changeAccess");
function historyLine(row, includeActor) {
  const status = row.new_availability_status ?? (row.new_status ? "stopped" : "available");
  const action = {
    available: "\u2705 \u0432 \u043F\u0440\u043E\u0434\u0430\u0436\u0443",
    limited: `\u26A0\uFE0F \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435${row.status_details ? `: ${escapeHtml(row.status_details)} \u0448\u0442.` : ""}`,
    expected: `\u{1F552} \u043E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F${row.status_details ? ` \u043A ${sqlTime(row.status_details)} (\u041C\u0421\u041A)` : ""}`,
    stopped: "\u{1F6D1} \u043D\u0430 \u0441\u0442\u043E\u043F"
  }[status] ?? "\u0438\u0437\u043C\u0435\u043D\u0451\u043D";
  const lines = [
    `<b>${sqlTime(row.changed_at)}</b> \u2014 ${action}`,
    `${escapeHtml(row.dish_name)} \xB7 ${escapeHtml(row.category_name)}`
  ];
  if (includeActor) {
    lines.push(`\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A: ${telegramUserLink(ownerUser(row), row.actor_name)}`);
  }
  return lines.join("\n");
}
__name(historyLine, "historyLine");
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
  const result = personChatId == null ? await statement.bind(HISTORY_PAGE_SIZE + 1, offset).all() : await statement.bind(personChatId, HISTORY_PAGE_SIZE + 1, offset).all();
  const allRows = result.results ?? [];
  const hasNext = allRows.length > HISTORY_PAGE_SIZE;
  const rows = allRows.slice(0, HISTORY_PAGE_SIZE);
  let title = "\u{1F4DC} <b>\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0439</b>";
  let backCallback = "owner:home";
  if (personChatId != null) {
    const person = await participantDetails(env, personChatId);
    title = `\u{1F4DC} <b>\u0418\u0441\u0442\u043E\u0440\u0438\u044F: ${escapeHtml(person?.display_name ?? "\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A")}</b>`;
    backCallback = `owner:person:${personChatId}`;
  }
  const text = rows.length ? [title, "", ...rows.flatMap((row) => [historyLine(row, personChatId == null), ""])].join("\n") : `${title}

\u0414\u0435\u0439\u0441\u0442\u0432\u0438\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.`;
  const nav = [];
  const prefix = personChatId == null ? "owner:history" : `owner:personhistory:${personChatId}`;
  if (page > 0) nav.push({ text: "\u2B05\uFE0F", callback_data: `${prefix}:${page - 1}` });
  nav.push({ text: `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 ${Number(page) + 1}`, callback_data: "noop" });
  if (hasNext) nav.push({ text: "\u27A1\uFE0F", callback_data: `${prefix}:${Number(page) + 1}` });
  return editMessage(env, chatId, messageId, text, {
    inline_keyboard: [nav, [{ text: "\u25C0\uFE0F \u041D\u0430\u0437\u0430\u0434", callback_data: backCallback }]]
  });
}
__name(showHistory, "showHistory");
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
  const lines = ["\u{1F4CA} <b>\u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430 \u0441\u0442\u043E\u043F\u043E\u0432 \u043F\u043E \u0434\u043D\u044F\u043C</b>", ""];
  if (!rows.length) {
    lines.push("\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442.");
  } else {
    for (const row of rows) {
      lines.push(
        `<b>${dayLabel(row.day)}</b>: \u{1F6D1} ${Number(row.stopped)} \xB7 \u26A0\uFE0F ${Number(row.limited)} \xB7 \u{1F552} ${Number(row.expected)} \xB7 \u2705 ${Number(row.returned)} \xB7 \u{1F464} ${Number(row.employees)}`
      );
    }
    lines.push("", "\u{1F6D1} \u0441\u0442\u043E\u043F \xB7 \u26A0\uFE0F \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 \xB7 \u{1F552} \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \xB7 \u2705 \u043F\u0440\u043E\u0434\u0430\u0436\u0430 \xB7 \u{1F464} \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u043E\u0432");
  }
  return editMessage(env, chatId, messageId, lines.join("\n"), {
    inline_keyboard: [[{ text: "\u25C0\uFE0F \u041A\u0430\u0431\u0438\u043D\u0435\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430", callback_data: "owner:home" }]]
  });
}
__name(showStats, "showStats");
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
__name(setOwnerState, "setOwnerState");
async function clearOwnerState(env, userId) {
  await env.DB.prepare("DELETE FROM owner_state WHERE user_id = ?").bind(userId).run();
}
__name(clearOwnerState, "clearOwnerState");
async function ownerState(env, userId) {
  return env.DB.prepare(
    "SELECT action, payload FROM owner_state WHERE user_id = ? LIMIT 1"
  ).bind(userId).first();
}
__name(ownerState, "ownerState");
async function beginAnnouncement(env, chatId, messageId, userId) {
  await setOwnerState(env, userId, "announcement_compose");
  const staffBotEnabled = await isStaffBotEnabled(env);
  return editMessage(env, chatId, messageId, [
    "\u{1F4E2} <b>\u0412\u0430\u0436\u043D\u043E\u0435 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435</b>",
    "",
    "\u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435\u043C \u0442\u0435\u043A\u0441\u0442 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F.",
    staffBotEnabled ? "\u0415\u0433\u043E \u043F\u043E\u043B\u0443\u0447\u0430\u0442 \u0432\u0441\u0435 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438 \u0441 \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u043C \u0434\u043E\u0441\u0442\u0443\u043F\u043E\u043C." : "\u0421\u0435\u0439\u0447\u0430\u0441 \u0432\u043A\u043B\u044E\u0447\u0451\u043D \u0440\u0435\u0436\u0438\u043C \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438: \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u0435 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u044B.",
    "",
    "\u0414\u043B\u044F \u0432\u044B\u0445\u043E\u0434\u0430 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /cancel."
  ].join("\n"), {
    inline_keyboard: [[{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "owner:announce_cancel" }]]
  });
}
__name(beginAnnouncement, "beginAnnouncement");
async function handleOwnerMessage(message, env) {
  if (!isOwner(env, message.from?.id)) return false;
  const state = await ownerState(env, message.from.id);
  if (state?.action !== "announcement_compose") return false;
  const text = message.text?.trim() ?? "";
  if (!text || text.startsWith("/")) return false;
  if (text.length > ANNOUNCEMENT_MAX_LENGTH) {
    await sendMessage(
      env,
      message.chat.id,
      `\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0434\u043B\u0438\u043D\u043D\u043E\u0435. \u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C ${ANNOUNCEMENT_MAX_LENGTH} \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432.`
    );
    return true;
  }
  await setOwnerState(env, message.from.id, "announcement_preview", text);
  const staffBotEnabled = await isStaffBotEnabled(env);
  await sendMessage(env, message.chat.id, [
    "\u{1F4E2} <b>\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F</b>",
    "",
    escapeHtml(text),
    "",
    staffBotEnabled ? "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0432\u0441\u0435\u043C \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430\u043C?" : "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0435\u0431\u0435?"
  ].join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{
          text: staffBotEnabled ? "\u{1F4E2} \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0432\u0441\u0435\u043C" : "\u{1F9EA} \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0435\u0431\u0435",
          callback_data: "owner:announce_send"
        }],
        [{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "owner:announce_cancel" }]
      ]
    }
  });
  return true;
}
__name(handleOwnerMessage, "handleOwnerMessage");
function announcementSnippet(value, max = 34) {
  const text = String(value ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").replace(/^📢\s*ВАЖНОЕ ОБЪЯВЛЕНИЕ\s*/i, "").trim();
  return shortName(text || "\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435", max);
}
__name(announcementSnippet, "announcementSnippet");
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
    text: `${announcement.deleted_at ? "\u{1F5D1}" : "\u{1F4E2}"} ${announcementSnippet(announcement.message_text)}`,
    callback_data: `owner:announcement:${announcement.id}`
  }]);
  rows.push([{ text: "\u25C0\uFE0F \u041A\u0430\u0431\u0438\u043D\u0435\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430", callback_data: "owner:home" }]);
  return editMessage(
    env,
    chatId,
    messageId,
    announcements.length ? "\u{1F4E3} <b>\u041C\u043E\u0438 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F</b>\n\n\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u0438\u043B\u0438 \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0435\u0433\u043E." : "\u{1F4E3} <b>\u041C\u043E\u0438 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F</b>\n\n\u0412\u044B \u0435\u0449\u0451 \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u043B\u0438 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0439.",
    { inline_keyboard: rows }
  );
}
__name(showAnnouncements, "showAnnouncements");
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
__name(announcementDetails, "announcementDetails");
async function showAnnouncement(env, chatId, messageId, notificationId) {
  const announcement = await announcementDetails(env, notificationId);
  if (!announcement) return showAnnouncements(env, chatId, messageId);
  const text = [
    "\u{1F4E3} <b>\u041E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u043E\u0435 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435</b>",
    `\u0414\u0430\u0442\u0430: ${sqlTime(announcement.created_at)} (\u041C\u0421\u041A)`,
    `\u0414\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E: ${Number(announcement.delivered_count ?? 0)}`,
    announcement.deleted_at ? `\u0423\u0434\u0430\u043B\u0435\u043D\u043E \u0438\u0437 \u0447\u0430\u0442\u043E\u0432: ${Number(announcement.deleted_count ?? 0)}` : "\u0421\u0442\u0430\u0442\u0443\u0441: \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E",
    "",
    announcement.message_text
  ].join("\n");
  const rows = [];
  if (!announcement.deleted_at && announcement.deletable) {
    rows.push([{ text: "\u{1F5D1} \u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0443 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u043E\u0432", callback_data: `owner:announce_delete_confirm:${announcement.id}` }]);
  }
  if (!announcement.deleted_at && !announcement.deletable) {
    rows.push([{ text: "\u0423\u0434\u0430\u043B\u0435\u043D\u0438\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u043F\u043E\u0441\u043B\u0435 48 \u0447\u0430\u0441\u043E\u0432", callback_data: "noop" }]);
  }
  rows.push([{ text: "\u25C0\uFE0F \u041C\u043E\u0438 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F", callback_data: "owner:announcements" }]);
  return editMessage(env, chatId, messageId, text, { inline_keyboard: rows });
}
__name(showAnnouncement, "showAnnouncement");
async function confirmAnnouncementDelete(env, chatId, messageId, notificationId) {
  const announcement = await announcementDetails(env, notificationId);
  if (!announcement || announcement.deleted_at || !announcement.deletable) {
    return showAnnouncement(env, chatId, messageId, notificationId);
  }
  return editMessage(env, chatId, messageId, [
    "\u{1F5D1} <b>\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435?</b>",
    "",
    "\u0411\u043E\u0442 \u0443\u0434\u0430\u043B\u0438\u0442 \u044D\u0442\u043E \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0438\u0437 \u043B\u0438\u0447\u043D\u044B\u0445 \u0447\u0430\u0442\u043E\u0432 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u043E\u0432.",
    "Telegram \u0440\u0430\u0437\u0440\u0435\u0448\u0430\u0435\u0442 \u0443\u0434\u0430\u043B\u0435\u043D\u0438\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 \u0442\u043E\u043B\u044C\u043A\u043E \u0432 \u0442\u0435\u0447\u0435\u043D\u0438\u0435 48 \u0447\u0430\u0441\u043E\u0432 \u043F\u043E\u0441\u043B\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043A\u0438."
  ].join("\n"), {
    inline_keyboard: [
      [{ text: "\u0414\u0430, \u0443\u0434\u0430\u043B\u0438\u0442\u044C \u0443 \u0432\u0441\u0435\u0445", callback_data: `owner:announce_delete:${notificationId}` }],
      [{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `owner:announcement:${notificationId}` }]
    ]
  });
}
__name(confirmAnnouncementDelete, "confirmAnnouncementDelete");
async function sendAnnouncement(callback, env, ctx, origin) {
  const state = await ownerState(env, callback.from.id);
  if (state?.action !== "announcement_preview" || !state.payload) {
    return answerCallback(env, callback.id, "\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D", true);
  }
  await clearOwnerState(env, callback.from.id);
  const messageText = [
    "\u{1F4E2} <b>\u0412\u0410\u0416\u041D\u041E\u0415 \u041E\u0411\u042A\u042F\u0412\u041B\u0415\u041D\u0418\u0415</b>",
    "",
    escapeHtml(state.payload),
    "",
    `\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u043B(\u0430): ${telegramUserLink(callback.from)}`
  ].join("\n");
  const notificationId = await createNotification(env, messageText, {
    kind: "announcement",
    createdByUserId: callback.from.id
  });
  const recipientCount = await notificationRecipientCount(env);
  await answerCallback(env, callback.id, "\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F");
  await deliverNotificationBatch(env, origin, notificationId);
  return editMessage(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    `\u2705 <b>\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E</b>

\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439: ${recipientCount}`,
    {
      inline_keyboard: [
        [{ text: "\u{1F5D1} \u0423\u0434\u0430\u043B\u0438\u0442\u044C \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435", callback_data: `owner:announce_delete_confirm:${notificationId}` }],
        [{ text: "\u{1F4E3} \u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435", callback_data: `owner:announcement:${notificationId}` }],
        [{ text: "\u25C0\uFE0F \u041A\u0430\u0431\u0438\u043D\u0435\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430", callback_data: "owner:home" }]
      ]
    }
  );
}
__name(sendAnnouncement, "sendAnnouncement");
async function handleOwnerCallback(callback, env, ctx, origin) {
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
      enabled ? "\u0411\u043E\u0442 \u0441\u043D\u043E\u0432\u0430 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0434\u043B\u044F \u0432\u0441\u0435\u0445" : "\u0420\u0435\u0436\u0438\u043C \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0432\u043A\u043B\u044E\u0447\u0451\u043D"
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
    await answerCallback(env, callback.id, "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E");
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
    await answerCallback(env, callback.id, "\u0423\u0434\u0430\u043B\u044F\u044E \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435");
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
      Number(personHistoryMatch[1])
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
      confirmationMatch[1]
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
      accessMatch[1]
    );
  }
  return answerCallback(env, callback.id, "\u041A\u043D\u043E\u043F\u043A\u0430 \u043A\u0430\u0431\u0438\u043D\u0435\u0442\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430", true);
}
__name(handleOwnerCallback, "handleOwnerCallback");
async function cancelOwnerAction(message, env) {
  if (!isOwner(env, message.from?.id) || commandName(message.text) !== "/cancel") return false;
  const state = await ownerState(env, message.from.id);
  if (!state) return false;
  await clearOwnerState(env, message.from.id);
  await showOwnerHome(env, message.chat.id);
  return true;
}
__name(cancelOwnerAction, "cancelOwnerAction");

// src/publicAnnouncement.js
var MAX_LENGTH = 1200;
async function setState(env, userId, action, payload = null) {
  await env.DB.prepare(`
    INSERT INTO interaction_state (user_id, action, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      action = excluded.action, payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
  `).bind(userId, action, payload).run();
}
__name(setState, "setState");
async function clearState(env, userId) {
  await env.DB.prepare("DELETE FROM interaction_state WHERE user_id = ?").bind(userId).run();
}
__name(clearState, "clearState");
async function getState(env, userId) {
  return env.DB.prepare("SELECT action, payload FROM interaction_state WHERE user_id = ? LIMIT 1").bind(userId).first();
}
__name(getState, "getState");
async function beginPublicAnnouncement(env, chatId, userId, messageId = null) {
  await setState(env, userId, "public_announcement_compose");
  const staffBotEnabled = await isStaffBotEnabled(env);
  const text = [
    "\u{1F4E3} <b>\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u0434\u043B\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u044B</b>",
    "",
    "\u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435\u043C \u0442\u0435\u043A\u0441\u0442 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F.",
    staffBotEnabled ? "\u0415\u0433\u043E \u043F\u043E\u043B\u0443\u0447\u0430\u0442 \u0432\u0441\u0435 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438 \u0441 \u0430\u043A\u0442\u0438\u0432\u043D\u044B\u043C \u0434\u043E\u0441\u0442\u0443\u043F\u043E\u043C." : "\u0421\u0435\u0439\u0447\u0430\u0441 \u0432\u043A\u043B\u044E\u0447\u0451\u043D \u0440\u0435\u0436\u0438\u043C \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438: \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u0435 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u044B.",
    "",
    "\u0414\u043B\u044F \u043E\u0442\u043C\u0435\u043D\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /cancel."
  ].join("\n");
  const keyboard = { inline_keyboard: [[{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "announce:cancel" }]] };
  if (messageId) return editMessage(env, chatId, messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}
__name(beginPublicAnnouncement, "beginPublicAnnouncement");
async function handlePublicAnnouncementMessage(message, env) {
  const userId = message.from?.id;
  if (!userId) return false;
  const state = await getState(env, userId);
  if (!state || !["public_announcement_compose", "public_announcement_preview"].includes(state.action)) return false;
  const text = message.text?.trim() ?? "";
  if (commandName(text) === "/cancel") {
    await clearState(env, userId);
    await sendMessage(env, message.chat.id, "\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E.");
    return true;
  }
  if (state.action !== "public_announcement_compose") return false;
  if (text.startsWith("/")) {
    await clearState(env, userId);
    return false;
  }
  if (!text) return false;
  if (text.length > MAX_LENGTH) {
    await sendMessage(env, message.chat.id, `\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0434\u043B\u0438\u043D\u043D\u043E\u0435. \u041C\u0430\u043A\u0441\u0438\u043C\u0443\u043C ${MAX_LENGTH} \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432.`);
    return true;
  }
  await setState(env, userId, "public_announcement_preview", text);
  const staffBotEnabled = await isStaffBotEnabled(env);
  await sendMessage(env, message.chat.id, [
    "\u{1F4E3} <b>\u041F\u0440\u0435\u0434\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u044F</b>",
    "",
    escapeHtml(text),
    "",
    `\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C: ${telegramUserLink(message.from)}`,
    "",
    staffBotEnabled ? "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0432\u0441\u0435\u043C \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0430\u043C?" : "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443?"
  ].join("\n"), {
    reply_markup: {
      inline_keyboard: [
        [{
          text: staffBotEnabled ? "\u{1F4E3} \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0432\u0441\u0435\u043C" : "\u{1F9EA} \u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0441\u0435\u0431\u0435",
          callback_data: "announce:send"
        }],
        [{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: "announce:cancel" }]
      ]
    }
  });
  return true;
}
__name(handlePublicAnnouncementMessage, "handlePublicAnnouncementMessage");
async function handlePublicAnnouncementCallback(callback, env, origin) {
  const chatId = callback.message.chat.id;
  const messageId = callback.message.message_id;
  if (callback.data === "announce:start") {
    await answerCallback(env, callback.id);
    return beginPublicAnnouncement(env, chatId, callback.from.id, messageId);
  }
  if (callback.data === "announce:cancel") {
    await clearState(env, callback.from.id);
    await answerCallback(env, callback.id, "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E");
    return editMessage(env, chatId, messageId, "\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043C\u0435\u043D\u0435\u043D\u043E.", { inline_keyboard: [] });
  }
  if (callback.data !== "announce:send") return null;
  const state = await getState(env, callback.from.id);
  if (state?.action !== "public_announcement_preview" || !state.payload) {
    return answerCallback(env, callback.id, "\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D", true);
  }
  await clearState(env, callback.from.id);
  const messageText = [
    "\u{1F4E3} <b>\u041E\u0411\u042A\u042F\u0412\u041B\u0415\u041D\u0418\u0415</b>",
    "",
    escapeHtml(state.payload),
    "",
    `\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u043B(\u0430): ${telegramUserLink(callback.from)}`
  ].join("\n");
  const notificationId = await createNotification(env, messageText, {
    kind: "announcement",
    createdByUserId: callback.from.id
  });
  const recipientCount = await notificationRecipientCount(env);
  await answerCallback(env, callback.id, "\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442\u0441\u044F");
  await deliverNotificationBatch(env, origin, notificationId);
  return editMessage(env, chatId, messageId, [
    "\u2705 <b>\u041E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E</b>",
    "",
    `\u041F\u043E\u043B\u0443\u0447\u0430\u0442\u0435\u043B\u0435\u0439: ${recipientCount}`
  ].join("\n"), { inline_keyboard: [[{ text: "\u25C0\uFE0F \u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E", callback_data: "home" }]] });
}
__name(handlePublicAnnouncementCallback, "handlePublicAnnouncementCallback");

// src/orderParser.js
var CATEGORY_ORDER = [
  "\u0417\u0430\u043A\u0443\u0441\u043A\u0438",
  "\u0413\u043E\u0440\u044F\u0447\u0438\u0435 \u0437\u0430\u043A\u0443\u0441\u043A\u0438",
  "\u0421\u0430\u043B\u0430\u0442\u044B",
  "\u0421\u0443\u043F\u044B",
  "\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430",
  "\u0420\u044B\u0431\u043D\u044B\u0435 \u0431\u043B\u044E\u0434\u0430",
  "\u0411\u043B\u044E\u0434\u0430 \u043D\u0430 \u0443\u0433\u043B\u044F\u0445",
  "\u0413\u0430\u0440\u043D\u0438\u0440\u044B",
  "\u0421\u043E\u0443\u0441\u044B",
  "\u0412\u044B\u043F\u0435\u0447\u043A\u0430",
  "\u0414\u0435\u0441\u0435\u0440\u0442\u044B",
  "\u0427\u0451\u0440\u043D\u044B\u0439 \u0447\u0430\u0439",
  "\u0427\u0430\u0439\u043D\u044B\u0435 \u043A\u043E\u043C\u043F\u043E\u0437\u0438\u0446\u0438\u0438",
  "\u0417\u0435\u043B\u0451\u043D\u044B\u0439 \u0447\u0430\u0439",
  "\u0414\u043E\u0431\u0430\u0432\u043A\u0438 \u043A \u0447\u0430\u044E",
  "\u041A\u043E\u0444\u0435",
  "\u0422\u0430\u0442\u0430\u0440\u0441\u043A\u0438\u0435 \u043D\u0430\u043F\u0438\u0442\u043A\u0438",
  "\u041D\u0430\u043F\u0438\u0442\u043A\u0438 Rich",
  "\u041F\u0440\u043E\u0445\u043B\u0430\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043D\u0430\u043F\u0438\u0442\u043A\u0438",
  "\u041C\u0438\u043D\u0435\u0440\u0430\u043B\u044C\u043D\u0430\u044F \u0432\u043E\u0434\u0430",
  "\u0418\u0433\u0440\u0438\u0441\u0442\u043E\u0435 \u0432\u0438\u043D\u043E",
  "\u041A\u0440\u0430\u0441\u043D\u043E\u0435 \u0432\u0438\u043D\u043E",
  "\u0420\u043E\u0437\u043E\u0432\u043E\u0435 \u0432\u0438\u043D\u043E",
  "\u0411\u0435\u043B\u043E\u0435 \u0432\u0438\u043D\u043E",
  "\u0411\u0435\u0437\u0430\u043B\u043A\u043E\u0433\u043E\u043B\u044C\u043D\u043E\u0435 \u0432\u0438\u043D\u043E",
  "\u041B\u0438\u043A\u0451\u0440\u044B",
  "\u0412\u043E\u0434\u043A\u0430",
  "\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0438",
  "\u0412\u0438\u0441\u043A\u0438",
  "\u041A\u043E\u043D\u044C\u044F\u043A",
  "\u0420\u043E\u043C",
  "\u0414\u0436\u0438\u043D",
  "\u0422\u0435\u043A\u0438\u043B\u0430",
  "\u0420\u0430\u0437\u043B\u0438\u0432\u043D\u043E\u0435 \u043F\u0438\u0432\u043E",
  "\u0411\u0443\u0442\u044B\u043B\u043E\u0447\u043D\u043E\u0435 \u043F\u0438\u0432\u043E",
  "\u0428\u043E\u0442\u044B",
  "\u0410\u043B\u043A\u043E\u0433\u043E\u043B\u044C\u043D\u044B\u0435 \u043A\u043E\u043A\u0442\u0435\u0439\u043B\u0438",
  "\u0410\u0432\u0442\u043E\u0440\u0441\u043A\u0438\u0435 \u043A\u043E\u043A\u0442\u0435\u0439\u043B\u0438",
  "\u0411\u0435\u0437\u0430\u043B\u043A\u043E\u0433\u043E\u043B\u044C\u043D\u044B\u0435 \u043A\u043E\u043A\u0442\u0435\u0439\u043B\u0438",
  "\u041C\u043E\u043B\u043E\u0447\u043D\u044B\u0435 \u043A\u043E\u043A\u0442\u0435\u0439\u043B\u0438",
  "\u041B\u0438\u043C\u043E\u043D\u0430\u0434\u044B",
  "\u0414\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u043E"
];
function normalize(value) {
  return String(value ?? "").toLocaleLowerCase("ru-RU").replaceAll("\u0451", "\u0435").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
__name(normalize, "normalize");
function quantityAndText(line) {
  const normalizedLine = line.replace(/^²\s*/u, "2 ");
  const quantityMatch = /^(\d{1,3})\s+/.exec(normalizedLine.trim());
  const quantity = quantityMatch ? Number(quantityMatch[1]) : 1;
  const text = (quantityMatch ? normalizedLine.slice(quantityMatch[0].length) : normalizedLine).trim();
  const noteParts = [];
  const noteMatch = text.match(/\bпо\s+\d+(?:[.,]\d+)?\b/iu);
  if (noteMatch) noteParts.push(noteMatch[0]);
  if (/без\s+зелени/i.test(text)) noteParts.push("\u0431\u0435\u0437 \u0437\u0435\u043B\u0435\u043D\u0438");
  if (/в\s+конце/i.test(text)) noteParts.push("\u0432 \u043A\u043E\u043D\u0446\u0435");
  if (/холодн/i.test(text)) noteParts.push("\u0445\u043E\u043B\u043E\u0434\u043D\u044B\u0439");
  const clean = text.replace(/\bпо\s+\d+(?:[.,]\d+)?\b/giu, "").replace(/\b(в\s+конце|без\s+зелени|холодн\w*)\b/giu, "").replace(/\s+/g, " ").trim();
  return { quantity, text, clean, note: noteParts.join(", ") };
}
__name(quantityAndText, "quantityAndText");
function findByCategory(dishes, categoryName, name) {
  const wanted = normalize(name);
  return dishes.find((dish) => normalize(dish.category_name) === normalize(categoryName) && normalize(dish.name) === wanted) ?? dishes.find((dish) => normalize(dish.category_name) === normalize(categoryName) && normalize(dish.name).includes(wanted));
}
__name(findByCategory, "findByCategory");
function aliasMatch(text, dishes) {
  const value = normalize(text);
  const direct = /* @__PURE__ */ __name((category, name, when = () => true) => when(value) ? findByCategory(dishes, category, name) : null, "direct");
  if (/туган\s+авылым\s+салат/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u0422\u0443\u0433\u0430\u043D \u0410\u0432\u044B\u043B\u044B\u043C");
  if (/^туг\s+авылым(?:\s+0?\d+)?$/.test(value) || /^туган\s+авылым\s+0?\d+$/.test(value)) return direct("\u0427\u0451\u0440\u043D\u044B\u0439 \u0447\u0430\u0439", "\u0422\u0443\u0433\u0430\u043D \u0410\u0432\u044B\u043B\u044B\u043C");
  if (/^татарский(?:\s+чай)?(?:\s+0?\d+)?/.test(value)) return direct("\u0427\u0451\u0440\u043D\u044B\u0439 \u0447\u0430\u0439", "\u0422\u0430\u0442\u0430\u0440\u0441\u043A\u0438\u0439 \u0447\u0430\u0439");
  if (/^(беш|бешбармак)$/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u0411\u0438\u0448\u0431\u0430\u0440\u043C\u0430\u043A");
  if (/^азу$|татарча\s+азу/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u0422\u0430\u0442\u0430\u0440\u0447\u0430 \u0410\u0437\u0443");
  if (/курбан\s*байрам|курб\s+байрам/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u041A\u0443\u0440\u0431\u0430\u043D \u0411\u0430\u0439\u0440\u0430\u043C");
  if (/батыр\s+ризы/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u0411\u0430\u0442\u044B\u0440 \u0440\u0438\u0437\u044B\u0433\u044B");
  if (/хан\s+ризы/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u0425\u0430\u043D \u0440\u0438\u0437\u044B\u0433\u044B");
  if (/татлы\s+ризык/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u0422\u0430\u0442\u043B\u044B \u0440\u0438\u0437\u044B\u0433\u044B");
  if (/милли\s+аш/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u041C\u0438\u043B\u043B\u0438 \u0430\u0448\u044B");
  if (/сююмбике/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u0438\u0437 \u043C\u044F\u0441\u0430", "\u0421\u044E\u044E\u043C\u0431\u0438\u043A\u0435");
  if (/кызыл\s+аш/.test(value)) return direct("\u0421\u0443\u043F\u044B", "\u041A\u044B\u0437\u044B\u043B \u0430\u0448");
  if (/казан\s+аш/.test(value)) return direct("\u0421\u0443\u043F\u044B", "\u041A\u0430\u0437\u0430\u043D \u0430\u0448\u044B");
  if (/токмач/.test(value)) return direct("\u0421\u0443\u043F\u044B", "\u0422\u043E\u043A\u043C\u0430\u0447");
  if (/оч\s*(?:бл|п)\s*шулпа|очпочмак.*шулпа/.test(value)) return direct("\u0421\u0443\u043F\u044B", "\u041E\u0447\u043F\u043E\u0447\u043C\u0430\u043A \u0431\u0435\u043B\u044D\u043D \u0448\u0443\u043B\u043F\u0430");
  if (/^бозбаш$/.test(value)) return direct("\u0421\u0443\u043F\u044B", "\u0411\u043E\u0437\u0431\u0430\u0448");
  if (/^уха$|патша\s+уха/.test(value)) return direct("\u0421\u0443\u043F\u044B", "\u041F\u0430\u0442\u0448\u0430 \u0443\u0445\u0430\u0441\u044B");
  if (/^оч\s+с\s+говядиной|очпочмак\s+с\s+говядин/.test(value)) return direct("\u0412\u044B\u043F\u0435\u0447\u043A\u0430", "\u041E\u0447\u043F\u043E\u0447\u043C\u0430\u043A \u0441 \u0433\u043E\u0432\u044F\u0434\u0438\u043D\u043E\u0439");
  if (/^оч\s+с\s+гусем|очпочмак\s+с\s+гусем/.test(value)) return direct("\u0412\u044B\u043F\u0435\u0447\u043A\u0430", "\u041E\u0447\u043F\u043E\u0447\u043C\u0430\u043A \u0441 \u0433\u0443\u0441\u0435\u043C");
  if (/^оч\s+с\s+уткой|очпочмак\s+с\s+уткой/.test(value)) return direct("\u0412\u044B\u043F\u0435\u0447\u043A\u0430", "\u041E\u0447\u043F\u043E\u0447\u043C\u0430\u043A \u0441 \u0443\u0442\u043A\u043E\u0439");
  if (/^элеш/.test(value)) return direct("\u0412\u044B\u043F\u0435\u0447\u043A\u0430", "\u042D\u043B\u0435\u0448 \u0441 \u043A\u0443\u0440\u0438\u0446\u0435\u0439");
  if (/^перемяч/.test(value)) return direct("\u0412\u044B\u043F\u0435\u0447\u043A\u0430", "\u041F\u0435\u0440\u0435\u043C\u044F\u0447 \u0441 \u0433\u043E\u0432\u044F\u0434\u0438\u043D\u043E\u0439");
  if (/кыстыб/.test(value)) return direct("\u0412\u044B\u043F\u0435\u0447\u043A\u0430", "\u041A\u044B\u0441\u0442\u044B\u0431\u044B\u0439");
  if (/лепеш/.test(value)) return direct("\u0412\u044B\u043F\u0435\u0447\u043A\u0430", "\u041B\u0435\u043F\u0451\u0448\u043A\u0430");
  if (/губад|губал/.test(value)) return direct("\u0414\u0435\u0441\u0435\u0440\u0442\u044B", "\u0413\u0443\u0431\u0430\u0434\u0438\u044F");
  if (/баурс/.test(value)) return direct("\u0414\u0435\u0441\u0435\u0440\u0442\u044B", "\u0411\u0430\u0443\u0440\u0441\u0430\u043A");
  if (/лимонник/.test(value)) return direct("\u0414\u0435\u0441\u0435\u0440\u0442\u044B", "\u041B\u0438\u043C\u043E\u043D\u043D\u0438\u043A \u0441 \u043C\u0435\u0440\u0435\u043D\u0433\u043E\u0439");
  if (/алма\s+бэлеш/.test(value)) return direct("\u0414\u0435\u0441\u0435\u0440\u0442\u044B", "\u0410\u043B\u043C\u0430 \u0431\u044D\u043B\u0435\u0448");
  if (/чак\s*чак/.test(value)) return direct("\u0414\u0435\u0441\u0435\u0440\u0442\u044B", "\u0427\u0430\u043A-\u0447\u0430\u043A");
  if (/талкыш/.test(value)) return direct("\u0414\u0435\u0441\u0435\u0440\u0442\u044B", "\u0422\u0430\u043B\u043A\u044B\u0448 \u043A\u0430\u043B\u0435\u0432\u0435");
  if (/чия\s+бэлеш/.test(value)) return direct("\u0414\u0435\u0441\u0435\u0440\u0442\u044B", "\u0427\u0438\u044F \u0431\u044D\u043B\u0435\u0448");
  if (/итле/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u0418\u0442\u043B\u0435");
  if (/тэмле\s+урд/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u0422\u044D\u043C\u043B\u0435 \u0423\u0440\u0434\u044D\u043A");
  if (/урд.*олив/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u0423\u0440\u0434\u044D\u043A \u041E\u043B\u0438\u0432\u044C\u0435\u0441\u044B");
  if (/^язлы$/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u042F\u0437\u043B\u044B");
  if (/^биляр$/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u0411\u0438\u043B\u044F\u0440");
  if (/^кызыл$/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u041A\u044B\u0437\u044B\u043B");
  if (/татлы.*баклаж/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u0422\u0430\u0442\u043B\u044B \u0431\u0430\u043A\u043B\u0430\u0436\u0430\u043D \u0441\u0430\u043B\u0430\u0442\u044B");
  if (/туган\s+авылым/.test(value)) return direct("\u0421\u0430\u043B\u0430\u0442\u044B", "\u0422\u0443\u0433\u0430\u043D \u0410\u0432\u044B\u043B\u044B\u043C");
  if (/урман\s+бул/.test(value)) return direct("\u0417\u0430\u043A\u0443\u0441\u043A\u0438", "\u0423\u0440\u043C\u0430\u043D \u0431\u04AF\u043B\u04D9\u0433\u0435");
  if (/казлык|каздык|казылык/.test(value)) return direct("\u0417\u0430\u043A\u0443\u0441\u043A\u0438", "\u041A\u0430\u0437\u044B\u043B\u044B\u043A");
  if (/ханское\s+пир/.test(value)) return direct("\u0417\u0430\u043A\u0443\u0441\u043A\u0438", "\u0425\u0430\u043D\u0441\u043A\u043E\u0435 \u043F\u0438\u0440\u0448\u0435\u0441\u0442\u0432\u043E");
  if (/тэмле\s+балык/.test(value)) return direct("\u0420\u044B\u0431\u043D\u044B\u0435 \u0431\u043B\u044E\u0434\u0430", "\u0422\u044D\u043C\u043B\u0435 \u0431\u0430\u043B\u044B\u043A");
  if (/шашл.*кур|люля.*кур/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u043D\u0430 \u0443\u0433\u043B\u044F\u0445", "\u0428\u0430\u0448\u043B\u044B\u043A \u0438\u0437 \u043A\u0443\u0440\u0438\u0446\u044B");
  if (/шашл.*кон/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u043D\u0430 \u0443\u0433\u043B\u044F\u0445", "\u0428\u0430\u0448\u043B\u044B\u043A \u0438\u0437 \u043A\u043E\u043D\u0438\u043D\u044B");
  if (/ассорти/.test(value)) return direct("\u0411\u043B\u044E\u0434\u0430 \u043D\u0430 \u0443\u0433\u043B\u044F\u0445", "\u0410\u0441\u0441\u043E\u0440\u0442\u0438 \u0438\u0437 \u0448\u0430\u0448\u043B\u044B\u043A\u043E\u0432");
  if (/карт.*дерев|деревенск.*карт/.test(value)) return direct("\u0413\u0430\u0440\u043D\u0438\u0440\u044B", "\u041A\u0430\u0440\u0442\u043E\u0444\u0435\u043B\u044C \u043F\u043E-\u0434\u0435\u0440\u0435\u0432\u0435\u043D\u0441\u043A\u0438");
  if (/фри/.test(value)) return direct("\u0413\u0430\u0440\u043D\u0438\u0440\u044B", "\u041A\u0430\u0440\u0442\u043E\u0444\u0435\u043B\u044C \u0444\u0440\u0438");
  if (/сырн/.test(value)) return direct("\u0421\u043E\u0443\u0441\u044B", "\u0421\u044B\u0440\u043D\u044B\u0439 \u0441\u043E\u0443\u0441");
  if (/чесночн/.test(value)) return direct("\u0421\u043E\u0443\u0441\u044B", "\u0427\u0435\u0441\u043D\u043E\u0447\u043D\u044B\u0439 \u0441\u043E\u0443\u0441");
  if (/морс.*смород|смородин/.test(value)) return direct("\u041F\u0440\u043E\u0445\u043B\u0430\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043D\u0430\u043F\u0438\u0442\u043A\u0438", "\u041C\u043E\u0440\u0441 \u0441\u043C\u043E\u0440\u043E\u0434\u0438\u043D\u043E\u0432\u044B\u0439");
  if (/морс.*клюк|клюкв/.test(value)) return direct("\u041F\u0440\u043E\u0445\u043B\u0430\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043D\u0430\u043F\u0438\u0442\u043A\u0438", "\u041C\u043E\u0440\u0441 \u043A\u043B\u044E\u043A\u0432\u0435\u043D\u043D\u044B\u0439");
  if (/^морс$/.test(value)) return direct("\u041F\u0440\u043E\u0445\u043B\u0430\u0434\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043D\u0430\u043F\u0438\u0442\u043A\u0438", "\u041C\u043E\u0440\u0441 \u0441\u043C\u043E\u0440\u043E\u0434\u0438\u043D\u043E\u0432\u044B\u0439");
  if (/рич.*апельс|сок.*рич/.test(value)) return direct("\u041D\u0430\u043F\u0438\u0442\u043A\u0438 Rich", "\u0421\u043E\u043A Rich");
  if (/кола.*(зеро|без\s+сахара)/.test(value)) return direct("\u041D\u0430\u043F\u0438\u0442\u043A\u0438 Rich", "\u041A\u043E\u043B\u0430 \u0431\u0435\u0437 \u0441\u0430\u0445\u0430\u0440\u0430");
  if (/^вода$|без\s+газа/.test(value)) return direct("\u041C\u0438\u043D\u0435\u0440\u0430\u043B\u044C\u043D\u0430\u044F \u0432\u043E\u0434\u0430", "\u0412\u043E\u043B\u0436\u0430\u043D\u043A\u0430 \u0441 \u0433\u0430\u0437\u043E\u043C/\u0431\u0435\u0437 \u0433\u0430\u0437\u0430");
  if (/рислинг/.test(value)) return direct("\u0411\u0435\u043B\u043E\u0435 \u0432\u0438\u043D\u043E", "\u0420\u0438\u0441\u043B\u0438\u043D\u0433 \u0423\u0440\u0431\u0430\u043D\u0438\u0445\u043E\u0444");
  if (/джони.*вокер|johnny\s+walker/.test(value)) return direct("\u0412\u0438\u0441\u043A\u0438", "Johnnie Walker Red Label");
  if (/страк.*пш|psenice/.test(value)) return direct("\u0420\u0430\u0437\u043B\u0438\u0432\u043D\u043E\u0435 \u043F\u0438\u0432\u043E", "Strakovice Psenice / \u0421\u0442\u0440\u0430\u043A\u043E\u0432\u0438\u0446\u0435 \u041F\u0448\u0435\u043D\u0438\u0447\u043D\u043E\u0435");
  if (/страк.*эль|pale\s+ale/.test(value)) return direct("\u0420\u0430\u0437\u043B\u0438\u0432\u043D\u043E\u0435 \u043F\u0438\u0432\u043E", "Strakovice Pale Ale / \u0421\u0442\u0440\u0430\u043A\u043E\u0432\u0438\u0446\u0435 \u0421\u0432\u0435\u0442\u043B\u044B\u0439 \u042D\u043B\u044C");
  if (/страк.*фильтр/.test(value)) return direct("\u0411\u0443\u0442\u044B\u043B\u043E\u0447\u043D\u043E\u0435 \u043F\u0438\u0432\u043E", "\u0411\u0435\u043B\u044B\u0439 \u041A\u0440\u0435\u043C\u043B\u044C \u0441\u0432\u0435\u0442\u043B\u043E\u0435 \u0444\u0438\u043B\u044C\u0442\u0440\u043E\u0432\u0430\u043D\u043D\u043E\u0435");
  if (/мандарин/.test(value)) return direct("\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0438", "\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0430 \u041C\u0430\u043D\u0434\u0430\u0440\u0438\u043D");
  if (/брусник/.test(value)) return direct("\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0438", "\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0430 \u0411\u0440\u0443\u0441\u043D\u0438\u043A\u0430");
  if (/облепихов/.test(value)) return direct("\u0427\u0430\u0439\u043D\u044B\u0435 \u043A\u043E\u043C\u043F\u043E\u0437\u0438\u0446\u0438\u0438", "\u041E\u0431\u043B\u0435\u043F\u0438\u0445\u043E\u0432\u044B\u0439 \u0441\u043E \u0441\u043F\u0435\u0446\u0438\u044F\u043C\u0438");
  if (/малина.*смород|смород.*малина/.test(value)) return direct("\u0427\u0430\u0439\u043D\u044B\u0435 \u043A\u043E\u043C\u043F\u043E\u0437\u0438\u0446\u0438\u0438", "\u041C\u0430\u043B\u0438\u043D\u043E\u0432\u043E-\u0441\u043C\u043E\u0440\u043E\u0434\u0438\u043D\u043E\u0432\u044B\u0439");
  if (/^облепиха$/.test(value)) return direct("\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0438", "\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0430 \u041E\u0431\u043B\u0435\u043F\u0438\u0445\u0430");
  if (/малина.*ревень/.test(value)) return direct("\u041B\u0438\u043C\u043E\u043D\u0430\u0434\u044B", "\u041C\u0430\u043B\u0438\u043D\u0430-\u0440\u0435\u0432\u0435\u043D\u044C");
  if (/мохито/.test(value)) return direct("\u0411\u0435\u0437\u0430\u043B\u043A\u043E\u0433\u043E\u043B\u044C\u043D\u044B\u0435 \u043A\u043E\u043A\u0442\u0435\u0439\u043B\u0438", "\u041C\u043E\u0445\u0438\u0442\u043E \u0431\u0435\u0437\u0430\u043B\u043A\u043E\u0433\u043E\u043B\u044C\u043D\u044B\u0439", (v) => /без\s*алк/.test(v));
  if (/мохито/.test(value)) return direct("\u0410\u043B\u043A\u043E\u0433\u043E\u043B\u044C\u043D\u044B\u0435 \u043A\u043E\u043A\u0442\u0435\u0439\u043B\u0438", "\u041C\u043E\u0445\u0438\u0442\u043E");
  const exact = dishes.find((dish) => normalize(dish.name) === value);
  if (exact) return exact;
  const contained = dishes.map((dish) => ({ dish, score: normalize(dish.name).split(" ").filter((word) => value.includes(word)).length })).filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  return contained[0]?.dish ?? null;
}
__name(aliasMatch, "aliasMatch");
function lineItems(line, dishes) {
  const { quantity, clean, note } = quantityAndText(line);
  const normalized = normalize(clean);
  if (!normalized) return [];
  if (/^(?:настойк|нас\s*ойк).*(все|кажд)/.test(normalized)) {
    return dishes.filter((dish2) => normalize(dish2.category_name) === normalize("\u041D\u0430\u0441\u0442\u043E\u0439\u043A\u0438")).map((dish2) => ({ dish: dish2, quantity: 1, note: note || "\u043A\u0430\u0436\u0434\u043E\u0433\u043E" }));
  }
  const dish = aliasMatch(clean, dishes);
  return dish ? [{ dish, quantity, note }] : [{ raw: clean, quantity, note }];
}
__name(lineItems, "lineItems");
function parseOrder(text, dishes) {
  const items = String(text ?? "").replace(/\r/g, "").split(/\n|\\/u).map((line) => line.replace(/^\s*\[[^\]]+\]\s*[^:]+:\s*/u, "").trim()).filter(Boolean).flatMap((line) => lineItems(line, dishes));
  const groups = /* @__PURE__ */ new Map();
  const unknown = [];
  for (const item of items) {
    if (!item.dish) {
      unknown.push(item);
      continue;
    }
    const key = item.dish.category_name;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return { groups, unknown };
}
__name(parseOrder, "parseOrder");
function formatOrder(result) {
  const lines = ["\u{1F9FE} <b>\u0417\u0430\u043A\u0430\u0437 \u043F\u043E \u0440\u0430\u0437\u0434\u0435\u043B\u0430\u043C</b>", ""];
  const orderedGroups = [...result.groups.entries()].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left[0]);
    const rightIndex = CATEGORY_ORDER.indexOf(right[0]);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex);
  });
  for (const [category, items] of orderedGroups) {
    lines.push(`<b>${escapeHtml(category)}</b>`);
    for (const item of items) {
      const quantity = item.quantity > 1 ? `${item.quantity} \xD7 ` : "";
      const note = item.note ? ` <i>(${escapeHtml(item.note)})</i>` : "";
      lines.push(`\u2022 ${quantity}${escapeHtml(item.dish.name)}${note}`);
    }
    lines.push("");
  }
  if (result.unknown.length) {
    lines.push("\u2753 <b>\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0432 \u0430\u043A\u0442\u0443\u0430\u043B\u044C\u043D\u043E\u043C \u043C\u0435\u043D\u044E</b>");
    for (const item of result.unknown) {
      const quantity = item.quantity > 1 ? `${item.quantity} \xD7 ` : "";
      lines.push(`\u2022 ${quantity}${escapeHtml(item.raw)}${item.note ? ` (${escapeHtml(item.note)})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
__name(formatOrder, "formatOrder");
async function handleOwnerOrderMessage(message, env) {
  if (!message.text?.trim() || message.text.trim().startsWith("/")) return false;
  const result = await env.DB.prepare(`
    SELECT d.name, d.category_id, c.name AS category_name, c.menu_type
    FROM dishes d JOIN categories c ON c.id = d.category_id
    WHERE d.active = 1
    ORDER BY c.sort_order, d.sort_order, d.id
  `).all();
  const parsed = parseOrder(message.text, result.results ?? []);
  if (!parsed.groups.size && !parsed.unknown.length) return false;
  await sendMessage(env, message.chat.id, formatOrder(parsed));
  return true;
}
__name(handleOwnerOrderMessage, "handleOwnerOrderMessage");

// src/bot.js
async function isParticipant(env, chatId) {
  const row = await env.DB.prepare(
    "SELECT active, blocked FROM participants WHERE chat_id = ? LIMIT 1"
  ).bind(chatId).first();
  return row?.active === 1 && row?.blocked !== 1;
}
__name(isParticipant, "isParticipant");
async function participantAccess(env, chatId) {
  return env.DB.prepare(
    "SELECT user_id, username, active, blocked FROM participants WHERE chat_id = ? LIMIT 1"
  ).bind(chatId).first();
}
__name(participantAccess, "participantAccess");
async function registerParticipant(env, message) {
  const actor = message.from ?? {};
  await env.DB.prepare(`
    INSERT INTO participants (chat_id, user_id, display_name, username, active, joined_at, last_seen_at)
    VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      user_id = excluded.user_id,
      display_name = excluded.display_name,
      username = excluded.username,
      active = 1,
      last_seen_at = CURRENT_TIMESTAMP
  `).bind(
    message.chat.id,
    actor.id ?? message.chat.id,
    displayName(actor),
    actor.username ?? null
  ).run();
}
__name(registerParticipant, "registerParticipant");
async function categories(env, menuType) {
  const result = await env.DB.prepare(`
    SELECT c.id, c.name, c.sort_order,
           COALESCE(SUM(CASE WHEN d.availability_status = 'limited' THEN 1 ELSE 0 END), 0) AS limited_count,
           COALESCE(SUM(CASE WHEN d.availability_status = 'expected' THEN 1 ELSE 0 END), 0) AS expected_count,
           COALESCE(SUM(CASE WHEN d.availability_status = 'stopped' THEN 1 ELSE 0 END), 0) AS stopped_count
    FROM categories c
    LEFT JOIN dishes d ON d.category_id = c.id AND d.active = 1
    WHERE c.menu_type = ?
    GROUP BY c.id, c.name, c.sort_order
    HAVING COUNT(d.id) > 0
    ORDER BY c.sort_order, c.id
  `).bind(menuType).all();
  return result.results ?? [];
}
__name(categories, "categories");
async function availabilityCounts(env) {
  const result = await env.DB.prepare(`
    SELECT c.menu_type, COUNT(*) AS affected_count
    FROM dishes d
    JOIN categories c ON c.id = d.category_id
    WHERE d.active = 1 AND d.availability_status <> 'available'
    GROUP BY c.menu_type
  `).all();
  return Object.fromEntries((result.results ?? []).map((row) => [row.menu_type, row.affected_count]));
}
__name(availabilityCounts, "availabilityCounts");
async function showHome(env, chatId, edit = null) {
  const text = [
    "\u{1F37D} <b>\u0421\u0442\u0430\u0442\u0443\u0441\u044B \u043C\u0435\u043D\u044E \u0440\u0435\u0441\u0442\u043E\u0440\u0430\u043D\u0430</b>",
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043A\u0443\u0445\u043D\u044E \u0438\u043B\u0438 \u043A\u0430\u0440\u0442\u0443 \u0431\u0430\u0440\u0430.",
    "\u2705 \u0432 \u043F\u0440\u043E\u0434\u0430\u0436\u0435 \xB7 \u26A0\uFE0F \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435 \xB7 \u{1F552} \u043E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F \xB7 \u{1F6D1} \u0441\u0442\u043E\u043F"
  ].join("\n");
  const access = await participantAccess(env, chatId);
  const [counts, scheduleCount] = await Promise.all([
    availabilityCounts(env),
    openPeriodCount(env)
  ]);
  const owner = isOwner(env, access?.user_id ?? chatId);
  const manager = isScheduleManager(env, {
    id: access?.user_id ?? chatId,
    username: access?.username
  });
  const keyboard = mainMenuKeyboard(
    counts,
    owner,
    scheduleCount,
    manager
  );
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}
__name(showHome, "showHome");
async function showCatalog(env, chatId, menuType, page = 0, edit = null) {
  const text = [`${menuIcon(menuType)} <b>${menuTitle(menuType)}</b>`, "", "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0440\u0430\u0437\u0434\u0435\u043B:"].join("\n");
  const keyboard = catalogKeyboard(await categories(env, menuType), menuType, page);
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}
__name(showCatalog, "showCatalog");
async function currentStatusRows(env) {
  const result = await env.DB.prepare(`
    SELECT d.name, d.availability_status, d.limited_quantity, d.expected_at,
           c.name AS category_name, c.menu_type
    FROM dishes d
    JOIN categories c ON c.id = d.category_id
    WHERE d.active = 1 AND d.availability_status <> 'available'
    ORDER BY CASE c.menu_type WHEN 'kitchen' THEN 0 ELSE 1 END,
             c.sort_order, d.sort_order, d.id
  `).all();
  return result.results ?? [];
}
__name(currentStatusRows, "currentStatusRows");
async function showStatuses(env, chatId, edit = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "\u{1F504} \u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C", callback_data: "stops" }],
      [{ text: "\u25C0\uFE0F \u0412\u0441\u0435 \u0440\u0430\u0437\u0434\u0435\u043B\u044B", callback_data: "home" }]
    ]
  };
  const text = stopListText(await currentStatusRows(env));
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}
__name(showStatuses, "showStatuses");
async function categoryData(env, categoryId) {
  const category = await env.DB.prepare(
    "SELECT id, name, menu_type FROM categories WHERE id = ? LIMIT 1"
  ).bind(categoryId).first();
  if (!category) return null;
  const dishes = await env.DB.prepare(`
    SELECT id, name, price, is_stopped, availability_status, limited_quantity, expected_at
    FROM dishes
    WHERE category_id = ? AND active = 1
    ORDER BY sort_order, id
  `).bind(categoryId).all();
  return { category, dishes: dishes.results ?? [] };
}
__name(categoryData, "categoryData");
async function dishData(env, dishId) {
  return env.DB.prepare(`
    SELECT d.id, d.name, d.category_id, d.is_stopped, d.availability_status,
           d.limited_quantity, d.expected_at,
           c.name AS category_name, c.menu_type
    FROM dishes d
    JOIN categories c ON c.id = d.category_id
    WHERE d.id = ? AND d.active = 1 LIMIT 1
  `).bind(dishId).first();
}
__name(dishData, "dishData");
async function showCategory(env, chatId, message, categoryId, page) {
  const data = await categoryData(env, categoryId);
  if (!data) {
    if (message.callbackId) await answerCallback(env, message.callbackId, "\u0420\u0430\u0437\u0434\u0435\u043B \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D", true);
    return;
  }
  const text = [
    `<b>${escapeHtml(data.category.name)}</b>`,
    "",
    "\u041D\u0430\u0436\u043C\u0438\u0442\u0435 \u043D\u0430 \u043F\u043E\u0437\u0438\u0446\u0438\u044E, \u0447\u0442\u043E\u0431\u044B \u0432\u044B\u0431\u0440\u0430\u0442\u044C \u0435\u0451 \u0441\u0442\u0430\u0442\u0443\u0441.",
    "\u2705 \xB7 \u26A0\uFE0F \xB7 \u{1F552} \xB7 \u{1F6D1}"
  ].join("\n");
  return editMessage(
    env,
    chatId,
    message.messageId,
    text,
    categoryKeyboard(categoryId, data.dishes, page, data.category.menu_type)
  );
}
__name(showCategory, "showCategory");
async function showDishStatus(env, chatId, messageId, dishId, categoryId, page) {
  const dish = await dishData(env, dishId);
  if (!dish) return editMessage(env, chatId, messageId, "\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430.", { inline_keyboard: [] });
  const text = [
    `<b>${escapeHtml(dish.name)}</b>`,
    `\u0420\u0430\u0437\u0434\u0435\u043B: ${escapeHtml(dish.category_name)}`,
    "",
    "\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u0441\u0442\u0430\u0442\u0443\u0441:",
    statusDescription(dish),
    "",
    "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u0441\u0442\u0430\u0442\u0443\u0441:"
  ].join("\n");
  return editMessage(env, chatId, messageId, text, dishStatusKeyboard(dishId, categoryId || dish.category_id, page));
}
__name(showDishStatus, "showDishStatus");
async function searchDishes(env, chatId, query) {
  const result = await env.DB.prepare(`
    SELECT d.id, d.name, d.category_id, d.is_stopped, d.availability_status,
           d.limited_quantity, d.expected_at, c.menu_type
    FROM dishes d
    JOIN categories c ON c.id = d.category_id
    WHERE d.active = 1
    ORDER BY c.sort_order, d.sort_order, d.id
  `).all();
  const normalized = query.toLocaleLowerCase("ru-RU");
  const matches = (result.results ?? []).filter((dish) => dish.name.toLocaleLowerCase("ru-RU").includes(normalized)).slice(0, 12);
  if (!matches.length) return sendMessage(env, chatId, `\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u043F\u043E \u0437\u0430\u043F\u0440\u043E\u0441\u0443 \xAB${escapeHtml(query)}\xBB.`);
  const buttons = matches.map((dish) => [{
    text: `${dish.availability_status === "available" ? "\u2705" : dish.availability_status === "limited" ? "\u26A0\uFE0F" : dish.availability_status === "expected" ? "\u{1F552}" : "\u{1F6D1}"} ${dish.name} \xB7 ${dish.menu_type === "bar" ? "\u0431\u0430\u0440" : "\u043A\u0443\u0445\u043D\u044F"}`,
    callback_data: `dish:${dish.id}:${dish.category_id}:0`
  }]);
  buttons.push([{ text: "\u25C0\uFE0F \u0412\u0441\u0435 \u0440\u0430\u0437\u0434\u0435\u043B\u044B", callback_data: "home" }]);
  return sendMessage(env, chatId, `<b>\u0420\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B \u043F\u043E\u0438\u0441\u043A\u0430:</b> ${escapeHtml(query)}`, {
    reply_markup: { inline_keyboard: buttons }
  });
}
__name(searchDishes, "searchDishes");
async function setInteractionState(env, userId, action, payload) {
  await env.DB.prepare(`
    INSERT INTO interaction_state (user_id, action, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      action = excluded.action, payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
  `).bind(userId, action, JSON.stringify(payload)).run();
}
__name(setInteractionState, "setInteractionState");
async function clearInteractionState(env, userId) {
  await env.DB.prepare("DELETE FROM interaction_state WHERE user_id = ?").bind(userId).run();
}
__name(clearInteractionState, "clearInteractionState");
async function interactionState(env, userId) {
  return env.DB.prepare(
    "SELECT action, payload FROM interaction_state WHERE user_id = ? LIMIT 1"
  ).bind(userId).first();
}
__name(interactionState, "interactionState");
async function broadcastChange(env, ctx, origin, result) {
  if (result.changed && result.notificationId) {
    ctx.waitUntil(deliverNotificationBatch(env, origin, result.notificationId));
  }
}
__name(broadcastChange, "broadcastChange");
async function handleAvailabilityMessage(message, env, ctx, origin) {
  const state = await interactionState(env, message.from?.id);
  if (!state) return false;
  const text = message.text?.trim() ?? "";
  const command = commandName(text);
  if (command === "/cancel") {
    await clearInteractionState(env, message.from.id);
    await showHome(env, message.chat.id);
    return true;
  }
  if (text.startsWith("/")) {
    await clearInteractionState(env, message.from.id);
    return false;
  }
  let payload;
  try {
    payload = JSON.parse(state.payload ?? "{}");
  } catch {
    await clearInteractionState(env, message.from.id);
    return false;
  }
  let status;
  let details;
  if (state.action === "limited_quantity") {
    const quantity = Number(text);
    if (!/^\d{1,3}$/.test(text) || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      await sendMessage(env, message.chat.id, "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u0446\u0435\u043B\u044B\u043C \u0447\u0438\u0441\u043B\u043E\u043C \u043E\u0442 1 \u0434\u043E 999. \u041D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: <b>7</b>.");
      return true;
    }
    status = "limited";
    details = { quantity };
  } else if (state.action === "expected_time") {
    const expectedAt = parseExpectedTime(text);
    if (!expectedAt) {
      await sendMessage(env, message.chat.id, [
        "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u0442\u044C \u0432\u0440\u0435\u043C\u044F.",
        "\u041D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0442\u043E\u0447\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u043F\u043E \u041C\u043E\u0441\u043A\u0432\u0435, \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: <b>18:30</b>.",
        "\u041C\u043E\u0436\u043D\u043E \u0441 \u0434\u0430\u0442\u043E\u0439: <b>19.08 18:30</b>."
      ].join("\n"));
      return true;
    }
    status = "expected";
    details = { expectedAt };
  } else {
    await clearInteractionState(env, message.from.id);
    return false;
  }
  const result = await changeDishAvailability(
    env,
    message.from,
    message.chat.id,
    Number(payload.dishId),
    status,
    details
  );
  await clearInteractionState(env, message.from.id);
  await broadcastChange(env, ctx, origin, result);
  if (payload.messageId && payload.categoryId) {
    await showCategory(env, message.chat.id, { messageId: payload.messageId }, Number(payload.categoryId), Number(payload.page ?? 0));
  }
  return true;
}
__name(handleAvailabilityMessage, "handleAvailabilityMessage");
async function handleMessage(message, env, ctx, origin) {
  if (!isOwner(env, message.from?.id) && !await isStaffBotEnabled(env)) return;
  if (message.chat?.type !== "private") {
    const username = escapeHtml(env.BOT_USERNAME || "your_bot_username");
    return sendMessage(env, message.chat.id, `\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0431\u043E\u0442\u0430 \u0432 \u043B\u0438\u0447\u043D\u043E\u043C \u0447\u0430\u0442\u0435: @${username}`);
  }
  const text = message.text?.trim() ?? "";
  const command = commandName(text);
  const access = await participantAccess(env, message.chat.id);
  const alreadyRegistered = access?.active === 1 && access?.blocked !== 1;
  if (command === "/start") {
    if (access?.blocked === 1) {
      return sendMessage(env, message.chat.id, "\u{1F512} \u0412\u0430\u0448 \u0434\u043E\u0441\u0442\u0443\u043F \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0435\u043C. \u041E\u0431\u0440\u0430\u0442\u0438\u0442\u0435\u0441\u044C \u043A \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443.");
    }
    const suppliedCode = startParameter(text);
    const accessAllowed = alreadyRegistered || !env.STAFF_CODE || suppliedCode === env.STAFF_CODE;
    if (!accessAllowed) {
      return sendMessage(env, message.chat.id, "\u{1F512} \u0414\u043B\u044F \u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u0438 \u043D\u0443\u0436\u043D\u0430 \u0440\u0430\u0431\u043E\u0447\u0430\u044F \u0441\u0441\u044B\u043B\u043A\u0430 \u0441 \u043A\u043E\u0434\u043E\u043C \u0434\u043E\u0441\u0442\u0443\u043F\u0430. \u041F\u043E\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u0435\u0451 \u0443 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0430.");
    }
    await registerParticipant(env, message);
    await sendMessage(env, message.chat.id, `\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435, <b>${escapeHtml(displayName(message.from))}</b>! \u0412\u044B \u0431\u0443\u0434\u0435\u0442\u0435 \u043F\u043E\u043B\u0443\u0447\u0430\u0442\u044C \u0432\u0441\u0435 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0441\u0442\u0430\u0442\u0443\u0441\u043E\u0432 \u043C\u0435\u043D\u044E.`);
    return showHome(env, message.chat.id);
  }
  if (!alreadyRegistered) return sendMessage(env, message.chat.id, "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u0443\u0439\u0442\u0435\u0441\u044C \u043A\u043E\u043C\u0430\u043D\u0434\u043E\u0439 /start.");
  await env.DB.prepare("UPDATE participants SET last_seen_at = CURRENT_TIMESTAMP WHERE chat_id = ?").bind(message.chat.id).run();
  if (command === "/admin") {
    await clearInteractionState(env, message.from.id);
    if (!isOwner(env, message.from?.id)) return sendMessage(env, message.chat.id, "\u042D\u0442\u0430 \u043A\u043E\u043C\u0430\u043D\u0434\u0430 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443.");
    return showOwnerHome(env, message.chat.id);
  }
  if (await cancelOwnerAction(message, env)) return;
  if (await handleOwnerMessage(message, env, ctx, origin)) return;
  if (await handlePublicAnnouncementMessage(message, env)) return;
  if (await handleAvailabilityMessage(message, env, ctx, origin)) return;
  if (["/menu", "/stoplist", "/stop", "/stops"].includes(command)) {
    return command === "/menu" ? showHome(env, message.chat.id) : showStatuses(env, message.chat.id);
  }
  if (command === "/schedule") {
    return showScheduleHub(env, message.chat.id);
  }
  if (command === "/announce") return beginPublicAnnouncement(env, message.chat.id, message.from.id);
  if (command === "/help") {
    const lines = [
      "<b>\u041A\u0430\u043A \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C\u0441\u044F \u0431\u043E\u0442\u043E\u043C</b>",
      "",
      "\u2022 /menu \u2014 \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u043A\u0443\u0445\u043D\u044E \u0438 \u043A\u0430\u0440\u0442\u0443 \u0431\u0430\u0440\u0430",
      "\u2022 /stop \u2014 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u044F, \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0438 \u0441\u0442\u043E\u043F\u044B",
      "\u2022 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0431\u043B\u044E\u0434\u0430 \u0438\u043B\u0438 \u043D\u0430\u043F\u0438\u0442\u043A\u0430 \u2014 \u043D\u0430\u0439\u0442\u0438 \u0435\u0433\u043E",
      "\u2022 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u043F\u043E\u0437\u0438\u0446\u0438\u044E \u0438 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0443\u0436\u043D\u044B\u0439 \u0441\u0442\u0430\u0442\u0443\u0441",
      "\u2022 \u0434\u043B\u044F \xAB\u041E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F\xBB \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u0442\u043E\u0447\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u043F\u043E \u041C\u043E\u0441\u043A\u0432\u0435",
      "\u2022 /schedule \u2014 \u0442\u0435\u043A\u0443\u0449\u0438\u0435 \u0441\u043C\u0435\u043D\u044B \u0438 \u0437\u0430\u043F\u0438\u0441\u044C \u043D\u0430 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0443\u044E \u043D\u0435\u0434\u0435\u043B\u044E",
      "\u2022 /announce \u2014 \u043E\u0431\u044A\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u0434\u043B\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u044B"
    ];
    if (isOwner(env, message.from?.id)) {
      lines.push("\u2022 /admin \u2014 \u043E\u0442\u043A\u0440\u044B\u0442\u044C \u043A\u0430\u0431\u0438\u043D\u0435\u0442 \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0430");
      lines.push("\u2022 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0441\u043F\u0438\u0441\u043E\u043A \u0437\u0430\u043A\u0430\u0437\u0430 \u2014 \u0431\u043E\u0442 \u0440\u0430\u0437\u043B\u043E\u0436\u0438\u0442 \u0435\u0433\u043E \u043F\u043E \u0440\u0430\u0437\u0434\u0435\u043B\u0430\u043C \u043C\u0435\u043D\u044E");
    }
    return sendMessage(env, message.chat.id, lines.join("\n"));
  }
  if (text.startsWith("/")) return sendMessage(env, message.chat.id, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430. \u041D\u0430\u0436\u043C\u0438\u0442\u0435 /help.");
  if (isOwner(env, message.from?.id) && await handleOwnerOrderMessage(message, env)) return;
  if (text.length >= 2) return searchDishes(env, message.chat.id, text);
  return showHome(env, message.chat.id);
}
__name(handleMessage, "handleMessage");
async function applyCallbackStatus(callback, env, ctx, origin, dishId, status, details, categoryId, page) {
  const result = await changeDishAvailability(env, callback.from, callback.message.chat.id, dishId, status, details);
  if (!result.dish) return answerCallback(env, callback.id, "\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430", true);
  if (!result.changed) {
    await answerCallback(env, callback.id, "\u0422\u0430\u043A\u043E\u0439 \u0441\u0442\u0430\u0442\u0443\u0441 \u0443\u0436\u0435 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D");
  } else {
    const messages = {
      available: "\u0412\u043E\u0437\u0432\u0440\u0430\u0449\u0435\u043D\u043E \u0432 \u043F\u0440\u043E\u0434\u0430\u0436\u0443",
      limited: `\u041E\u0433\u0440\u0430\u043D\u0438\u0447\u0435\u043D\u0438\u0435: ${details.quantity} \u0448\u0442.`,
      stopped: "\u041F\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D\u043E \u043D\u0430 \u0441\u0442\u043E\u043F"
    };
    await answerCallback(env, callback.id, messages[status] ?? "\u0421\u0442\u0430\u0442\u0443\u0441 \u0438\u0437\u043C\u0435\u043D\u0451\u043D");
    await broadcastChange(env, ctx, origin, result);
  }
  return showCategory(env, callback.message.chat.id, { messageId: callback.message.message_id }, categoryId || result.dish.category_id, page);
}
__name(applyCallbackStatus, "applyCallbackStatus");
async function handleCallback(callback, env, ctx, origin) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !messageId) return answerCallback(env, callback.id);
  if (callback.message.chat.type !== "private" || String(chatId) !== String(callback.from?.id)) {
    return answerCallback(env, callback.id, "\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u0431\u043E\u0442\u0430 \u0432 \u043B\u0438\u0447\u043D\u043E\u043C \u0447\u0430\u0442\u0435", true);
  }
  if (!isOwner(env, callback.from?.id) && !await isStaffBotEnabled(env)) {
    return answerCallback(env, callback.id);
  }
  if (!await isParticipant(env, chatId)) {
    await answerCallback(env, callback.id, "\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u0440\u0435\u0433\u0438\u0441\u0442\u0440\u0438\u0440\u0443\u0439\u0442\u0435\u0441\u044C \u0447\u0435\u0440\u0435\u0437 /start", true);
    return;
  }
  const data = callback.data ?? "";
  if (data === "noop") return answerCallback(env, callback.id);
  if (data.startsWith("announce:")) {
    const result = await handlePublicAnnouncementCallback(callback, env, origin);
    if (result) return result;
  }
  if (data.startsWith("sched:")) {
    return handleScheduleCallback(callback, env, ctx, origin);
  }
  if (data.startsWith("owner:")) {
    if (!isOwner(env, callback.from?.id)) return answerCallback(env, callback.id, "\u0414\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u043B\u0430\u0434\u0435\u043B\u044C\u0446\u0443", true);
    return handleOwnerCallback(callback, env, ctx, origin);
  }
  if (data === "home") {
    await answerCallback(env, callback.id);
    return showHome(env, chatId, { messageId });
  }
  if (data === "stops") {
    await answerCallback(env, callback.id);
    return showStatuses(env, chatId, { messageId });
  }
  const catalogMatch = /^catalog:(kitchen|bar):(\d+)$/.exec(data);
  if (catalogMatch) {
    await answerCallback(env, callback.id);
    return showCatalog(env, chatId, catalogMatch[1], Number(catalogMatch[2]), { messageId });
  }
  const categoryMatch = /^cat:(\d+):(\d+)$/.exec(data);
  if (categoryMatch) {
    await answerCallback(env, callback.id);
    return showCategory(env, chatId, { messageId, callbackId: callback.id }, Number(categoryMatch[1]), Number(categoryMatch[2]));
  }
  const dishMatch = /^dish:(\d+):(\d+):(\d+)$/.exec(data);
  if (dishMatch) {
    await answerCallback(env, callback.id);
    return showDishStatus(env, chatId, messageId, Number(dishMatch[1]), Number(dishMatch[2]), Number(dishMatch[3]));
  }
  const statusMatch = /^setstatus:(\d+):(available|stopped):(\d+):(\d+)$/.exec(data);
  if (statusMatch) {
    return applyCallbackStatus(callback, env, ctx, origin, Number(statusMatch[1]), statusMatch[2], {}, Number(statusMatch[3]), Number(statusMatch[4]));
  }
  const legacyStatusMatch = /^set:(\d+):([01]):(\d+):(\d+)$/.exec(data);
  if (legacyStatusMatch) {
    return applyCallbackStatus(
      callback,
      env,
      ctx,
      origin,
      Number(legacyStatusMatch[1]),
      legacyStatusMatch[2] === "1" ? "stopped" : "available",
      {},
      Number(legacyStatusMatch[3]),
      Number(legacyStatusMatch[4])
    );
  }
  const limitMenuMatch = /^limitmenu:(\d+):(\d+):(\d+)$/.exec(data);
  if (limitMenuMatch) {
    const dish = await dishData(env, Number(limitMenuMatch[1]));
    if (!dish) return answerCallback(env, callback.id, "\u041F\u043E\u0437\u0438\u0446\u0438\u044F \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430", true);
    await answerCallback(env, callback.id);
    return editMessage(env, chatId, messageId, [
      `\u26A0\uFE0F <b>${escapeHtml(dish.name)}</b>`,
      "",
      "\u0421\u043A\u043E\u043B\u044C\u043A\u043E \u043F\u043E\u0440\u0446\u0438\u0439 \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C?"
    ].join("\n"), limitedQuantityKeyboard(dish.id, Number(limitMenuMatch[2]), Number(limitMenuMatch[3])));
  }
  const limitSetMatch = /^limitset:(\d+):([1-5]):(\d+):(\d+)$/.exec(data);
  if (limitSetMatch) {
    return applyCallbackStatus(callback, env, ctx, origin, Number(limitSetMatch[1]), "limited", { quantity: Number(limitSetMatch[2]) }, Number(limitSetMatch[3]), Number(limitSetMatch[4]));
  }
  const customLimitMatch = /^limitcustom:(\d+):(\d+):(\d+)$/.exec(data);
  if (customLimitMatch) {
    await setInteractionState(env, callback.from.id, "limited_quantity", {
      dishId: Number(customLimitMatch[1]),
      categoryId: Number(customLimitMatch[2]),
      page: Number(customLimitMatch[3]),
      messageId
    });
    await answerCallback(env, callback.id);
    return editMessage(env, chatId, messageId, [
      "\u26A0\uFE0F <b>\u0414\u0440\u0443\u0433\u043E\u0435 \u043A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E</b>",
      "",
      "\u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u043C \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435\u043C, \u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043F\u043E\u0440\u0446\u0438\u0439 \u043E\u0441\u0442\u0430\u043B\u043E\u0441\u044C.",
      "\u041D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: <b>7</b>",
      "",
      "\u0414\u043B\u044F \u043E\u0442\u043C\u0435\u043D\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /cancel."
    ].join("\n"), { inline_keyboard: [[{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `statecancel:${customLimitMatch[2]}:${customLimitMatch[3]}` }]] });
  }
  const expectedMatch = /^expectedprompt:(\d+):(\d+):(\d+)$/.exec(data);
  if (expectedMatch) {
    await setInteractionState(env, callback.from.id, "expected_time", {
      dishId: Number(expectedMatch[1]),
      categoryId: Number(expectedMatch[2]),
      page: Number(expectedMatch[3]),
      messageId
    });
    await answerCallback(env, callback.id);
    return editMessage(env, chatId, messageId, [
      "\u{1F552} <b>\u041A\u043E\u0433\u0434\u0430 \u043F\u043E\u0437\u0438\u0446\u0438\u044F \u0431\u0443\u0434\u0435\u0442 \u0433\u043E\u0442\u043E\u0432\u0430?</b>",
      "",
      "\u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0442\u043E\u0447\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u043F\u043E \u041C\u043E\u0441\u043A\u0432\u0435, \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440: <b>18:30</b>.",
      "\u0415\u0441\u043B\u0438 \u044D\u0442\u043E \u0432\u0440\u0435\u043C\u044F \u0441\u0435\u0433\u043E\u0434\u043D\u044F \u0443\u0436\u0435 \u043F\u0440\u043E\u0448\u043B\u043E, \u0431\u043E\u0442 \u0432\u044B\u0431\u0435\u0440\u0435\u0442 \u0437\u0430\u0432\u0442\u0440\u0430.",
      "\u041C\u043E\u0436\u043D\u043E \u0443\u043A\u0430\u0437\u0430\u0442\u044C \u0434\u0430\u0442\u0443: <b>19.08 18:30</b>.",
      "",
      "\u0412 \u0443\u043A\u0430\u0437\u0430\u043D\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F \u0441\u0442\u0430\u0442\u0443\u0441 \u0441\u043D\u0438\u043C\u0435\u0442\u0441\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438.",
      "\u0414\u043B\u044F \u043E\u0442\u043C\u0435\u043D\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /cancel."
    ].join("\n"), { inline_keyboard: [[{ text: "\u041E\u0442\u043C\u0435\u043D\u0430", callback_data: `statecancel:${expectedMatch[2]}:${expectedMatch[3]}` }]] });
  }
  const cancelMatch = /^statecancel:(\d+):(\d+)$/.exec(data);
  if (cancelMatch) {
    await clearInteractionState(env, callback.from.id);
    await answerCallback(env, callback.id, "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E");
    return showCategory(env, chatId, { messageId }, Number(cancelMatch[1]), Number(cancelMatch[2]));
  }
  return answerCallback(env, callback.id, "\u041A\u043D\u043E\u043F\u043A\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430. \u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 /menu.", true);
}
__name(handleCallback, "handleCallback");
async function handleTelegramUpdate(update, env, ctx, origin) {
  if (update.message) return handleMessage(update.message, env, ctx, origin);
  if (update.callback_query) return handleCallback(update.callback_query, env, ctx, origin);
}
__name(handleTelegramUpdate, "handleTelegramUpdate");

// src/index.js
function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" }
  });
}
__name(json, "json");
function sameSecret(actual, expected) {
  return Boolean(actual && expected && actual === expected);
}
__name(sameSecret, "sameSecret");
async function claimUpdate(env, updateId, token) {
  const result = await env.DB.prepare(`INSERT INTO processed_updates
    (update_id, processed_at, state, lease_token, lease_until)
    VALUES (?, CURRENT_TIMESTAMP, 'processing', ?, datetime('now', '+10 minutes'))
    ON CONFLICT(update_id) DO UPDATE SET lease_token = excluded.lease_token,
      lease_until = excluded.lease_until, processed_at = CURRENT_TIMESTAMP
    WHERE processed_updates.state = 'processing' AND processed_updates.lease_until <= CURRENT_TIMESTAMP`).bind(updateId, token).run();
  if (result.meta?.changes === 1) return "claimed";
  const row = await env.DB.prepare("SELECT state FROM processed_updates WHERE update_id = ?").bind(updateId).first();
  return row?.state === "done" ? "done" : "busy";
}
__name(claimUpdate, "claimUpdate");
async function maintenance(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM schedule_actions WHERE expires_at <= CURRENT_TIMESTAMP"),
    env.DB.prepare(`DELETE FROM processed_updates WHERE state = 'done' AND processed_at < datetime('now', '-30 days')`)
  ]);
}
__name(maintenance, "maintenance");
var index_default = {
  async scheduled(controller, env, ctx) {
    const scheduledAt = new Date(controller?.scheduledTime ?? Date.now());
    ctx.waitUntil(Promise.allSettled([
      processExpectedStatuses(env, env.PUBLIC_URL),
      processScheduleAutomation(env, env.PUBLIC_URL, scheduledAt),
      retryPendingNotifications(env, env.PUBLIC_URL),
      ...scheduledAt.getUTCMinutes() === 0 ? [maintenance(env)] : []
    ]).then((results) => {
      for (const result of results) if (result.status === "rejected") {
        console.error("Scheduled task failed", { name: result.reason?.name });
      }
    }));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, service: "restaurant-stoplist-bot" });
    }
    const broadcastMatch = /^\/internal\/broadcast\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && broadcastMatch) {
      if (!sameSecret(request.headers.get("x-internal-secret"), env.INTERNAL_SECRET)) {
        return json({ ok: false }, 403);
      }
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return json({ ok: false, error: "invalid_cursor" }, 400);
      await deliverNotificationBatch(env, url.origin, Number(broadcastMatch[1]), after);
      return json({ ok: true });
    }
    const deleteAnnouncementMatch = /^\/internal\/delete-announcement\/(\d+)$/.exec(url.pathname);
    if (request.method === "GET" && deleteAnnouncementMatch) {
      if (!sameSecret(request.headers.get("x-internal-secret"), env.INTERNAL_SECRET)) {
        return json({ ok: false }, 403);
      }
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) return json({ ok: false, error: "invalid_cursor" }, 400);
      await deleteAnnouncementBatch(env, url.origin, Number(deleteAnnouncementMatch[1]), after);
      return json({ ok: true });
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return json({ ok: false, error: "not_found" }, 404);
    }
    if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET)) {
      return json({ ok: false, error: "forbidden" }, 403);
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400);
    }
    if (!update || typeof update !== "object" || Array.isArray(update) || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      return json({ ok: false, error: "invalid_update" }, 400);
    }
    const token = crypto.randomUUID();
    let claimed = false;
    try {
      const state = await claimUpdate(env, update.update_id, token);
      if (state === "done") return json({ ok: true, duplicate: true });
      if (state === "busy") return json({ ok: false, error: "update_in_progress" }, 503);
      claimed = true;
      await handleTelegramUpdate(update, { ...env, UPDATE_ID: update.update_id }, ctx, url.origin);
      await env.DB.prepare(`UPDATE processed_updates SET state = 'done', lease_token = NULL, lease_until = NULL
        WHERE update_id = ? AND lease_token = ?`).bind(update.update_id, token).run();
      return json({ ok: true });
    } catch (error) {
      console.error("Update failed", {
        updateId: update.update_id,
        name: error?.name
      });
      if (claimed) {
        try {
          await env.DB.prepare("DELETE FROM processed_updates WHERE update_id = ? AND lease_token = ?").bind(update.update_id, token).run();
        } catch {
          console.error("Update lease release failed", { updateId: update.update_id });
        }
      }
      return json({ ok: false, error: "temporary_failure" }, 500);
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
