import { createNotification, deliverNotificationBatch } from "./broadcast.js";
import { answerCallback, editMessage, sendMessage } from "./telegram.js";
import { displayName, paginate, telegramUserLink } from "./ui.js";
import { isStaffBotEnabled } from "./settings.js";

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const START_HOUR = 10;
const END_HOUR = 24;
const MANAGER_DAYS_PER_PAGE = 1;
const PUBLIC_DAYS_PER_PAGE = 1;
const STAFF_PAGE_SIZE = 8;

function moscowParts(date = new Date()) {
  const shifted = new Date(date.getTime() + MOSCOW_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

export function sqlDateToday(date = new Date()) {
  const parts = moscowParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function canOpenNextWeek(date = new Date()) {
  const weekday = moscowParts(date).weekday;
  return weekday === 0 || weekday >= 4;
}

export function canUseNextWeekSignup(period, date = new Date()) {
  return Boolean(
    period &&
    period.status === "open" &&
    period.end_date >= sqlDateToday(date) &&
    period.start_date === nextMonday(1, date) &&
    canOpenNextWeek(date)
  );
}

export function canManagerEditPeriod(period, date = new Date()) {
  const today = sqlDateToday(date);
  return Boolean(
    period &&
    period.status === "open" &&
    period.end_date >= today &&
    (
      period.start_date <= today ||
      (period.start_date === nextMonday(1, date) && canOpenNextWeek(date))
    )
  );
}

export function shouldRunScheduleAutomation(date = new Date()) {
  return date.getUTCMinutes() === 0 && canOpenNextWeek(date);
}

export function nextScheduleOpeningDate(date = new Date()) {
  const today = sqlDateToday(date);
  const weekday = moscowParts(date).weekday;
  const daysUntilThursday = (4 - weekday + 7) % 7;
  return addDays(today, daysUntilThursday);
}

export function addDays(value, amount) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function nextMonday(weeksAhead = 1, now = new Date()) {
  const today = sqlDateToday(now);
  const weekday = moscowParts(now).weekday;
  const daysUntilNextMonday = weekday === 0 ? 1 : 8 - weekday;
  return addDays(today, daysUntilNextMonday + (Math.max(1, Number(weeksAhead) || 1) - 1) * 7);
}

export function formatScheduleDate(value, withYear = false) {
  const [year, month, day] = String(value).split("-");
  if (!year || !month || !day) return String(value);
  const date = new Date(`${value}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" })
    .format(date)
    .replace(".", "");
  return `${weekday}, ${day}.${month}${withYear ? `.${year}` : ""}`;
}

function idOf(user) {
  return typeof user === "object" ? user?.id : user;
}

export function isScheduleManager(env, user) {
  const userId = idOf(user);
  if (String(userId) === String(env.OWNER_USER_ID)) return true;
  return Boolean(env.MANAGER_USER_ID) && String(userId) === String(env.MANAGER_USER_ID);
}

export function managerKeyboard(
  periods = [],
  openingAllowed = canOpenNextWeek(),
  nextWeekStart = nextMonday(),
  today = sqlDateToday(),
) {
  const rows = periods.map((period) => {
    const waitingForThursday = period.status === "open" && period.start_date > today && !openingAllowed;
    const icon = period.status === "closed" ? "⚪" : waitingForThursday ? "⏳" : "🟢";
    return [{
      text: `${icon} ${formatScheduleDate(period.start_date)} — ${formatScheduleDate(period.end_date)}`,
      callback_data: `sched:manager:${period.id}`,
    }];
  });
  const nextWeekExists = periods.some((period) => period.start_date === nextWeekStart);
  if (!nextWeekExists) {
    rows.push([openingAllowed
      ? { text: "🛠 Открыть вручную", callback_data: "sched:open:1" }
      : { text: "⏳ Автооткрытие в четверг", callback_data: "sched:open_locked" }]);
  }
  rows.push([{ text: "◀️ Главное меню", callback_data: "home" }]);
  return { inline_keyboard: rows };
}

export function schedulePeriodAction(
  period,
  today = sqlDateToday(),
  openingAllowed = canOpenNextWeek(),
  nextWeekStart = nextMonday(),
) {
  if (
    period?.status === "open" &&
    period.end_date >= today &&
    (period.start_date <= today || (period.start_date === nextWeekStart && openingAllowed))
  ) {
    return { text: "✅ Закрыть и утвердить", callback_data: `sched:confirm_close:${period.id}` };
  }
  if (
    period?.status === "closed" &&
    period.end_date >= today &&
    (period.start_date <= today || (period.start_date === nextWeekStart && openingAllowed))
  ) {
    return { text: "🔓 Снова открыть запись", callback_data: `sched:reopen:${period.id}` };
  }
  return null;
}

export async function showScheduleManager(env, chatId, messageId = null) {
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
    "📅 <b>Управление сменами</b>",
    "",
    nextWeekExists && !openingAllowed
      ? `Следующая неделя подготовлена. Запись откроется автоматически в четверг, <b>${formatScheduleDate(nextScheduleOpeningDate(), true)}</b>.`
      : nextWeekExists
        ? "Запись на следующую неделю открыта."
      : openingAllowed
        ? "Автооткрытие должно было создать следующую неделю. При необходимости используйте ручное открытие."
        : `Следующая неделя откроется автоматически в четверг, <b>${formatScheduleDate(nextScheduleOpeningDate(), true)}</b>.`,
    periods.length ? "Выберите период, чтобы посмотреть заявки:" : "Периодов пока нет.",
  ].join("\n");
  const keyboard = managerKeyboard(periods, openingAllowed, nextWeekStart, today);
  if (messageId) return editMessage(env, chatId, messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}

async function periodById(env, periodId) {
  return env.DB.prepare(
    "SELECT id, start_date, end_date, status FROM schedule_periods WHERE id = ? LIMIT 1",
  ).bind(periodId).first();
}

async function openPeriod(env, startDate, actor) {
  const endDate = addDays(startDate, 6);
  const insert = await env.DB.prepare(`
    INSERT OR IGNORE INTO schedule_periods
      (start_date, end_date, status, created_by_user_id, created_by_chat_id)
    VALUES (?, ?, 'open', ?, ?)
  `).bind(startDate, endDate, idOf(actor), idOf(actor)).run();
  const period = await periodById(env, (await env.DB.prepare(
    "SELECT id FROM schedule_periods WHERE start_date = ? AND end_date = ? LIMIT 1",
  ).bind(startDate, endDate).first())?.id);
  return period ? { period, created: (insert.meta?.changes ?? 0) === 1 } : null;
}

export function scheduleOpeningMarkerKey(startDate, testMode = false) {
  return `schedule_open_${testMode ? "test_" : ""}notified_${startDate}`;
}

async function claimScheduleOpeningNotice(env, period, actor, testMode) {
  const result = await env.DB.prepare(`
    INSERT OR IGNORE INTO app_settings
      (setting_key, setting_value, updated_at, updated_by_user_id)
    VALUES (?, '1', CURRENT_TIMESTAMP, ?)
  `).bind(scheduleOpeningMarkerKey(period.start_date, testMode), idOf(actor) ?? null).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function openSchedulePeriods(env, actor, origin, now = new Date()) {
  if (!canOpenNextWeek(now)) {
    return { periods: [], createdCount: 0, notAllowed: true };
  }
  const opened = await openPeriod(env, nextMonday(1, now), actor);
  const periods = opened?.period ? [opened] : [];

  let notifiedCount = 0;
  const testMode = !(await isStaffBotEnabled(env));
  for (const opened of periods.filter((item) => item.period.status === "open")) {
    const period = opened.period;
    if (!(await claimScheduleOpeningNotice(env, period, actor, testMode))) continue;
    const notificationId = await createNotification(env, [
      "📅 <b>ОТКРЫТА ЗАПИСЬ НА СМЕНЫ</b>",
      "",
      `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
      "",
      "Откройте /schedule → «Следующая неделя», чтобы указать время работы или выходной.",
    ].join("\n"), { kind: "schedule", createdByUserId: idOf(actor) });
    await deliverNotificationBatch(env, origin, notificationId);
    notifiedCount += 1;
  }
  return {
    periods: periods.map((item) => item.period),
    createdCount: periods.filter((item) => item.created).length,
    notifiedCount,
  };
}

export async function processScheduleAutomation(env, origin, now = new Date()) {
  if (now.getUTCMinutes() !== 0) {
    return { periods: [], createdCount: 0, betweenHourlyChecks: true };
  }
  if (!canOpenNextWeek(now)) {
    return { periods: [], createdCount: 0, outsideOpeningWindow: true };
  }
  const actor = { id: Number(env.OWNER_USER_ID) || 0 };
  return openSchedulePeriods(env, actor, origin, now);
}

async function showPeriod(env, chatId, messageId, periodId, forManager = false, page = 0) {
  const period = await periodById(env, periodId);
  if (!period) return editMessage(env, chatId, messageId, "Период не найден.", { inline_keyboard: [] });
  const managerCanEdit = canManagerEditPeriod(period);
  const result = await env.DB.prepare(`
    SELECT se.shift_date, se.user_id, se.display_name, se.start_time, se.end_time,
           se.is_day_off, p.username
    FROM schedule_entries se
    LEFT JOIN participants p ON p.chat_id = se.chat_id
    WHERE se.period_id = ?
    ORDER BY se.shift_date, CASE WHEN se.is_day_off = 1 THEN 1 ELSE 0 END,
             se.start_time, se.display_name
  `).bind(periodId).all();
  const entries = result.results ?? [];
  const grouped = new Map();
  for (const entry of entries) {
    if (!grouped.has(entry.shift_date)) grouped.set(entry.shift_date, []);
    grouped.get(entry.shift_date).push(entry);
  }
  const lines = [
    "📅 <b>График смен</b>",
    `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
    `Статус: ${period.status === "closed"
      ? "✅ график утверждён"
      : managerCanEdit
        ? "🟢 запись открыта"
        : "⏳ запись откроется в четверг"}`,
    "",
  ];
  const safePage = Math.max(0, Math.min(Number(page) || 0, Math.ceil(7 / MANAGER_DAYS_PER_PAGE) - 1));
  const firstDay = forManager ? safePage * MANAGER_DAYS_PER_PAGE : 0;
  const lastDay = forManager ? Math.min(7, firstDay + MANAGER_DAYS_PER_PAGE) : 7;
  for (let offset = firstDay; offset < lastDay; offset += 1) {
    const date = addDays(period.start_date, offset);
    const dayEntries = grouped.get(date) ?? [];
    lines.push(`<b>${formatScheduleDate(date)}</b>`);
    if (!dayEntries.length) {
      lines.push("— заявок пока нет");
    } else {
      for (const entry of dayEntries) lines.push(scheduleEntryLine(entry));
    }
    lines.push("");
  }
  const rows = [];
  if (forManager && managerCanEdit) {
    rows.push([{
      text: "✏️ Добавить / изменить смену",
      callback_data: `sched:edit:${period.id}:0`,
    }]);
  }
  const periodAction = forManager ? schedulePeriodAction(period) : null;
  if (periodAction) rows.push([periodAction]);
  if (forManager) {
    const navigation = [];
    if (safePage > 0) navigation.push({ text: "⬅️", callback_data: `sched:manager:${period.id}:${safePage - 1}` });
    navigation.push({ text: `${safePage + 1}/${Math.ceil(7 / MANAGER_DAYS_PER_PAGE)}`, callback_data: "noop" });
    if (safePage + 1 < Math.ceil(7 / MANAGER_DAYS_PER_PAGE)) {
      navigation.push({ text: "➡️", callback_data: `sched:manager:${period.id}:${safePage + 1}` });
    }
    rows.push(navigation);
  }
  rows.push([{ text: "◀️ Управление сменами", callback_data: "sched:manager_home" }]);
  return editMessage(env, chatId, messageId, lines.join("\n"), { inline_keyboard: rows });
}

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

export async function publishedPeriodCount(env) {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM schedule_periods
    WHERE status = 'closed' AND end_date >= ?
  `).bind(sqlDateToday()).first();
  return Number(result?.count ?? 0);
}

async function showPublishedPeriod(env, chatId, messageId, periodId, page = 0) {
  const period = await periodById(env, periodId);
  if (!period || period.status !== "closed" || period.end_date < sqlDateToday()) {
    return editMessage(env, chatId, messageId, [
      "📅 <b>Утверждённое расписание</b>",
      "",
      "Этот график снова редактируется или уже завершён.",
    ].join("\n"), {
      inline_keyboard: [[{ text: "◀️ Главное меню", callback_data: "home" }]],
    });
  }
  const result = await env.DB.prepare(`
    SELECT se.shift_date, se.user_id, se.display_name, se.start_time, se.end_time,
           se.is_day_off, p.username
    FROM schedule_entries se
    LEFT JOIN participants p ON p.chat_id = se.chat_id
    WHERE se.period_id = ? AND se.is_day_off = 0
    ORDER BY se.shift_date, se.start_time, se.display_name
  `).bind(periodId).all();
  const grouped = new Map();
  for (const entry of result.results ?? []) {
    if (!grouped.has(entry.shift_date)) grouped.set(entry.shift_date, []);
    grouped.get(entry.shift_date).push(entry);
  }

  const pages = Math.ceil(7 / PUBLIC_DAYS_PER_PAGE);
  const safePage = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const firstDay = safePage * PUBLIC_DAYS_PER_PAGE;
  const lastDay = Math.min(7, firstDay + PUBLIC_DAYS_PER_PAGE);
  const lines = [
    "📅 <b>Расписание на неделю</b>",
    `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
    "Статус: ✅ утверждено менеджером",
    "",
  ];
  for (let offset = firstDay; offset < lastDay; offset += 1) {
    const date = addDays(period.start_date, offset);
    const entries = grouped.get(date) ?? [];
    lines.push(`<b>${formatScheduleDate(date)}</b>`);
    if (!entries.length) lines.push("— смен нет");
    else for (const entry of entries) lines.push(scheduleEntryLine(entry));
    lines.push("");
  }

  const navigation = [];
  if (safePage > 0) navigation.push({ text: "⬅️", callback_data: `sched:pub:${period.id}:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: "noop" });
  if (safePage + 1 < pages) navigation.push({ text: "➡️", callback_data: `sched:pub:${period.id}:${safePage + 1}` });
  const allPeriods = await publishedPeriods(env);
  const back = allPeriods.length > 1
    ? { text: "◀️ Утверждённые недели", callback_data: "sched:published" }
    : { text: "◀️ Главное меню", callback_data: "home" };
  return editMessage(env, chatId, messageId, lines.join("\n"), {
    inline_keyboard: [navigation, [back]],
  });
}

