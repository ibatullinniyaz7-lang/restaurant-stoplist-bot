import test from "node:test";
import assert from "node:assert/strict";

import {
  catalogKeyboard,
  categoryKeyboard,
  changeNotification,
  commandName,
  escapeHtml,
  mainMenuKeyboard,
  paginate,
  startParameter,
  stopListText,
  telegramUserLink,
} from "../src/ui.js";
import { parseExpectedTime } from "../src/availability.js";
import { parseOrder } from "../src/orderParser.js";
import {
  addDays,
  canOpenNextWeek,
  isScheduleManager,
  managerKeyboard,
  nextMonday,
  nextScheduleOpeningDate,
  parseScheduleEndCallback,
  scheduleHubKeyboard,
  scheduleChangeNotificationText,
  scheduleEntryLine,
  scheduleOpeningMarkerKey,
  schedulePeriodAction,
  shouldRunScheduleAutomation,
} from "../src/schedule.js";
import { ownerHomeKeyboard } from "../src/owner.js";
import { ownerOnlyRecipients } from "../src/settings.js";

test("escapeHtml защищает Telegram HTML", () => {
  assert.equal(escapeHtml('<Утка & сыр "VIP">'), "&lt;Утка &amp; сыр &quot;VIP&quot;&gt;");
});

test("команды понимают суффикс имени бота", () => {
  assert.equal(commandName("/STOP@sample_restaurant_bot"), "/stop");
  assert.equal(startParameter("/start team-2026"), "team-2026");
});

test("paginate ограничивает неверный номер страницы", () => {
  assert.deepEqual(paginate([1, 2, 3], 99, 2), { items: [3], page: 1, pages: 2 });
  assert.deepEqual(paginate([], -5, 8), { items: [], page: 0, pages: 1 });
});

test("кнопка блюда открывает выбор из четырёх статусов", () => {
  const keyboard = categoryKeyboard(6, [
    { id: 40, name: "Шашлык", availability_status: "available" },
    { id: 41, name: "Конина", availability_status: "limited", limited_quantity: 3 },
  ]);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "dish:40:6:0");
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, "dish:41:6:0");
  assert.match(keyboard.inline_keyboard[1][0].text, /осталось 3/);
});

test("главное меню разделяет кухню и карту бара", () => {
  const keyboard = mainMenuKeyboard({ kitchen: 2, bar: 1 });
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "catalog:kitchen:0");
  assert.match(keyboard.inline_keyboard[0][0].text, /📋 2/);
  assert.equal(keyboard.inline_keyboard[0][1].callback_data, "catalog:bar:0");
});

test("главное меню открывает единый раздел смен", () => {
  const keyboard = mainMenuKeyboard({}, false, 1, false, 1);
  const callbacks = keyboard.inline_keyboard.flat().map((button) => button.callback_data);
  assert.equal(callbacks.includes("sched:hub"), true);
  assert.equal(callbacks.includes("sched:home"), false);
  assert.equal(callbacks.includes("sched:published"), false);
  assert.match(
    keyboard.inline_keyboard.flat().find((button) => button.callback_data === "sched:hub").text,
    /Смены/,
  );
});

test("раздел смен содержит две отдельные вкладки", () => {
  const keyboard = scheduleHubKeyboard(
    { status: "open" },
    { status: "closed" },
  );
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, "sched:current");
  assert.match(keyboard.inline_keyboard[0][0].text, /Текущая неделя/);
  assert.match(keyboard.inline_keyboard[0][0].text, /обновляется/);
  assert.equal(keyboard.inline_keyboard[1][0].callback_data, "sched:next");
  assert.match(keyboard.inline_keyboard[1][0].text, /Следующая неделя/);
  assert.match(keyboard.inline_keyboard[1][0].text, /утверждена/);
});

test("кнопка кабинета показывается только владельцу", () => {
  const staffKeyboard = mainMenuKeyboard({}, false);
  const ownerKeyboard = mainMenuKeyboard({}, true);
  assert.equal(
    staffKeyboard.inline_keyboard.some((row) => row[0].callback_data === "owner:home"),
    false,
  );
  assert.equal(
    ownerKeyboard.inline_keyboard.some((row) => row[0].callback_data === "owner:home"),
    true,
  );
});

test("кабинет владельца показывает правильную кнопку режима проверки", () => {
  assert.equal(
    ownerHomeKeyboard(true).inline_keyboard[0][0].text,
    "⏸ Отключить для сотрудников",
  );
  assert.equal(
    ownerHomeKeyboard(false).inline_keyboard[0][0].text,
    "▶️ Включить для всех",
  );
});

test("в режиме проверки уведомление адресуется только владельцу", () => {
  const env = { OWNER_USER_ID: "111111111" };
  assert.deepEqual(ownerOnlyRecipients(env), [{ chat_id: 111111111 }]);
  assert.deepEqual(ownerOnlyRecipients(env, 111111111), []);
});

