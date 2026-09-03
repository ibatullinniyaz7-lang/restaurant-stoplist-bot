export const PAGE_SIZE = 8;

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function displayName(user = {}) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (fullName) return fullName;
  if (user.username) return `@${user.username}`;
  return "Сотрудник";
}

export function telegramUserLink(user = {}, label = null) {
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

export function commandName(text = "") {
  const token = text.trim().split(/\s+/, 1)[0].toLowerCase();
  return token.replace(/@[^\s]+$/, "");
}

export function startParameter(text = "") {
  return text.trim().split(/\s+/, 2)[1] ?? "";
}

export function moscowTime(date = new Date(), includeDate = true) {
  const options = {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (includeDate) {
    options.day = "2-digit";
    options.month = "2-digit";
    options.year = "numeric";
  }
  return new Intl.DateTimeFormat("ru-RU", options).format(date);
}

export function sqlDate(value) {
  if (!value) return null;
  return new Date(`${String(value).replace(" ", "T")}Z`);
}

export function paginate(items, page, pageSize = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
  return {
    items: items.slice(safePage * pageSize, (safePage + 1) * pageSize),
    page: safePage,
    pages,
  };
}

export function menuTitle(menuType) {
  return menuType === "bar" ? "Карта бара" : "Кухня";
}

export function menuIcon(menuType) {
  return menuType === "bar" ? "🍹" : "🍽";
}

export function normalizeStatus(status) {
  if (status === true || status === 1) return "stopped";
  if (status === false || status === 0) return "available";
  return ["available", "limited", "expected", "stopped"].includes(status)
    ? status
    : "available";
}

export function statusIcon(status) {
  return {
    available: "✅",
    limited: "⚠️",
    expected: "🕒",
    stopped: "🛑",
  }[normalizeStatus(status)];
}

export function statusLabel(status) {
  return {
    available: "В продаже",
    limited: "Ограничение",
    expected: "Ожидается",
    stopped: "На стопе",
  }[normalizeStatus(status)];
}

export function dishStatusSuffix(dish, fullDate = false) {
  const status = normalizeStatus(dish.availability_status ?? (dish.is_stopped ? "stopped" : "available"));
  if (status === "limited" && Number(dish.limited_quantity) > 0) {
    return ` · осталось ${Number(dish.limited_quantity)}`;
  }
  if (status === "expected" && dish.expected_at) {
    return ` · к ${moscowTime(sqlDate(dish.expected_at), fullDate)}`;
  }
  return "";
}

export function dishButtonText(dish) {
  const status = normalizeStatus(dish.availability_status ?? (dish.is_stopped ? "stopped" : "available"));
  return `${statusIcon(status)} ${dish.name}${dishStatusSuffix(dish)}`;
}

export function mainMenuKeyboard(
  counts = {},
  isOwner = false,
  scheduleCount = 0,
  canManageSchedule = false,
) {
  const kitchenCount = Number(counts.kitchen ?? 0);
  const barCount = Number(counts.bar ?? 0);
  const suffix = (count) => count ? ` · 📋 ${count}` : "";
  const rows = [
    [
      { text: `🍽 Кухня${suffix(kitchenCount)}`, callback_data: "catalog:kitchen:0" },
      { text: `🍹 Бар${suffix(barCount)}`, callback_data: "catalog:bar:0" },
    ],
    [
      { text: "📋 Статусы", callback_data: "stops" },
      {
        text: Number(scheduleCount) > 0 ? "📅 Смены · открыта" : "📅 Смены",
        callback_data: "sched:hub",
      },
    ],
    [{ text: "📣 Объявление", callback_data: "announce:start" }],
  ];
  const management = [];
  if (isOwner) management.push({ text: "👑 Владелец", callback_data: "owner:home" });
  if (canManageSchedule) management.push({ text: "🗓 Управление", callback_data: "sched:manager_home" });
  if (management.length) rows.push(management);
  rows.push([{ text: "🔄 Обновить", callback_data: "home" }]);
  return { inline_keyboard: rows };
}

function categoryStatusSuffix(category) {
  const parts = [];
  if (Number(category.limited_count)) parts.push(`⚠️ ${Number(category.limited_count)}`);
  if (Number(category.expected_count)) parts.push(`🕒 ${Number(category.expected_count)}`);
  if (Number(category.stopped_count)) parts.push(`🛑 ${Number(category.stopped_count)}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export function catalogKeyboard(categories, menuType, page = 0) {
  const pageData = paginate(categories, page);
  const rows = pageData.items.map((category) => [{
    text: `${category.name}${categoryStatusSuffix(category)}`,
    callback_data: `cat:${category.id}:0`,
  }]);

  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) navigation.push({ text: "⬅️", callback_data: `catalog:${menuType}:${pageData.page - 1}` });
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) navigation.push({ text: "➡️", callback_data: `catalog:${menuType}:${pageData.page + 1}` });
    rows.push(navigation);
  }

  rows.push([{ text: "◀️ Главное меню", callback_data: "home" }]);
  return { inline_keyboard: rows };
}

export function categoryKeyboard(categoryId, dishes, page = 0, menuType = "kitchen") {
  const pageData = paginate(dishes, page);
  const rows = pageData.items.map((dish) => [{
    text: dishButtonText(dish),
    callback_data: `dish:${dish.id}:${categoryId}:${pageData.page}`,
  }]);

  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) navigation.push({ text: "⬅️", callback_data: `cat:${categoryId}:${pageData.page - 1}` });
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) navigation.push({ text: "➡️", callback_data: `cat:${categoryId}:${pageData.page + 1}` });
    rows.push(navigation);
  }

  rows.push([{ text: `◀️ ${menuTitle(menuType)}`, callback_data: `catalog:${menuType}:0` }]);
  return { inline_keyboard: rows };
}

export function dishStatusKeyboard(dishId, categoryId, page = 0) {
  return {
    inline_keyboard: [
      [
        { text: "✅ В продаже", callback_data: `setstatus:${dishId}:available:${categoryId}:${page}` },
        { text: "🛑 Стоп", callback_data: `setstatus:${dishId}:stopped:${categoryId}:${page}` },
      ],
      [
        { text: "⚠️ Ограничение", callback_data: `limitmenu:${dishId}:${categoryId}:${page}` },
        { text: "🕒 Ожидается", callback_data: `expectedprompt:${dishId}:${categoryId}:${page}` },
      ],
      [{ text: "◀️ К списку", callback_data: `cat:${categoryId}:${page}` }],
    ],
  };
}

export function limitedQuantityKeyboard(dishId, categoryId, page = 0) {
  const button = (quantity) => ({
    text: String(quantity),
    callback_data: `limitset:${dishId}:${quantity}:${categoryId}:${page}`,
  });
  return {
    inline_keyboard: [
      [button(1), button(2), button(3)],
      [button(4), button(5)],
      [{ text: "✍️ Другое количество", callback_data: `limitcustom:${dishId}:${categoryId}:${page}` }],
      [{ text: "◀️ Назад", callback_data: `dish:${dishId}:${categoryId}:${page}` }],
    ],
  };
}

export function statusDescription(dish) {
  const status = normalizeStatus(dish.availability_status ?? (dish.is_stopped ? "stopped" : "available"));
  const lines = [`${statusIcon(status)} <b>${statusLabel(status)}</b>`];
  if (status === "limited" && dish.limited_quantity) lines.push(`Осталось: <b>${Number(dish.limited_quantity)} шт.</b>`);
  if (status === "expected" && dish.expected_at) lines.push(`Ожидается к: <b>${moscowTime(sqlDate(dish.expected_at))} (МСК)</b>`);
  return lines.join("\n");
}

export function stopListText(rows) {
  if (!rows.length) {
    return "✅ <b>Ограничений нет</b>\n\nВсе позиции кухни и бара доступны для продажи.";
  }

  const grouped = new Map([["kitchen", new Map()], ["bar", new Map()]]);
  for (const row of rows) {
    const menuType = row.menu_type === "bar" ? "bar" : "kitchen";
    const categories = grouped.get(menuType);
    if (!categories.has(row.category_name)) categories.set(row.category_name, []);
    categories.get(row.category_name).push(row);
  }

  const lines = ["📋 <b>Текущие статусы</b>", ""];
  for (const [menuType, categories] of grouped) {
    if (!categories.size) continue;
    lines.push(`${menuIcon(menuType)} <b>${menuTitle(menuType)}</b>`, "");
    for (const [category, dishes] of categories) {
      lines.push(`<b>${escapeHtml(category)}</b>`);
      for (const dish of dishes) {
        const status = normalizeStatus(dish.availability_status);
        lines.push(`• ${statusIcon(status)} ${escapeHtml(dish.name)}${escapeHtml(dishStatusSuffix(dish, true))}`);
      }
      lines.push("");
    }
  }
  lines.push("⚠️ ограничение · 🕒 ожидается · 🛑 стоп");
  return lines.join("\n");
}

export function changeNotification(dish, desiredStatus, actor, details = {}, changedAt = new Date()) {
  if (details instanceof Date) {
    changedAt = details;
    details = {};
  }
  const status = normalizeStatus(desiredStatus);
  const heading = {
    available: "✅ <b>ПОЗИЦИЯ ВЕРНУЛАСЬ В ПРОДАЖУ</b>",
    limited: "⚠️ <b>ПОЗИЦИЯ В ОГРАНИЧЕНИИ</b>",
    expected: "🕒 <b>ПОЗИЦИЯ ОЖИДАЕТСЯ</b>",
    stopped: "🛑 <b>ПОЗИЦИЯ ПОСТАВЛЕНА НА СТОП</b>",
  }[status];
  const section = `${menuTitle(dish.menu_type)} → ${dish.category_name}`;
  const lines = [heading, "", `<b>${escapeHtml(dish.name)}</b>`];
  if (status === "limited") lines.push(`Осталось: <b>${Number(details.quantity ?? dish.limited_quantity)} шт.</b>`);
  if (status === "expected") {
    const value = details.expectedAt ?? dish.expected_at;
    lines.push(`Будет готово: <b>${moscowTime(sqlDate(value))} (МСК)</b>`);
  }
  lines.push(
    `Раздел: ${escapeHtml(section)}`,
    `Изменил(а): ${typeof actor === "string" ? escapeHtml(actor) : telegramUserLink(actor)}`,
    `Время: ${moscowTime(changedAt)} (МСК)`,
  );
  return lines.join("\n");
}