export async function showPublishedSchedules(env, chatId, messageId) {
  const periods = await publishedPeriods(env);
  if (!periods.length) {
    return editMessage(env, chatId, messageId, [
      "📅 <b>Расписание на неделю</b>",
      "",
      "Утверждённого графика пока нет.",
    ].join("\n"), {
      inline_keyboard: [[{ text: "◀️ Главное меню", callback_data: "home" }]],
    });
  }
  if (periods.length === 1) {
    return showPublishedPeriod(env, chatId, messageId, periods[0].id, 0);
  }
  const rows = periods.map((period) => [{
    text: `${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}`,
    callback_data: `sched:pub:${period.id}:0`,
  }]);
  rows.push([{ text: "◀️ Главное меню", callback_data: "home" }]);
  return editMessage(env, chatId, messageId, [
    "📅 <b>Утверждённые расписания</b>",
    "",
    "Выберите неделю:",
  ].join("\n"), { inline_keyboard: rows });
}

async function periodContainingDate(env, date) {
  return env.DB.prepare(`
    SELECT id, start_date, end_date, status
    FROM schedule_periods
    WHERE start_date <= ? AND end_date >= ?
    ORDER BY start_date DESC, id DESC
    LIMIT 1
  `).bind(date, date).first();
}

async function nextWeekPeriod(env, now = new Date()) {
  return env.DB.prepare(`
    SELECT id, start_date, end_date, status
    FROM schedule_periods
    WHERE start_date = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(nextMonday(1, now)).first();
}

function dayOffset(startDate, date) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const value = new Date(`${date}T12:00:00Z`);
  return Math.max(0, Math.min(6, Math.round((value.getTime() - start.getTime()) / 86400000)));
}

export function scheduleHubKeyboard(current, next, openingAllowed = canOpenNextWeek()) {
  const currentLabel = current
    ? `🗓 Текущая неделя · ${current.status === "closed" ? "утверждена" : "обновляется"}`
    : "🗓 Текущая неделя · графика нет";
  const nextLabel = !next || (next.status === "open" && !openingAllowed)
    ? "⏳ Следующая неделя · откроется в четверг"
    : next.status === "open"
      ? "✍️ Следующая неделя · запись открыта"
      : "✅ Следующая неделя · утверждена";
  return {
    inline_keyboard: [
      [{ text: currentLabel, callback_data: "sched:current" }],
      [{ text: nextLabel, callback_data: "sched:next" }],
      [{ text: "◀️ Главное меню", callback_data: "home" }],
    ],
  };
}

export async function showScheduleHub(env, chatId, messageId = null, now = new Date()) {
  const today = sqlDateToday(now);
  const [current, next] = await Promise.all([
    periodContainingDate(env, today),
    nextWeekPeriod(env, now),
  ]);
  const currentText = current
    ? `${formatScheduleDate(current.start_date, true)} — ${formatScheduleDate(current.end_date, true)}`
    : "график пока не создан";
  const nextText = next
    ? `${formatScheduleDate(next.start_date, true)} — ${formatScheduleDate(next.end_date, true)}`
    : `откроется автоматически ${formatScheduleDate(nextScheduleOpeningDate(now), true)}`;
  const text = [
    "📅 <b>Смены</b>",
    "",
    `🗓 Текущая неделя: <b>${currentText}</b>`,
    `⏭ Следующая неделя: <b>${nextText}</b>`,
    "",
    "Выберите нужную вкладку.",
  ].join("\n");
  const keyboard = scheduleHubKeyboard(current, next, canOpenNextWeek(now));
  if (messageId) return editMessage(env, chatId, messageId, text, keyboard);
  return sendMessage(env, chatId, text, { reply_markup: keyboard });
}

async function showTeamSchedulePeriod(env, chatId, messageId, period, page, scope) {
  const result = await env.DB.prepare(`
    SELECT se.shift_date, se.user_id, se.display_name, se.start_time, se.end_time,
           se.is_day_off, p.username
    FROM schedule_entries se
    LEFT JOIN participants p ON p.chat_id = se.chat_id
    WHERE se.period_id = ? AND se.is_day_off = 0
    ORDER BY se.shift_date, se.start_time, se.display_name
  `).bind(period.id).all();
  const grouped = new Map();
  for (const entry of result.results ?? []) {
    if (!grouped.has(entry.shift_date)) grouped.set(entry.shift_date, []);
    grouped.get(entry.shift_date).push(entry);
  }
  const pages = 7;
  const safePage = Math.max(0, Math.min(Number(page) || 0, pages - 1));
  const date = addDays(period.start_date, safePage);
  const entries = grouped.get(date) ?? [];
  const title = scope === "current" ? "Текущие смены" : "Расписание следующей недели";
  const lines = [
    `📅 <b>${title}</b>`,
    `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
    `Статус: ${period.status === "closed" ? "✅ утверждено" : "🟢 редактируется"}`,
    "",
    `<b>${formatScheduleDate(date)}</b>`,
  ];
  if (!entries.length) lines.push("— смен нет");
  else for (const entry of entries) lines.push(scheduleEntryLine(entry));

  const callbackPrefix = scope === "current" ? "sched:cur" : "sched:nxt";
  const navigation = [];
  if (safePage > 0) navigation.push({ text: "⬅️", callback_data: `${callbackPrefix}:${period.id}:${safePage - 1}` });
  navigation.push({ text: `${safePage + 1}/${pages}`, callback_data: "noop" });
  if (safePage + 1 < pages) navigation.push({ text: "➡️", callback_data: `${callbackPrefix}:${period.id}:${safePage + 1}` });
  return editMessage(env, chatId, messageId, lines.join("\n"), {
    inline_keyboard: [navigation, [{ text: "◀️ Смены", callback_data: "sched:hub" }]],
  });
}