test("имя сотрудника превращается в ссылку Telegram", () => {
  assert.equal(
    telegramUserLink({ id: 123, username: "waiter_test", first_name: "Алия" }),
    '<a href="https://t.me/waiter_test">Алия</a>',
  );
  assert.equal(
    telegramUserLink({ id: 123, first_name: "Алия" }),
    '<a href="tg://user?id=123">Алия</a>',
  );
});

test("длинная карта бара разбивается на страницы", () => {
  const categories = Array.from({ length: 10 }, (_, id) => ({ id: id + 101, name: `Раздел ${id}` }));
  const keyboard = catalogKeyboard(categories, "bar", 0);
  assert.equal(keyboard.inline_keyboard[8][1].callback_data, "catalog:bar:1");
});

test("пустой и заполненный список статусов форматируются", () => {
  assert.match(stopListText([]), /Ограничений нет/);
  const text = stopListText([
    { menu_type: "kitchen", category_name: "Блюда <гриль>", name: "Шашлык & соус", availability_status: "stopped" },
    { menu_type: "bar", category_name: "Лимонады", name: "Малина-ревень", availability_status: "limited", limited_quantity: 4 },
  ]);
  assert.match(text, /Блюда &lt;гриль&gt;/);
  assert.match(text, /Шашлык &amp; соус/);
  assert.match(text, /Карта бара/);
  assert.match(text, /осталось 4/);
});

test("уведомление содержит статус, блюдо и сотрудника", () => {
  const text = changeNotification(
    { name: "Казылык", category_name: "Закуски", menu_type: "kitchen" },
    true,
    { id: 123, username: "waiter_test", first_name: "Алия" },
    new Date("2026-08-16T09:30:00Z"),
  );
  assert.match(text, /ПОСТАВЛЕНА НА СТОП/);
  assert.match(text, /Казылык/);
  assert.match(text, /Алия/);
  assert.match(text, /https:\/\/t\.me\/waiter_test/);
  assert.match(text, /12:30/);
});

test("уведомление об ограничении показывает количество", () => {
  const text = changeNotification(
    { name: "Морс клюквенный", category_name: "Прохладительные напитки", menu_type: "bar" },
    "limited",
    { id: 123, first_name: "Алия" },
    { quantity: 4 },
    new Date("2026-08-16T09:30:00Z"),
  );
  assert.match(text, /ОГРАНИЧЕНИИ/);
  assert.match(text, /4 шт/);
});

test("точное время ожидания понимается по Москве", () => {
  const now = new Date("2026-08-18T12:00:00Z");
  assert.equal(parseExpectedTime("18:30", now), "2026-08-18 15:30:00");
  assert.equal(parseExpectedTime("19.08 09:15", now), "2026-08-19 06:15:00");
  assert.equal(parseExpectedTime("99:99", now), null);
});

test("личный разбор заказа владельца понимает сокращения и раскладывает по разделам", () => {
  const dishes = [
    { name: "Бишбармак", category_name: "Блюда из мяса" },
    { name: "Очпочмак с говядиной", category_name: "Выпечка" },
    { name: "Итле", category_name: "Салаты" },
    { name: "Морс смородиновый", category_name: "Прохладительные напитки" },
  ];
  const result = parseOrder("2 Беш\\оч с говядиной\\Итле\\Морс смородина", dishes);
  assert.equal(result.unknown.length, 0);
  assert.equal(result.groups.get("Блюда из мяса")[0].quantity, 2);
  assert.equal(result.groups.get("Выпечка")[0].dish.name, "Очпочмак с говядиной");
  assert.equal(result.groups.get("Салаты")[0].dish.name, "Итле");
  assert.equal(result.groups.get("Прохладительные напитки")[0].dish.name, "Морс смородиновый");
});

test("график считает даты недели с понедельника", () => {
  assert.equal(addDays("2026-08-24", 6), "2026-08-30");
  assert.equal(nextMonday(1, new Date("2026-08-26T10:00:00Z")), "2026-08-31");
});

test("следующую неделю можно открыть только с четверга по воскресенье по Москве", () => {
  assert.equal(canOpenNextWeek(new Date("2026-08-26T20:59:00Z")), false);
  assert.equal(canOpenNextWeek(new Date("2026-08-26T21:00:00Z")), true);
  assert.equal(canOpenNextWeek(new Date("2026-08-30T20:59:00Z")), true);
  assert.equal(canOpenNextWeek(new Date("2026-08-30T21:00:00Z")), false);
  assert.equal(nextScheduleOpeningDate(new Date("2026-08-31T09:00:00Z")), "2026-09-03");
  assert.equal(shouldRunScheduleAutomation(new Date("2026-09-02T20:59:00Z")), false);
  assert.equal(shouldRunScheduleAutomation(new Date("2026-09-02T21:00:00Z")), true);
  assert.equal(shouldRunScheduleAutomation(new Date("2026-09-03T21:01:00Z")), false);
  assert.equal(scheduleOpeningMarkerKey("2026-09-07"), "schedule_open_notified_2026-09-07");
  assert.equal(
    scheduleOpeningMarkerKey("2026-09-07", true),
    "schedule_open_test_notified_2026-09-07",
  );
});

