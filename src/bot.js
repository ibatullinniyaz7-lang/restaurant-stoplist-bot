import { answerCallback, editMessage, sendMessage } from "./telegram.js";
import { deliverNotificationBatch } from "./broadcast.js";
import { changeDishAvailability, parseExpectedTime } from "./availability.js";
import {
  cancelOwnerAction,
  handleOwnerCallback,
  handleOwnerMessage,
  isOwner,
  showOwnerHome,
} from "./owner.js";
import {
  beginPublicAnnouncement,
  handlePublicAnnouncementCallback,
  handlePublicAnnouncementMessage,
} from "./publicAnnouncement.js";
import {
  handleScheduleCallback,
  isScheduleManager,
  openPeriodCount,
  showScheduleHub,
  showScheduleManager,
} from "./schedule.js";
import { handleOwnerOrderMessage } from "./orderParser.js";
import { isStaffBotEnabled } from "./settings.js";
import {
  catalogKeyboard,
  categoryKeyboard,
  commandName,
  dishStatusKeyboard,
  displayName,
  escapeHtml,
  limitedQuantityKeyboard,
  mainMenuKeyboard,
  menuIcon,
  menuTitle,
  moscowTime,
  sqlDate,
  startParameter,
  statusDescription,
  stopListText,
} from "./ui.js";

async function isParticipant(env, chatId) {
  const row = await env.DB.prepare(
    "SELECT active, blocked FROM participants WHERE chat_id = ? LIMIT 1",
  ).bind(chatId).first();
  return row?.active === 1 && row?.blocked !== 1;
}

async function participantAccess(env, chatId) {
  return env.DB.prepare(
    "SELECT user_id, username, active, blocked FROM participants WHERE chat_id = ? LIMIT 1",
  ).bind(chatId).first();
}

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
    actor.username ?? null,
  ).run();
}

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

async function showHome(env, chatId, edit = null) {
  const text = [
    "🍽 <b>Статусы меню ресторана</b>",
    "",
    "Выберите кухню или карту бара.",
    "✅ в продаже · ⚠️ ограничение · 🕒 ожидается · 🛑 стоп",
  ].join("\n");
  const access = await participantAccess(env, chatId);
  const [counts, scheduleCount] = await Promise.all([
    availabilityCounts(env),
    openPeriodCount(env),
  ]);
  const owner = isOwner(env, access?.user_id ?? chatId);
  const manager = isScheduleManager(env, {
    id: access?.user_id ?? chatId,
    username: access?.username,
  });
  const keyboard = mainMenuKeyboard(
    counts,
    owner,
    scheduleCount,
    manager,
  );
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}

async function showCatalog(env, chatId, menuType, page = 0, edit = null) {
  const text = [`${menuIcon(menuType)} <b>${menuTitle(menuType)}</b>`, "", "Выберите раздел:"].join("\n");
  const keyboard = catalogKeyboard(await categories(env, menuType), menuType, page);
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}

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