async function showCurrentSchedule(env, chatId, messageId, page = null, expectedPeriodId = null, now = new Date()) {
  const today = sqlDateToday(now);
  const period = await periodContainingDate(env, today);
  if (!period || (expectedPeriodId && Number(period.id) !== Number(expectedPeriodId))) {
    return editMessage(env, chatId, messageId, [
      "🗓 <b>Текущие смены</b>",
      "",
      "Расписание на текущую неделю пока не создано.",
    ].join("\n"), {
      inline_keyboard: [[{ text: "◀️ Смены", callback_data: "sched:hub" }]],
    });
  }
  const targetPage = page == null ? dayOffset(period.start_date, today) : page;
  return showTeamSchedulePeriod(env, chatId, messageId, period, targetPage, "current");
}

async function showNextSchedule(env, chatId, messageId, page = 0, expectedPeriodId = null, now = new Date()) {
  const period = await nextWeekPeriod(env, now);
  if (!period || (expectedPeriodId && Number(period.id) !== Number(expectedPeriodId))) {
    return editMessage(env, chatId, messageId, [
      "⏭ <b>Следующая неделя</b>",
      "",
      `Запись откроется автоматически в четверг, <b>${formatScheduleDate(nextScheduleOpeningDate(now), true)}</b>.`,
    ].join("\n"), {
      inline_keyboard: [[{ text: "◀️ Смены", callback_data: "sched:hub" }]],
    });
  }
  if (period.status === "open") {
    if (!canUseNextWeekSignup(period, now)) {
      return editMessage(env, chatId, messageId, [
        "⏭ <b>Следующая неделя</b>",
        "",
        `Запись откроется автоматически в четверг, <b>${formatScheduleDate(nextScheduleOpeningDate(now), true)}</b>.`,
        "Внесённые ранее данные сохранены, но изменить их до открытия нельзя.",
      ].join("\n"), {
        inline_keyboard: [[{ text: "◀️ Смены", callback_data: "sched:hub" }]],
      });
    }
    return showEmployeePeriod(env, chatId, messageId, period.id);
  }
  return showTeamSchedulePeriod(env, chatId, messageId, period, page, "next");
}