test("управление сменами больше не предлагает открыть две недели", () => {
  const callbacks = managerKeyboard([], true, "2026-08-31").inline_keyboard.flat().map((button) => button.callback_data);
  assert.equal(callbacks.includes("sched:open:1"), true);
  assert.equal(callbacks.includes("sched:open:2"), false);
  assert.equal(managerKeyboard([], false, "2026-08-31").inline_keyboard[0][0].callback_data, "sched:open_locked");
  const existing = managerKeyboard([
    { id: 7, start_date: "2026-08-31", end_date: "2026-09-06", status: "open" },
  ], true, "2026-08-31");
  assert.equal(
    existing.inline_keyboard.flat().some((button) => button.callback_data === "sched:open:1"),
    false,
  );
});

test("кнопка окончания смены правильно сохраняет начало и конец", () => {
  assert.deepEqual(
    parseScheduleEndCallback("sched:end:7:2026-08-31:21:22"),
    { periodId: 7, date: "2026-08-31", startHour: 21, endHour: 22 },
  );
  assert.deepEqual(
    parseScheduleEndCallback("sched:end:7:2026-08-31:22:24"),
    { periodId: 7, date: "2026-08-31", startHour: 22, endHour: 24 },
  );
  assert.equal(parseScheduleEndCallback("sched:end:7:2026-08-31:22:10"), null);
});

test("имя сотрудника в графике кликабельно, а NaN не показывается", () => {
  const line = scheduleEntryLine({
    user_id: 123,
    username: "waiter_test",
    display_name: "Алия",
    start_time: "22:00",
    end_time: "NaN:00",
    is_day_off: 0,
  });
  assert.match(line, /https:\/\/t\.me\/waiter_test/);
  assert.match(line, /время нужно указать заново/);
  assert.doesNotMatch(line, /NaN/);
});

test("личное уведомление показывает сотрудника, изменение и автора", () => {
  const text = scheduleChangeNotificationText(
    { user_id: 123, username: "waiter_test", display_name: "Алия" },
    { id: 456, username: "manager_test", first_name: "Менеджер" },
    { start_date: "2026-08-31", end_date: "2026-09-06" },
    "2026-09-01",
    null,
    { start_time: "10:00", end_time: "22:00", is_day_off: 0 },
  );
  assert.match(text, /https:\/\/t\.me\/waiter_test/);
  assert.match(text, /https:\/\/t\.me\/manager_test/);
  assert.match(text, /записи не было/);
  assert.match(text, /10:00–22:00/);
});

test("неделю можно закрыть и снова открыть до её окончания", () => {
  assert.equal(
    schedulePeriodAction(
      { id: 7, status: "open", start_date: "2026-08-31", end_date: "2026-09-06" },
      "2026-08-29",
      true,
      "2026-08-31",
    ).callback_data,
    "sched:confirm_close:7",
  );
  assert.equal(
    schedulePeriodAction(
      { id: 7, status: "closed", start_date: "2026-08-31", end_date: "2026-09-06" },
      "2026-08-29",
      true,
      "2026-08-31",
    ).callback_data,
    "sched:reopen:7",
  );
  assert.equal(
    schedulePeriodAction(
      { id: 7, status: "closed", start_date: "2026-08-24", end_date: "2026-08-28" },
      "2026-08-29",
      true,
      "2026-08-31",
    ),
    null,
  );
  assert.equal(
    schedulePeriodAction(
      { id: 7, status: "closed", start_date: "2026-09-07", end_date: "2026-09-13" },
      "2026-09-01",
      false,
      "2026-09-07",
    ),
    null,
  );
  assert.equal(
    schedulePeriodAction(
      { id: 7, status: "open", start_date: "2026-08-17", end_date: "2026-08-23" },
      "2026-08-29",
      true,
      "2026-08-31",
    ),
    null,
  );
  assert.equal(
    schedulePeriodAction(
      { id: 7, status: "open", start_date: "2026-09-07", end_date: "2026-09-13" },
      "2026-09-01",
      false,
      "2026-09-07",
    ),
    null,
  );
  assert.equal(
    schedulePeriodAction(
      { id: 7, status: "open", start_date: "2026-08-31", end_date: "2026-09-06" },
      "2026-09-01",
      false,
      "2026-09-07",
    ).callback_data,
    "sched:confirm_close:7",
  );
});

test("права главного менеджера привязаны к точному Telegram ID", () => {
  const env = { OWNER_USER_ID: "111111111", MANAGER_USER_ID: "222222222" };
  assert.equal(isScheduleManager(env, { id: 222222222 }), true);
  assert.equal(isScheduleManager(env, { id: 222222223 }), false);
  assert.equal(
    isScheduleManager(env, { id: 222222223, username: "manager_example" }),
    false,
  );
});