async function showStatuses(env, chatId, edit = null) {
  const keyboard = {
    inline_keyboard: [
      [{ text: "🔄 Обновить", callback_data: "stops" }],
      [{ text: "◀️ Все разделы", callback_data: "home" }],
    ],
  };
  const text = stopListText(await currentStatusRows(env));
  if (edit) return editMessage(env, chatId, edit.messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}

async function categoryData(env, categoryId) {
  const category = await env.DB.prepare(
    "SELECT id, name, menu_type FROM categories WHERE id = ? LIMIT 1",
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

async function showCategory(env, chatId, message, categoryId, page) {
  const data = await categoryData(env, categoryId);
  if (!data) {
    if (message.callbackId) await answerCallback(env, message.callbackId, "Раздел не найден", true);
    return;
  }
  const text = [
    `<b>${escapeHtml(data.category.name)}</b>`,
    "",
    "Нажмите на позицию, чтобы выбрать её статус.",
    "✅ · ⚠️ · 🕒 · 🛑",
  ].join("\n");
  return editMessage(
    env,
    chatId,
    message.messageId,
    text,
    categoryKeyboard(categoryId, data.dishes, page, data.category.menu_type),
  );
}

async function showDishStatus(env, chatId, messageId, dishId, categoryId, page) {
  const dish = await dishData(env, dishId);
  if (!dish) return editMessage(env, chatId, messageId, "Позиция не найдена.", { inline_keyboard: [] });
  const text = [
    `<b>${escapeHtml(dish.name)}</b>`,
    `Раздел: ${escapeHtml(dish.category_name)}`,
    "",
    "Текущий статус:",
    statusDescription(dish),
    "",
    "Выберите новый статус:",
  ].join("\n");
  return editMessage(env, chatId, messageId, text, dishStatusKeyboard(dishId, categoryId || dish.category_id, page));
}

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
  const matches = (result.results ?? [])
    .filter((dish) => dish.name.toLocaleLowerCase("ru-RU").includes(normalized))
    .slice(0, 12);
  if (!matches.length) return sendMessage(env, chatId, `Ничего не найдено по запросу «${escapeHtml(query)}».`);

  const buttons = matches.map((dish) => [{
    text: `${dish.availability_status === "available" ? "✅" : dish.availability_status === "limited" ? "⚠️" : dish.availability_status === "expected" ? "🕒" : "🛑"} ${dish.name} · ${dish.menu_type === "bar" ? "бар" : "кухня"}`,
    callback_data: `dish:${dish.id}:${dish.category_id}:0`,
  }]);
  buttons.push([{ text: "◀️ Все разделы", callback_data: "home" }]);
  return sendMessage(env, chatId, `<b>Результаты поиска:</b> ${escapeHtml(query)}`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function setInteractionState(env, userId, action, payload) {
  await env.DB.prepare(`
    INSERT INTO interaction_state (user_id, action, payload, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      action = excluded.action, payload = excluded.payload, updated_at = CURRENT_TIMESTAMP
  `).bind(userId, action, JSON.stringify(payload)).run();
}

async function clearInteractionState(env, userId) {
  await env.DB.prepare("DELETE FROM interaction_state WHERE user_id = ?").bind(userId).run();
}

async function interactionState(env, userId) {
  return env.DB.prepare(
    "SELECT action, payload FROM interaction_state WHERE user_id = ? LIMIT 1",
  ).bind(userId).first();
}

async function broadcastChange(env, ctx, origin, result) {
  if (result.changed && result.notificationId) {
    ctx.waitUntil(deliverNotificationBatch(env, origin, result.notificationId));
  }
}

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
      await sendMessage(env, message.chat.id, "Укажите количество целым числом от 1 до 999. Например: <b>7</b>.");
      return true;
    }
    status = "limited";
    details = { quantity };
  } else if (state.action === "expected_time") {
    const expectedAt = parseExpectedTime(text);
    if (!expectedAt) {
      await sendMessage(env, message.chat.id, [
        "Не получилось распознать время.",
        "Напишите точное время по Москве, например: <b>18:30</b>.",
        "Можно с датой: <b>19.08 18:30</b>.",
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
    details,
  );
  await clearInteractionState(env, message.from.id);
  await broadcastChange(env, ctx, origin, result);
  if (payload.messageId && payload.categoryId) {
    await showCategory(env, message.chat.id, { messageId: payload.messageId }, Number(payload.categoryId), Number(payload.page ?? 0));
  }
  return true;
}

async function handleMessage(message, env, ctx, origin) {
  if (!isOwner(env, message.from?.id) && !(await isStaffBotEnabled(env))) return;

  if (message.chat?.type !== "private") {
    const username = escapeHtml(env.BOT_USERNAME || "your_bot_username");
    return sendMessage(env, message.chat.id, `Откройте бота в личном чате: @${username}`);
  }

  const text = message.text?.trim() ?? "";
  const command = commandName(text);
  const access = await participantAccess(env, message.chat.id);
  const alreadyRegistered = access?.active === 1 && access?.blocked !== 1;

  if (command === "/start") {
    if (access?.blocked === 1) {
      return sendMessage(env, message.chat.id, "🔒 Ваш доступ заблокирован владельцем. Обратитесь к администратору.");
    }
    const suppliedCode = startParameter(text);
    const accessAllowed = alreadyRegistered || !env.STAFF_CODE || suppliedCode === env.STAFF_CODE;
    if (!accessAllowed) {
      return sendMessage(env, message.chat.id, "🔒 Для регистрации нужна рабочая ссылка с кодом доступа. Попросите её у администратора.");
    }
    await registerParticipant(env, message);
    await sendMessage(env, message.chat.id, `Здравствуйте, <b>${escapeHtml(displayName(message.from))}</b>! Вы будете получать все изменения статусов меню.`);
    return showHome(env, message.chat.id);
  }

  if (!alreadyRegistered) return sendMessage(env, message.chat.id, "Сначала зарегистрируйтесь командой /start.");
  await env.DB.prepare("UPDATE participants SET last_seen_at = CURRENT_TIMESTAMP WHERE chat_id = ?")
    .bind(message.chat.id).run();

  if (command === "/admin") {
    await clearInteractionState(env, message.from.id);
    if (!isOwner(env, message.from?.id)) return sendMessage(env, message.chat.id, "Эта команда доступна только владельцу.");
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
      "<b>Как пользоваться ботом</b>", "",
      "• /menu — открыть кухню и карту бара",
      "• /stop — показать ограничения, ожидание и стопы",
      "• отправьте название блюда или напитка — найти его",
      "• нажмите позицию и выберите нужный статус",
      "• для «Ожидается» укажите точное время по Москве",
      "• /schedule — текущие смены и запись на следующую неделю",
      "• /announce — объявление для команды",
    ];
    if (isOwner(env, message.from?.id)) {
      lines.push("• /admin — открыть кабинет владельца");
      lines.push("• отправьте список заказа — бот разложит его по разделам меню");
    }
    return sendMessage(env, message.chat.id, lines.join("\n"));
  }
  if (text.startsWith("/")) return sendMessage(env, message.chat.id, "Неизвестная команда. Нажмите /help.");
  if (isOwner(env, message.from?.id) && await handleOwnerOrderMessage(message, env)) return;
  if (text.length >= 2) return searchDishes(env, message.chat.id, text);
  return showHome(env, message.chat.id);
}

async function applyCallbackStatus(callback, env, ctx, origin, dishId, status, details, categoryId, page) {
  const result = await changeDishAvailability(env, callback.from, callback.message.chat.id, dishId, status, details);
  if (!result.dish) return answerCallback(env, callback.id, "Позиция не найдена", true);
  if (!result.changed) {
    await answerCallback(env, callback.id, "Такой статус уже установлен");
  } else {
    const messages = {
      available: "Возвращено в продажу",
      limited: `Ограничение: ${details.quantity} шт.`,
      stopped: "Поставлено на стоп",
    };
    await answerCallback(env, callback.id, messages[status] ?? "Статус изменён");
    await broadcastChange(env, ctx, origin, result);
  }
  return showCategory(env, callback.message.chat.id, { messageId: callback.message.message_id }, categoryId || result.dish.category_id, page);
}

async function handleCallback(callback, env, ctx, origin) {
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !messageId) return answerCallback(env, callback.id);
  if (!isOwner(env, callback.from?.id) && !(await isStaffBotEnabled(env))) {
    return answerCallback(env, callback.id);
  }
  if (!(await isParticipant(env, chatId))) {
    await answerCallback(env, callback.id, "Сначала зарегистрируйтесь через /start", true);
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
    if (!isOwner(env, callback.from?.id)) return answerCallback(env, callback.id, "Доступно только владельцу", true);
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
      Number(legacyStatusMatch[4]),
    );
  }
  const limitMenuMatch = /^limitmenu:(\d+):(\d+):(\d+)$/.exec(data);
  if (limitMenuMatch) {
    const dish = await dishData(env, Number(limitMenuMatch[1]));
    if (!dish) return answerCallback(env, callback.id, "Позиция не найдена", true);
    await answerCallback(env, callback.id);
    return editMessage(env, chatId, messageId, [
      `⚠️ <b>${escapeHtml(dish.name)}</b>`, "", "Сколько порций осталось?",
    ].join("\n"), limitedQuantityKeyboard(dish.id, Number(limitMenuMatch[2]), Number(limitMenuMatch[3])));
  }
  const limitSetMatch = /^limitset:(\d+):([1-5]):(\d+):(\d+)$/.exec(data);
  if (limitSetMatch) {
    return applyCallbackStatus(callback, env, ctx, origin, Number(limitSetMatch[1]), "limited", { quantity: Number(limitSetMatch[2]) }, Number(limitSetMatch[3]), Number(limitSetMatch[4]));
  }
  const customLimitMatch = /^limitcustom:(\d+):(\d+):(\d+)$/.exec(data);
  if (customLimitMatch) {
    await setInteractionState(env, callback.from.id, "limited_quantity", {
      dishId: Number(customLimitMatch[1]), categoryId: Number(customLimitMatch[2]),
      page: Number(customLimitMatch[3]), messageId,
    });
    await answerCallback(env, callback.id);
    return editMessage(env, chatId, messageId, [
      "⚠️ <b>Другое количество</b>", "", "Отправьте следующим сообщением, сколько порций осталось.",
      "Например: <b>7</b>", "", "Для отмены отправьте /cancel.",
    ].join("\n"), { inline_keyboard: [[{ text: "Отмена", callback_data: `statecancel:${customLimitMatch[2]}:${customLimitMatch[3]}` }]] });
  }
  const expectedMatch = /^expectedprompt:(\d+):(\d+):(\d+)$/.exec(data);
  if (expectedMatch) {
    await setInteractionState(env, callback.from.id, "expected_time", {
      dishId: Number(expectedMatch[1]), categoryId: Number(expectedMatch[2]),
      page: Number(expectedMatch[3]), messageId,
    });
    await answerCallback(env, callback.id);
    return editMessage(env, chatId, messageId, [
      "🕒 <b>Когда позиция будет готова?</b>", "",
      "Отправьте точное время по Москве, например: <b>18:30</b>.",
      "Если это время сегодня уже прошло, бот выберет завтра.",
      "Можно указать дату: <b>19.08 18:30</b>.", "",
      "В указанное время статус снимется автоматически.",
      "Для отмены отправьте /cancel.",
    ].join("\n"), { inline_keyboard: [[{ text: "Отмена", callback_data: `statecancel:${expectedMatch[2]}:${expectedMatch[3]}` }]] });
  }
  const cancelMatch = /^statecancel:(\d+):(\d+)$/.exec(data);
  if (cancelMatch) {
    await clearInteractionState(env, callback.from.id);
    await answerCallback(env, callback.id, "Отменено");
    return showCategory(env, chatId, { messageId }, Number(cancelMatch[1]), Number(cancelMatch[2]));
  }

  return answerCallback(env, callback.id, "Кнопка устарела. Откройте /menu.", true);
}

export async function handleTelegramUpdate(update, env, ctx, origin) {
  if (update.message) return handleMessage(update.message, env, ctx, origin);
  if (update.callback_query) return handleCallback(update.callback_query, env, ctx, origin);
}

export { deliverNotificationBatch } from "./broadcast.js";