export async function showScheduleHome(env, chatId, messageId = null) {
  return showScheduleHub(env, chatId, messageId);
}

async function employeeEntry(env, periodId, chatId, date) {
  return env.DB.prepare(`
    SELECT start_time, end_time, is_day_off
    FROM schedule_entries
    WHERE period_id = ? AND chat_id = ? AND shift_date = ?
    LIMIT 1
  `).bind(periodId, chatId, date).first();
}

async function showEmployeePeriod(env, chatId, messageId, periodId) {
  const period = await periodById(env, periodId);
  if (!canUseNextWeekSignup(period)) {
    return showScheduleHome(env, chatId, messageId);
  }
  const rows = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(period.start_date, offset);
    const entry = await employeeEntry(env, periodId, chatId, date);
    const status = entry?.is_day_off
      ? "выходной"
      : entry?.start_time
        ? scheduleTimeRange(entry)
        : "не указано";
    rows.push([{ text: `${formatScheduleDate(date)} · ${status}`, callback_data: `sched:day:${periodId}:${date}` }]);
  }
  rows.push([{ text: "◀️ Недели", callback_data: "sched:home" }]);
  return editMessage(env, chatId, messageId, [
    "📅 <b>Ваша запись</b>",
    `Период: ${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}`,
    "",
    "Выберите день и укажите часы работы или выходной.",
  ].join("\n"), { inline_keyboard: rows });
}

function hourLabel(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function validScheduleTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ""));
}

function scheduleTimeRange(entry) {
  if (!validScheduleTime(entry?.start_time) || !validScheduleTime(entry?.end_time)) {
    return "⚠️ время нужно указать заново";
  }
  return `${entry.start_time}–${entry.end_time}`;
}

export function scheduleEntryLine(entry) {
  const employee = telegramUserLink(
    { id: entry?.user_id, username: entry?.username },
    entry?.display_name,
  );
  return entry?.is_day_off
    ? `• ${employee} — выходной`
    : `• ${employee} — ${scheduleTimeRange(entry)}`;
}

export function parseScheduleEndCallback(data) {
  const match = /^sched:end:(\d+):(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(data ?? "");
  if (!match) return null;
  const startHour = Number(match[3]);
  const endHour = Number(match[4]);
  if (
    startHour < START_HOUR ||
    startHour >= END_HOUR ||
    endHour <= startHour ||
    endHour > END_HOUR
  ) return null;
  return {
    periodId: Number(match[1]),
    date: match[2],
    startHour,
    endHour,
  };
}

async function showDay(env, chatId, messageId, periodId, date) {
  const period = await periodById(env, periodId);
  if (
    !canUseNextWeekSignup(period) ||
    !dateBelongsToPeriod(period, date)
  ) return showScheduleHome(env, chatId, messageId);
  const entry = await employeeEntry(env, periodId, chatId, date);
  const rows = [];
  for (let hour = START_HOUR; hour < END_HOUR; hour += 1) {
    rows.push({ text: hourLabel(hour), callback_data: `sched:start:${periodId}:${date}:${hour}` });
  }
  const keyboard = [];
  for (let index = 0; index < rows.length; index += 3) keyboard.push(rows.slice(index, index + 3));
  keyboard.push([{ text: "🌴 Выходной", callback_data: `sched:off:${periodId}:${date}` }]);
  keyboard.push([{ text: "◀️ Дни недели", callback_data: `sched:period:${periodId}` }]);
  const current = entry?.is_day_off
    ? "🌴 выходной"
    : entry?.start_time
      ? `⏰ ${scheduleTimeRange(entry)}`
      : "не указано";
  return editMessage(env, chatId, messageId, [
    `📅 <b>${formatScheduleDate(date, true)}</b>`,
    `Сейчас: ${current}`,
    "",
    "Выберите начало смены. Затем бот предложит время окончания.",
  ].join("\n"), { inline_keyboard: keyboard });
}

async function showEndPicker(env, chatId, messageId, periodId, date, startHour) {
  const rows = [];
  for (let hour = startHour + 1; hour <= END_HOUR; hour += 1) {
    const endLabel = hour === END_HOUR ? "00:00" : hourLabel(hour);
    rows.push({ text: endLabel, callback_data: `sched:end:${periodId}:${date}:${startHour}:${hour}` });
  }
  const keyboard = [];
  for (let index = 0; index < rows.length; index += 3) keyboard.push(rows.slice(index, index + 3));
  keyboard.push([{ text: "◀️ К началу смены", callback_data: `sched:day:${periodId}:${date}` }]);
  return editMessage(env, chatId, messageId, [
    `⏰ <b>Начало: ${hourLabel(startHour)}</b>`,
    "",
    "Выберите окончание смены:",
  ].join("\n"), { inline_keyboard: keyboard });
}

async function saveEntry(
  env,
  periodId,
  user,
  date,
  startTime,
  endTime,
  isDayOff = 0,
  mode = "employee",
  now = new Date(),
) {
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
    nextMonday(1, now),
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

async function activeParticipant(env, chatId) {
  return env.DB.prepare(`
    SELECT chat_id, user_id, display_name, username
    FROM participants
    WHERE chat_id = ? AND active = 1 AND blocked = 0
    LIMIT 1
  `).bind(chatId).first();
}

function entryDescription(entry, emptyLabel = "не указано") {
  if (!entry) return emptyLabel;
  if (entry.is_day_off) return "выходной";
  return scheduleTimeRange(entry);
}

function dateBelongsToPeriod(period, date) {
  return Boolean(period && date >= period.start_date && date <= period.end_date);
}

async function editableManagerPeriod(env, periodId) {
  const period = await periodById(env, periodId);
  if (!canManagerEditPeriod(period)) return null;
  return period;
}

async function showManagerStaff(env, chatId, messageId, periodId, page = 0) {
  const period = await editableManagerPeriod(env, periodId);
  if (!period) {
    return editMessage(env, chatId, messageId, [
      "✏️ <b>Редактирование смен</b>",
      "",
      "Сначала снова откройте запись на эту неделю.",
    ].join("\n"), {
      inline_keyboard: [[{ text: "◀️ К графику", callback_data: `sched:manager:${periodId}` }]],
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
    callback_data: `sched:epick:${period.id}:${person.chat_id}:${pageData.page}`,
  }]);
  if (pageData.pages > 1) {
    const navigation = [];
    if (pageData.page > 0) navigation.push({ text: "⬅️", callback_data: `sched:edit:${period.id}:${pageData.page - 1}` });
    navigation.push({ text: `${pageData.page + 1}/${pageData.pages}`, callback_data: "noop" });
    if (pageData.page + 1 < pageData.pages) navigation.push({ text: "➡️", callback_data: `sched:edit:${period.id}:${pageData.page + 1}` });
    rows.push(navigation);
  }
  rows.push([{ text: "◀️ К графику", callback_data: `sched:manager:${period.id}` }]);
  return editMessage(env, chatId, messageId, [
    "✏️ <b>Добавить или изменить смену</b>",
    `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
    "",
    "Выберите сотрудника:",
  ].join("\n"), { inline_keyboard: rows });
}

async function managedEmployeeEntries(env, periodId, targetChatId) {
  const result = await env.DB.prepare(`
    SELECT shift_date, start_time, end_time, is_day_off
    FROM schedule_entries
    WHERE period_id = ? AND chat_id = ?
    ORDER BY shift_date
  `).bind(periodId, targetChatId).all();
  return new Map((result.results ?? []).map((entry) => [entry.shift_date, entry]));
}

async function showManagedEmployee(env, chatId, messageId, periodId, targetChatId, staffPage = 0) {
  const [period, target] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
  ]);
  if (!period || !target) return showManagerStaff(env, chatId, messageId, periodId, staffPage);
  const entries = await managedEmployeeEntries(env, periodId, targetChatId);
  const rows = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(period.start_date, offset);
    rows.push([{
      text: `${formatScheduleDate(date)} · ${entryDescription(entries.get(date))}`,
      callback_data: `sched:eday:${period.id}:${target.chat_id}:${staffPage}:${date}`,
    }]);
  }
  rows.push([{ text: "◀️ Сотрудники", callback_data: `sched:edit:${period.id}:${staffPage}` }]);
  return editMessage(env, chatId, messageId, [
    "👤 <b>Редактирование графика</b>",
    `Сотрудник: ${telegramUserLink(target, target.display_name)}`,
    `Период: ${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}`,
    "",
    "Выберите день:",
  ].join("\n"), { inline_keyboard: rows });
}

async function showManagedDay(env, chatId, messageId, periodId, targetChatId, staffPage, date) {
  const [period, target, entry] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date),
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    return showManagerStaff(env, chatId, messageId, periodId, staffPage);
  }
  const startButtons = [];
  for (let hour = START_HOUR; hour < END_HOUR; hour += 1) {
    startButtons.push({
      text: hourLabel(hour),
      callback_data: `sched:estart:${period.id}:${target.chat_id}:${staffPage}:${date}:${hour}`,
    });
  }
  const rows = [];
  for (let index = 0; index < startButtons.length; index += 3) {
    rows.push(startButtons.slice(index, index + 3));
  }
  rows.push([{
    text: "🌴 Поставить выходной",
    callback_data: `sched:eoff:${period.id}:${target.chat_id}:${staffPage}:${date}`,
  }]);
  if (entry) {
    rows.push([{
      text: "🗑 Удалить запись за день",
      callback_data: `sched:eclearask:${period.id}:${target.chat_id}:${staffPage}:${date}`,
    }]);
  }
  rows.push([{
    text: "◀️ Дни сотрудника",
    callback_data: `sched:epick:${period.id}:${target.chat_id}:${staffPage}`,
  }]);
  return editMessage(env, chatId, messageId, [
    "✏️ <b>Редактирование смены</b>",
    `Сотрудник: ${telegramUserLink(target, target.display_name)}`,
    `Дата: <b>${formatScheduleDate(date, true)}</b>`,
    `Сейчас: <b>${entryDescription(entry)}</b>`,
    "",
    "Выберите время начала:",
  ].join("\n"), { inline_keyboard: rows });
}

async function showManagedEndPicker(
  env,
  chatId,
  messageId,
  periodId,
  targetChatId,
  staffPage,
  date,
  startHour,
) {
  const [period, target] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    return showManagerStaff(env, chatId, messageId, periodId, staffPage);
  }
  const endButtons = [];
  for (let hour = startHour + 1; hour <= END_HOUR; hour += 1) {
    endButtons.push({
      text: hour === END_HOUR ? "00:00" : hourLabel(hour),
      callback_data: `sched:eend:${period.id}:${target.chat_id}:${staffPage}:${date}:${startHour}:${hour}`,
    });
  }
  const rows = [];
  for (let index = 0; index < endButtons.length; index += 3) {
    rows.push(endButtons.slice(index, index + 3));
  }
  rows.push([{
    text: "◀️ К началу смены",
    callback_data: `sched:eday:${period.id}:${target.chat_id}:${staffPage}:${date}`,
  }]);
  return editMessage(env, chatId, messageId, [
    "✏️ <b>Редактирование смены</b>",
    `Сотрудник: ${telegramUserLink(target, target.display_name)}`,
    `Дата: <b>${formatScheduleDate(date, true)}</b>`,
    `Начало: <b>${hourLabel(startHour)}</b>`,
    "",
    "Выберите время окончания:",
  ].join("\n"), { inline_keyboard: rows });
}

export function scheduleChangeNotificationText(
  target,
  actor,
  period,
  date,
  before,
  after,
  testMode = false,
) {
  const testPrefix = testMode
    ? [
        "🧪 <b>ТЕСТОВОЕ УВЕДОМЛЕНИЕ</b>",
        `После включения бота его получил бы: ${telegramUserLink(target, target.display_name)}`,
        "",
      ]
    : [];
  const text = [
    ...testPrefix,
    "✏️ <b>ИЗМЕНЕНИЕ В ГРАФИКЕ</b>",
    "",
    `Сотрудник: ${telegramUserLink(target, target.display_name)}`,
    `Неделя: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
    `Дата: <b>${formatScheduleDate(date, true)}</b>`,
    `Было: <b>${entryDescription(before, "записи не было")}</b>`,
    `Стало: <b>${entryDescription(after, "запись удалена")}</b>`,
    "",
    `Изменил(а): ${telegramUserLink(actor)}`,
  ].join("\n");
  return text;
}

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
    !staffBotEnabled && !targetIsOwner,
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
      message: error?.message,
    });
    return false;
  }
}

async function saveManagedEntry(
  callback,
  env,
  periodId,
  targetChatId,
  staffPage,
  date,
  startTime,
  endTime,
  isDayOff,
) {
  const [period, target, before] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date),
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    await answerCallback(env, callback.id, "Период или сотрудник недоступен", true);
    return showManagerStaff(env, callback.message.chat.id, callback.message.message_id, periodId, staffPage);
  }
  const after = { start_time: startTime, end_time: endTime, is_day_off: isDayOff };
  if (entryDescription(before) === entryDescription(after)) {
    await answerCallback(env, callback.id, "Такая запись уже установлена");
    return showManagedEmployee(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      targetChatId,
      staffPage,
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
    "manager",
  );
  if (!saved) {
    await answerCallback(env, callback.id, "График уже закрыт. Изменение не сохранено.", true);
    return showPeriod(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      true,
    );
  }
  const delivered = await notifyManagedScheduleChange(
    env,
    target,
    callback.from,
    period,
    date,
    before,
    after,
  );
  await answerCallback(
    env,
    callback.id,
    delivered ? "Смена сохранена, уведомление отправлено" : "Смена сохранена, уведомление не доставлено",
  );
  return showManagedEmployee(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    periodId,
    targetChatId,
    staffPage,
  );
}

async function showManagedClearConfirmation(
  env,
  chatId,
  messageId,
  periodId,
  targetChatId,
  staffPage,
  date,
) {
  const [period, target, entry] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date),
  ]);
  if (!period || !target || !entry || !dateBelongsToPeriod(period, date)) {
    return showManagedDay(env, chatId, messageId, periodId, targetChatId, staffPage, date);
  }
  return editMessage(env, chatId, messageId, [
    "🗑 <b>Удалить запись за день?</b>",
    "",
    `Сотрудник: ${telegramUserLink(target, target.display_name)}`,
    `Дата: <b>${formatScheduleDate(date, true)}</b>`,
    `Сейчас: <b>${entryDescription(entry)}</b>`,
  ].join("\n"), {
    inline_keyboard: [
      [{
        text: "🗑 Да, удалить",
        callback_data: `sched:eclear:${period.id}:${target.chat_id}:${staffPage}:${date}`,
      }],
      [{
        text: "Отмена",
        callback_data: `sched:eday:${period.id}:${target.chat_id}:${staffPage}:${date}`,
      }],
    ],
  });
}

async function clearManagedEntry(callback, env, periodId, targetChatId, staffPage, date) {
  const [period, target, before] = await Promise.all([
    editableManagerPeriod(env, periodId),
    activeParticipant(env, targetChatId),
    employeeEntry(env, periodId, targetChatId, date),
  ]);
  if (!period || !target || !dateBelongsToPeriod(period, date)) {
    await answerCallback(env, callback.id, "Период или сотрудник недоступен", true);
    return showManagerStaff(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      staffPage,
    );
  }
  if (!before) {
    await answerCallback(env, callback.id, "Запись уже удалена");
    return showManagedEmployee(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      targetChatId,
      staffPage,
    );
  }
  const now = new Date();
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
    nextMonday(1, now),
  ).run();
  if ((deleted.meta?.changes ?? 0) !== 1) {
    await answerCallback(env, callback.id, "График уже закрыт. Запись не удалена.", true);
    return showPeriod(
      env,
      callback.message.chat.id,
      callback.message.message_id,
      periodId,
      true,
    );
  }
  const delivered = await notifyManagedScheduleChange(
    env,
    target,
    callback.from,
    period,
    date,
    before,
    null,
  );
  await answerCallback(
    env,
    callback.id,
    delivered ? "Запись удалена, уведомление отправлено" : "Запись удалена, уведомление не доставлено",
  );
  return showManagedEmployee(
    env,
    callback.message.chat.id,
    callback.message.message_id,
    periodId,
    targetChatId,
    staffPage,
  );
}

async function showCloseConfirmation(env, chatId, messageId, periodId) {
  const period = await periodById(env, periodId);
  if (!canManagerEditPeriod(period)) {
    return showPeriod(env, chatId, messageId, periodId, true);
  }
  return editMessage(env, chatId, messageId, [
    "✅ <b>Утвердить график?</b>",
    "",
    `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
    "",
    "Запись сотрудников закроется, а общий график появится у всей команды.",
  ].join("\n"), {
    inline_keyboard: [
      [{ text: "✅ Да, закрыть и утвердить", callback_data: `sched:close:${period.id}` }],
      [{ text: "Отмена", callback_data: `sched:manager:${period.id}` }],
    ],
  });
}

export async function handleScheduleCallback(callback, env, ctx, origin) {
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
      Number(currentPageMatch[1]),
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
      Number(nextPageMatch[1]),
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
      Number(publicPeriodMatch[2]),
    );
  }
  if (data === "sched:manager_home") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    await answerCallback(env, callback.id);
    return showScheduleManager(env, chatId, messageId);
  }
  if (data === "sched:open_locked") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    return answerCallback(env, callback.id, "Открытие доступно с четверга по воскресенье (МСК)", true);
  }
  if (data === "sched:open:2") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    return answerCallback(env, callback.id, "Открытие сразу двух недель отключено. Обновите меню.", true);
  }
  if (data === "sched:open:1") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    const opened = await openSchedulePeriods(env, callback.from, origin);
    if (opened.notAllowed) {
      return answerCallback(env, callback.id, "Открытие доступно с четверга по воскресенье (МСК)", true);
    }
    await answerCallback(
      env,
      callback.id,
      opened.createdCount
        ? "Запись открыта, уведомление отправлено"
        : opened.notifiedCount
          ? "Неделя уже была открыта, уведомление отправлено"
          : "Эта неделя уже создана",
    );
    return showScheduleManager(env, chatId, messageId);
  }
  const managerMatch = /^sched:manager:(\d+)(?::(\d+))?$/.exec(data);
  if (managerMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    await answerCallback(env, callback.id);
    return showPeriod(env, chatId, messageId, Number(managerMatch[1]), true, Number(managerMatch[2] ?? 0));
  }
  const editStaffMatch = /^sched:edit:(\d+):(\d+)$/.exec(data);
  if (editStaffMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    await answerCallback(env, callback.id);
    return showManagerStaff(
      env,
      chatId,
      messageId,
      Number(editStaffMatch[1]),
      Number(editStaffMatch[2]),
    );
  }
  const editPersonMatch = /^sched:epick:(\d+):(\d+):(\d+)$/.exec(data);
  if (editPersonMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    await answerCallback(env, callback.id);
    return showManagedEmployee(
      env,
      chatId,
      messageId,
      Number(editPersonMatch[1]),
      Number(editPersonMatch[2]),
      Number(editPersonMatch[3]),
    );
  }
  const editDayMatch = /^sched:eday:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editDayMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    await answerCallback(env, callback.id);
    return showManagedDay(
      env,
      chatId,
      messageId,
      Number(editDayMatch[1]),
      Number(editDayMatch[2]),
      Number(editDayMatch[3]),
      editDayMatch[4],
    );
  }
  const editStartMatch = /^sched:estart:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2}):(\d{2})$/.exec(data);
  if (editStartMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    const startHour = Number(editStartMatch[5]);
    if (startHour < START_HOUR || startHour >= END_HOUR) {
      return answerCallback(env, callback.id, "Время указано неверно", true);
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
      startHour,
    );
  }
  const editEndMatch = /^sched:eend:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(data);
  if (editEndMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    const startHour = Number(editEndMatch[5]);
    const endHour = Number(editEndMatch[6]);
    if (
      startHour < START_HOUR ||
      startHour >= END_HOUR ||
      endHour <= startHour ||
      endHour > END_HOUR
    ) return answerCallback(env, callback.id, "Время указано неверно", true);
    return saveManagedEntry(
      callback,
      env,
      Number(editEndMatch[1]),
      Number(editEndMatch[2]),
      Number(editEndMatch[3]),
      editEndMatch[4],
      hourLabel(startHour),
      endHour === END_HOUR ? "00:00" : hourLabel(endHour),
      0,
    );
  }
  const editOffMatch = /^sched:eoff:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editOffMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    return saveManagedEntry(
      callback,
      env,
      Number(editOffMatch[1]),
      Number(editOffMatch[2]),
      Number(editOffMatch[3]),
      editOffMatch[4],
      null,
      null,
      1,
    );
  }
  const editClearAskMatch = /^sched:eclearask:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editClearAskMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    await answerCallback(env, callback.id);
    return showManagedClearConfirmation(
      env,
      chatId,
      messageId,
      Number(editClearAskMatch[1]),
      Number(editClearAskMatch[2]),
      Number(editClearAskMatch[3]),
      editClearAskMatch[4],
    );
  }
  const editClearMatch = /^sched:eclear:(\d+):(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (editClearMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    return clearManagedEntry(
      callback,
      env,
      Number(editClearMatch[1]),
      Number(editClearMatch[2]),
      Number(editClearMatch[3]),
      editClearMatch[4],
    );
  }
  const closeConfirmationMatch = /^sched:confirm_close:(\d+)$/.exec(data);
  if (closeConfirmationMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    await answerCallback(env, callback.id);
    return showCloseConfirmation(env, chatId, messageId, Number(closeConfirmationMatch[1]));
  }
  const closeMatch = /^sched:close:(\d+)$/.exec(data);
  if (closeMatch) {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
    const period = await periodById(env, Number(closeMatch[1]));
    if (!period || period.end_date < sqlDateToday()) {
      return answerCallback(env, callback.id, "Эта неделя уже завершена", true);
    }
    if (
      period.start_date > sqlDateToday() &&
      (period.start_date !== nextMonday() || !canOpenNextWeek())
    ) {
      return answerCallback(
        env,
        callback.id,
        "Следующую неделю можно утвердить с четверга по воскресенье (МСК)",
        true,
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
        currentWeek
          ? "✅ <b>ГРАФИК ТЕКУЩЕЙ НЕДЕЛИ ОБНОВЛЁН</b>"
          : "✅ <b>ГРАФИК НА СЛЕДУЮЩУЮ НЕДЕЛЮ УТВЕРЖДЁН</b>",
        "",
        `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
        "",
        currentWeek
          ? "Откройте /schedule → «Текущая неделя», чтобы посмотреть обновлённый общий график."
          : "Ваше новое расписание готово. Откройте /schedule → «Следующая неделя», чтобы посмотреть общий график.",
      ].join("\n"), { kind: "schedule", createdByUserId: idOf(callback.from) });
      await deliverNotificationBatch(env, origin, notificationId);
    }
    await answerCallback(
      env,
      callback.id,
      (update.meta?.changes ?? 0) === 1 ? "График закрыт и утверждён" : "График уже был закрыт",
    );
    return showPeriod(env, chatId, messageId, Number(closeMatch[1]), true);
  }
  const reopenMatch = /^sched:reopen:(\d+)$/.exec(data);
  if (reopenMatch) {
    if (!isScheduleManager(env, callback.from)) {
      return answerCallback(env, callback.id, "Доступно менеджеру", true);
    }
    const periodId = Number(reopenMatch[1]);
    const period = await periodById(env, periodId);
    if (!period || period.end_date < sqlDateToday()) {
      return answerCallback(env, callback.id, "Этот период уже завершён", true);
    }
    if (
      period.start_date > sqlDateToday() &&
      (period.start_date !== nextMonday() || !canOpenNextWeek())
    ) {
      return answerCallback(
        env,
        callback.id,
        "Будущую неделю можно снова открыть с четверга по воскресенье (МСК)",
        true,
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
          "🔓 <b>ЗАПИСЬ НА СЛЕДУЮЩУЮ НЕДЕЛЮ СНОВА ОТКРЫТА</b>",
          "",
          `Период: <b>${formatScheduleDate(period.start_date, true)} — ${formatScheduleDate(period.end_date, true)}</b>`,
          "",
          "Можно снова указать или изменить время работы и выходные.",
        ].join("\n"), { kind: "schedule", createdByUserId: idOf(callback.from) });
        await deliverNotificationBatch(env, origin, notificationId);
        await answerCallback(env, callback.id, "Запись снова открыта, команда уведомлена");
      } else {
        await answerCallback(env, callback.id, "График открыт для редактирования");
      }
    } else {
      await answerCallback(env, callback.id, "Запись уже открыта");
    }
    return showPeriod(env, chatId, messageId, periodId, true);
  }
  if (data === "sched:home_manager") {
    if (!isScheduleManager(env, callback.from)) return answerCallback(env, callback.id, "Доступно менеджеру", true);
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
    if (
      !canUseNextWeekSignup(period) ||
      !dateBelongsToPeriod(period, startMatch[2])
    ) return answerCallback(env, callback.id, "Запись откроется только в четверг или период уже закрыт", true);
    await answerCallback(env, callback.id);
    return showEndPicker(env, chatId, messageId, Number(startMatch[1]), startMatch[2], Number(startMatch[3]));
  }
  const offMatch = /^sched:off:(\d+):(\d{4}-\d{2}-\d{2})$/.exec(data);
  if (offMatch) {
    const period = await periodById(env, Number(offMatch[1]));
    if (
      !canUseNextWeekSignup(period) ||
      !dateBelongsToPeriod(period, offMatch[2])
    ) return answerCallback(env, callback.id, "Запись откроется только в четверг или период уже закрыт", true);
    const saved = await saveEntry(
      env,
      Number(offMatch[1]),
      { ...callback.from, chat_id: chatId },
      offMatch[2],
      null,
      null,
      1,
    );
    if (!saved) return answerCallback(env, callback.id, "Запись уже закрыта", true);
    await answerCallback(env, callback.id, "Выходной сохранён");
    return showEmployeePeriod(env, chatId, messageId, Number(offMatch[1]));
  }
  if (data.startsWith("sched:end:")) {
    const selection = parseScheduleEndCallback(data);
    if (!selection) return answerCallback(env, callback.id, "Время указано неверно", true);
    const period = await periodById(env, selection.periodId);
    if (
      !canUseNextWeekSignup(period) ||
      !dateBelongsToPeriod(period, selection.date)
    ) {
      return answerCallback(env, callback.id, "Запись откроется только в четверг или период уже закрыт", true);
    }
    const saved = await saveEntry(
      env,
      selection.periodId,
      { ...callback.from, chat_id: chatId },
      selection.date,
      hourLabel(selection.startHour),
      selection.endHour === END_HOUR ? "00:00" : hourLabel(selection.endHour),
      0,
    );
    if (!saved) return answerCallback(env, callback.id, "Период уже закрыт", true);
    await answerCallback(env, callback.id, "Смена сохранена");
    return showEmployeePeriod(env, chatId, messageId, selection.periodId);
  }
  return answerCallback(env, callback.id, "Кнопка устарела", true);
}

export function scheduleCountKeyboard(count = 0) {
  return Number(count) > 0
    ? [{ text: `✍️ Запись на смены · ${count}`, callback_data: "sched:home" }]
    : null;
}

export async function openPeriodCount(env) {
  if (!canOpenNextWeek()) return 0;
  const result = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM schedule_periods WHERE status = 'open' AND start_date = ?",
  ).bind(nextMonday()).first();
  return Number(result?.count ?? 0);
}
